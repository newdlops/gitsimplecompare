// 네이티브 blame popup의 지연 조회·취소·복사/탐색을 Extension Host에서 처리한다.
// - renderer는 Git 경로나 명령을 지정하지 않고 현재 gutter snapshot의 라인/커밋만 요청한다.
import * as vscode from "vscode";
import path from "node:path";
import { readBlameCommitInfo, readBlameCommitRemoteUrl, type BlameCommitInfo } from "../git/blameHoverService";
import { SharedGitRead } from "../git/sharedGitRead";
import { makeRefUri } from "../utils/uri";
import { logError, logInfo } from "./outputLog";
import type { BlockBlameGutterSnapshot } from "./blockBlameGutter";
import { parseBlameHoverRequest, type BlameHoverActionHandler, type BlameHoverRequest, type BlameHoverResponse } from "../providers/blameHoverProtocol";

interface CommitRead { read: SharedGitRead<BlameCommitInfo>; bytes: number; }
const MAX_COMMIT_READS = 32;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

/** popup 하나의 수명과 immutable commit cache를 분리해 인접 라인 hover도 조회를 공유한다. */
export class BlockBlameHoverPresenter implements vscode.Disposable, BlameHoverActionHandler {
  private readonly emitter = new vscode.EventEmitter<BlameHoverResponse>();
  readonly onDidChangeHover = this.emitter.event;
  private readonly commits = new Map<string, CommitRead>();
  private readonly remotes = new Map<string, SharedGitRead<string | undefined>>();
  private current?: { request: BlameHoverRequest; controller: AbortController };
  private indexedSnapshot?: BlockBlameGutterSnapshot;
  private lineCommits = new Map<number, string | undefined>();
  private disposed = false;

  /**
   * @param snapshot 현재 gutter만 반환하는 경계, readCommit/readRemote 테스트에서도 재사용할 Git 조회 함수
   */
  constructor(
    private readonly snapshot: () => BlockBlameGutterSnapshot | undefined,
    private readonly readCommit = readBlameCommitInfo,
    private readonly readRemote = readBlameCommitRemoteUrl
  ) {}

  /** 문서/snapshot 교체·blur에서 필요 없는 hover 소비자를 취소한다. 커밋 캐시는 같은 SHA에만 재사용한다. */
  register(onDidChangeGutter: vscode.Event<BlockBlameGutterSnapshot | undefined>): vscode.Disposable {
    return vscode.Disposable.from(
      onDidChangeGutter(() => {
        this.cancel(); this.indexedSnapshot = undefined; this.lineCommits.clear();
        for (const read of this.remotes.values()) read.invalidate();
      }),
      vscode.window.onDidChangeWindowState(state => { if (!state.focused) this.cancel(); }),
      new vscode.Disposable(() => this.dispose())
    );
  }

  /**
   * renderer 요청을 현재 snapshot과 대조한 후 허용된 동작만 실행한다.
   * @param value CDP binding에서 받은 알 수 없는 payload
   */
  handleRendererAction(value: unknown): void {
    const request = parseBlameHoverRequest(value);
    if (!request || this.disposed) return;
    if (request.action === "dismiss") {
      if (this.matchesCurrent(request)) this.cancel();
      return;
    }
    const snapshot = this.validSnapshot(request);
    if (!snapshot || !vscode.window.state.focused) {
      logInfo("blame hover request skipped", { reason: "stale-snapshot", action: request.action });
      return;
    }
    if (request.action === "load" || request.action === "retry") {
      if (/^0+$/.test(request.commit)) return;
      const previous = this.current;
      const controller = new AbortController();
      this.current = { request, controller };
      void this.load(request, snapshot.repoRoot!, controller);
      // 새 소비자가 먼저 공유 read에 참여하게 해 같은 커밋의 인접 라인으로 이동할 때 Git을 다시 시작하지 않는다.
      previous?.controller.abort();
      return;
    }
    void this.performAction(request, snapshot).catch(error => {
      logError("blame hover action failed", error, { action: request.action, commit: request.commit });
      if (this.matchesCurrent(request)) this.emit(request, "error", undefined, vscode.l10n.t("Could not complete the commit action."));
    });
  }

  /** host 종료에서 진행 소비자와 모든 bounded cache를 해제하고 늦은 결과를 막는다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel();
    for (const entry of this.commits.values()) void entry.read.dispose();
    for (const entry of this.remotes.values()) void entry.dispose();
    this.commits.clear(); this.remotes.clear(); this.lineCommits.clear(); this.emitter.dispose();
  }

  /**
   * full commit과 로컬 remote URL을 병렬로 준비하고 아직 같은 popup일 때만 renderer에 전달한다.
   * @param request 원래 popup 식별자, repoRoot snapshot이 소유한 저장소, controller 이 소비자의 취소 신호
   */
  private async load(request: BlameHoverRequest, repoRoot: string, controller: AbortController): Promise<void> {
    const start = Date.now();
    try {
      const [info, remoteUrl] = await Promise.all([
        this.commit(repoRoot, request.commit, controller.signal, request.action === "retry"),
        this.remote(repoRoot, request.commit, controller.signal),
      ]);
      if (controller.signal.aborted || !this.matchesCurrent(request) || !this.validSnapshot(request)) return;
      const { files: _files, parents: _parents, ...details } = info;
      this.emit(request, "ready", { ...details, remoteUrl });
      logInfo("blame hover loaded", { repoRoot, commit: request.commit, files: info.stats.files, durationMs: Date.now() - start });
    } catch (error) {
      if (controller.signal.aborted || !this.matchesCurrent(request)) return;
      logError("blame hover detail failed", error, { repoRoot, commit: request.commit });
      this.emit(request, "error", undefined, vscode.l10n.t("Could not load commit details."));
    }
  }

  /** SHA가 immutable인 완료 조회를 공유하고, 오류/취소/과도한 크기는 완료 캐시로 오래 보관하지 않는다. */
  private async commit(root: string, hash: string, signal?: AbortSignal, force = false): Promise<BlameCommitInfo> {
    const key = `${root}\0${hash}`;
    let entry = this.commits.get(key);
    if (!entry) {
      const owned: CommitRead = { read: undefined!, bytes: 0 };
      owned.read = new SharedGitRead(async ownedSignal => {
        const info = await this.readCommit(root, hash, ownedSignal);
        owned.bytes = Buffer.byteLength(JSON.stringify(info));
        return info;
      }, info => info);
      entry = owned; this.commits.set(key, entry);
    } else { this.commits.delete(key); this.commits.set(key, entry); }
    const info = await entry.read.read({ signal, force, maxCacheAgeMs: Number.POSITIVE_INFINITY });
    this.trimCache();
    return info;
  }

  /** 동일 snapshot의 remote 탐색을 재사용하되 SHA는 매번 해당 커밋으로 치환한다. 설정 변경은 register에서 무효화한다. */
  private async remote(root: string, hash: string, signal: AbortSignal): Promise<string | undefined> {
    let read = this.remotes.get(root);
    if (!read) {
      // URL의 끝은 고정 길이 SHA이므로 provider/저장소 탐색 결과만 공유한다.
      read = new SharedGitRead(ownedSignal => this.readRemote(root, hash, ownedSignal), value => value);
      this.remotes.set(root, read);
    }
    const url = await read.read({ signal, maxCacheAgeMs: 60_000 });
    return url?.replace(/(?:[0-9a-f]{40}|[0-9a-f]{64})$/, hash);
  }

  /** 진행 중인 다른 액션/hover 소비자를 보호하면서 개수와 byte 상한 밖의 완료 cache를 해제한다. */
  private trimCache(): void {
    let bytes = [...this.commits.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.commits) {
      if (this.commits.size <= MAX_COMMIT_READS && bytes <= MAX_CACHE_BYTES) break;
      if (entry.read.hasConsumers()) continue;
      this.commits.delete(key); bytes -= entry.bytes; void entry.read.dispose();
    }
    for (const [root, read] of this.remotes) if (this.remotes.size > 8 && !read.hasConsumers()) {
      this.remotes.delete(root); void read.dispose();
    }
  }

  /** 복사/설정/원격/실제 commit diff를 기본 Git의 활성화 없이 처리한다. */
  private async performAction(request: BlameHoverRequest, snapshot: BlockBlameGutterSnapshot): Promise<void> {
    if (request.action === "settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "gitSimpleCompare.blame"); return;
    }
    if (/^0+$/.test(request.commit)) return;
    if (request.action === "copyHash") {
      await vscode.env.clipboard.writeText(request.commit);
      if (this.matchesCurrent(request)) this.emit(request, "copied", undefined, vscode.l10n.t("Commit hash copied"));
      return;
    }
    if (request.action === "openRemote") {
      const url = await this.remote(snapshot.repoRoot!, request.commit, new AbortController().signal);
      if (url && this.validSnapshot(request)) await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (request.action === "openCommit") {
      const info = await this.commit(snapshot.repoRoot!, request.commit);
      if (!this.validSnapshot(request)) return;
      if (!info.files.length) {
        void vscode.window.showInformationMessage(vscode.l10n.t("This commit has no file changes.")); return;
      }
      const changes = info.files.map(file => [
        vscode.Uri.file(path.join(snapshot.repoRoot!, file.path)),
        file.status !== "A" && info.parents[0] ? makeRefUri(info.parents[0], file.oldPath ?? file.path, snapshot.repoRoot!) : undefined,
        file.status !== "D" ? makeRefUri(info.hash, file.path, snapshot.repoRoot!) : undefined,
      ]);
      await vscode.commands.executeCommand("vscode.changes", vscode.l10n.t("Commit {0}", info.hash.slice(0, 8)), changes);
    }
  }

  /** URI/version/line/SHA가 실제 보이는 snapshot에 속하는지 한 번 만든 라인 index로 확인한다. */
  private validSnapshot(request: BlameHoverRequest): BlockBlameGutterSnapshot | undefined {
    const snapshot = this.snapshot();
    if (!snapshot?.repoRoot || snapshot.uri !== request.uri || snapshot.revision !== request.revision) return undefined;
    if (this.indexedSnapshot !== snapshot) {
      this.indexedSnapshot = snapshot;
      this.lineCommits = new Map(snapshot.lines.map(line => [line.line, line.commit]));
    }
    return this.lineCommits.get(request.line) === request.commit ? snapshot : undefined;
  }

  /** 같은 popup의 비동기 결과만 허용하며 다른 라인·문서·재시도의 요청을 구별한다. */
  private matchesCurrent(request: BlameHoverRequest): boolean {
    const current = this.current?.request;
    return !!current && current.requestId === request.requestId && current.uri === request.uri
      && current.revision === request.revision && current.line === request.line && current.commit === request.commit;
  }

  /** 활성 popup 소비자만 중단한다. 실행 중인 commit 보기 액션은 별도 공유 소비자로 계속 동작한다. */
  private cancel(): void { this.current?.controller.abort(); this.current = undefined; }

  /** 원래 식별자를 붙여 renderer가 늦은 상세·오류·복사 결과를 다른 popup에 적용하지 못하게 한다. */
  private emit(request: BlameHoverRequest, status: BlameHoverResponse["status"], details?: BlameHoverResponse["details"], message?: string): void {
    this.emitter.fire({ uri: request.uri, revision: request.revision, line: request.line, commit: request.commit,
      requestId: request.requestId, status, details, message });
  }
}
