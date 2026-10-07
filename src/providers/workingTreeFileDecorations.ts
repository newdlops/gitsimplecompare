// 내장 Git이 꺼진 범위의 작업트리 상태를 Explorer·탭·resourceUri 트리에 투영한다.
// - Git 실행은 기존 공개 공유 상태 API에 맡기고, 이 모듈은 표시·이벤트 수명만 관리한다.
import * as path from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { GitSimpleCompareApi } from "../extensionApi";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { parsePorcelainEntries, type PorcelainEntry } from "../git/diffParse";
import { invalidateWorkingTreeSnapshot } from "../git/workingTreeSnapshot";
import { logInfo, logWarn } from "../ui/outputLog";
import { uriBelongsToRoot } from "./localChangesWatcher";

/** 표시 소비자가 유지할 저장소별 공유 조회·장식 캐시다. */
interface DecorationRepository {
  root: string;
  controller: AbortController;
  decorations: Map<string, vscode.FileDecoration>;
  porcelain?: string;
  pending?: Promise<void>;
  dirty: boolean;
  revision: number;
}

/** 기존 비교 계약을 바꾸지 않고 선택적 작업 상태 공급자만 재사용한다. */
type StatusProvider = NonNullable<GitSimpleCompareApi["workingTreeStatus"]>;
const REFRESH_DELAY_MS = 180;
const REFRESH_MAX_WAIT_MS = 600;

/**
 * 내장 Git이 제공하지 않는 작업트리 파일 장식을 공유 snapshot으로 복구한다.
 * - Changes 뷰 가시성과 독립적이며 내장 Git 확장을 활성화하거나 Git을 따로 실행하지 않는다.
 * - 파일 이벤트는 debounce하고 창 비활성 중에는 광범위 감시와 갱신을 멈춘다.
 */
export class WorkingTreeFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly repositories = new Map<string, DecorationRepository>();
  private readonly directoryRoots = new Map<string, Promise<string | undefined>>();
  private readonly resourceRoots = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private burstStartedAt?: number;
  private epoch = 0;
  private disposed = false;

  /**
   * 설정·공유 상태·파일 이벤트를 연결하고 비활성 Git workspace의 최초 상태를 준비한다.
   * @param registry 저장소 탐색을 기존 확장 소비자와 공유할 레지스트리
   * @param status Changes·Graph·Tab Manager와 같은 authoritative snapshot 공급자
   */
  constructor(private readonly registry: Pick<GitServiceRegistry, "resolve">, private readonly status: StatusProvider) {
    this.subscriptions.push(
      status.onDidChange(root => this.queueRepository(root)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (["git.enabled", "git.decorations.enabled", "git.path", "gitSimpleCompare.gitPath"]
          .some(key => event.affectsConfiguration(key))) this.reconfigure("configuration");
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reconfigure("workspaceFolders")),
      vscode.workspace.onDidSaveTextDocument(document => this.fileChanged(document.uri)),
      vscode.workspace.onDidCreateFiles(event => this.filesChanged(event.files)),
      vscode.workspace.onDidDeleteFiles(event => this.filesChanged(event.files)),
      vscode.workspace.onDidRenameFiles(event => this.filesChanged(event.files.flatMap(file => [file.oldUri, file.newUri]))),
      vscode.window.onDidChangeWindowState(state => this.focusChanged(state.focused)),
    );
    this.reconfigure("activation");
  }

  /**
   * 파일 URI의 저장소를 찾아 현재 작업 상태 장식을 반환한다.
   * - 디렉터리별 탐색과 저장소별 진행 중 조회를 합쳐 한 화면의 여러 파일이 중복 status를 만들지 않는다.
   * @param uri 기본 Explorer·Tab Manager·탭이 질의한 resource URI
   * @param token 해당 URI 질의의 취소 신호
   * @returns 수정/추가/삭제/rename/충돌이면 장식, 정상·비-file·내장 Git 사용 범위면 undefined
   */
  async provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.FileDecoration | undefined> {
    if (this.disposed || token.isCancellationRequested || !usesFallback(uri)) return undefined;
    const epoch = this.epoch;
    const key = uri.toString();
    let root = this.resourceRoots.get(key);
    if (!root) {
      const directory = await stat(uri.fsPath).then(info => info.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath), () => path.dirname(uri.fsPath));
      root = await this.resolveDirectory(directory);
      if (this.disposed || epoch !== this.epoch || token.isCancellationRequested || !root) return undefined;
      if (this.resourceRoots.size >= 4096) this.resourceRoots.delete(this.resourceRoots.keys().next().value!);
      this.resourceRoots.set(key, root);
    }
    const repository = this.repository(root);
    if (repository.porcelain === undefined) await this.refreshRepository(repository);
    if (this.disposed || epoch !== this.epoch || token.isCancellationRequested || !usesFallback(uri)) return undefined;
    return repository.decorations.get(key);
  }

  /**
   * 설정/폴더 전환 때 늦은 이전 결과를 취소하고 장식·탐색 범위를 다시 준비한다.
   * @param reason OUTPUT에 남길 전환 원인
   * @returns 반환값 없이 최초 workspace 조회를 비동기로 예약한다.
   */
  private reconfigure(reason: string): void {
    if (this.disposed) return;
    this.epoch++;
    this.clearTimer();
    for (const repository of this.repositories.values()) repository.controller.abort();
    this.repositories.clear();
    this.directoryRoots.clear();
    this.resourceRoots.clear();
    this.rebuildWatchers();
    // 해제된 공급자가 이전 배지를 남기지 않도록 알려 새 URI 질의가 현재 설정을 확인하게 한다.
    this.changed.fire(undefined);
    logInfo("working tree file decorations configured", { reason, scopes: this.fallbackFolders().length });
    void this.discoverWorkspace(this.epoch);
  }

  /** 내장 Git 비활성·장식 활성 설정을 상속하는 file workspace 폴더만 반환한다. */
  private fallbackFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => usesFallback(folder.uri));
  }

  /**
   * workspace 폴더가 repo 내부이거나 linked worktree여도 실제 root 한 개당 최초 snapshot만 읽는다.
   * @param epoch 설정 전환 전 탐색 결과의 적용을 거부할 생명주기 번호
   * @returns 해당 전환의 최초 폴더 탐색이 모두 완료되면 끝나는 Promise
   */
  private async discoverWorkspace(epoch: number): Promise<void> {
    await Promise.all(this.fallbackFolders().map(async folder => {
      try {
        const root = await this.resolveDirectory(folder.uri.fsPath);
        if (this.disposed || epoch !== this.epoch || !root) return;
        await this.refreshRepository(this.repository(root));
      } catch (error) {
        if (!this.disposed && epoch === this.epoch) logWarn("working tree decoration repository discovery failed", { folder: folder.uri.fsPath, error: String(error) });
      }
    }));
  }

  /**
   * 디렉터리별 저장소 탐색 Promise를 공유해 파일 수만큼 rev-parse를 실행하지 않게 한다.
   * @param directory file URI의 부모 또는 workspace 디렉터리
   * @returns 실제 저장소 루트. Git 폴더가 아니면 undefined
   */
  private resolveDirectory(directory: string): Promise<string | undefined> {
    const key = path.resolve(directory);
    let pending = this.directoryRoots.get(key);
    if (!pending) {
      pending = this.registry.resolve(key).then(service => service?.repoRoot);
      this.directoryRoots.set(key, pending);
    }
    return pending;
  }

  /** root별 표시 수명을 만들거나 기존 상태를 반환해 다중 workspace가 같은 조회에 합류하게 한다. */
  private repository(repoRoot: string): DecorationRepository {
    const root = path.resolve(repoRoot);
    let repository = this.repositories.get(root);
    if (!repository) {
      repository = { root, controller: new AbortController(), decorations: new Map(), dirty: true, revision: 0 };
      this.repositories.set(root, repository);
    }
    return repository;
  }

  /**
   * 공개 공유 상태 무효화 알림을 한 번의 bounded trailing refresh로 합친다.
   * @param repoRoot index/HEAD/파일 변경 또는 확장 자체 쓰기가 바꾼 저장소
   * @returns 해당 저장소를 아직 표시하지 않으면 아무 조회도 예약하지 않는다.
   */
  private queueRepository(repoRoot: string): void {
    const repository = this.repositories.get(path.resolve(repoRoot));
    if (this.disposed || !repository) return;
    repository.dirty = true;
    repository.revision++;
    if (!vscode.window.state.focused) return;
    const now = Date.now();
    this.burstStartedAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.clearTimer();
      if (this.disposed || !vscode.window.state.focused) return;
      for (const state of this.repositories.values()) if (state.dirty) void this.refreshRepository(state);
    }, Math.min(REFRESH_DELAY_MS, Math.max(0, REFRESH_MAX_WAIT_MS - (now - this.burstStartedAt))));
  }

  /**
   * 이미 진행 중인 공유 status를 기다리고 설정·파일 세대가 현재인 결과만 장식에 적용한다.
   * - 오류 때 직전 표시를 유지하며, 취소는 정상 생명주기 종료로 취급한다.
   * @param repository 조회와 결과 캐시를 유지하는 저장소 상태
   * @returns 새 상태 적용 또는 실패 기록이 완료되면 끝나는 공유 Promise
   */
  private refreshRepository(repository: DecorationRepository): Promise<void> {
    if (repository.pending) return repository.pending;
    repository.pending = Promise.resolve().then(async () => {
      while (!this.disposed && !repository.controller.signal.aborted) {
        const revision = repository.revision;
        repository.dirty = false;
        const startedAt = Date.now();
        const snapshot = await this.status.getStatus(repository.root, { signal: repository.controller.signal });
        if (this.disposed || this.repositories.get(repository.root) !== repository || repository.controller.signal.aborted) return;
        if (revision !== repository.revision) continue;
        if (snapshot.porcelain !== repository.porcelain) {
          const next = workingTreeFileDecorations(repository.root, snapshot.porcelain);
          const affected = affectedUris(repository.root, [...repository.decorations.keys(), ...next.keys()]);
          repository.decorations = next;
          repository.porcelain = snapshot.porcelain;
          if (affected.length) this.changed.fire(affected);
          logInfo("working tree file decorations refreshed", { root: repository.root, files: next.size, affected: affected.length, durationMs: Date.now() - startedAt });
        }
        return;
      }
    }).catch(error => {
      if (!this.disposed && !repository.controller.signal.aborted) logWarn("working tree file decoration refresh failed", { root: repository.root, error: String(error) });
    }).finally(() => { repository.pending = undefined; });
    return repository.pending;
  }

  /**
   * 생성·삭제·rename가 repository 경계를 바꿀 수 있어 경로 탐색을 비우고 관련 상태를 무효화한다.
   * @param uris VS Code 명시적 파일 작업의 이전/새 URI 목록
   * @returns 반환값 없이 fileChanged의 공유 갱신 경로를 사용한다.
   */
  private filesChanged(uris: readonly vscode.Uri[]): void {
    this.directoryRoots.clear();
    this.resourceRoots.clear();
    for (const uri of uris) this.fileChanged(uri);
  }

  /**
   * 에디터 저장과 외부 파일 변경을 기존 authoritative 공유 세대에 연결한다.
   * - .git 내부는 공개 API의 좁은 metadata watcher가 담당해 lock/cache 이벤트 폭주를 피한다.
   * @param uri 변경 파일 URI
   * @returns 저장소 밖·비-file 이벤트는 건너뛴다.
   */
  private fileChanged(uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== "file" || /(?:^|\/)\.git\//.test(uri.path)) return;
    for (const repository of this.repositories.values()) {
      if (uriBelongsToRoot(uri, repository.root)) invalidateWorkingTreeSnapshot(repository.root);
    }
  }

  /** 내장 Git이 꺼진 workspace에서만 VS Code의 공유 파일 감시를 구독하며 idle polling은 만들지 않는다. */
  private rebuildWatchers(): void {
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
    if (!vscode.window.state.focused) return;
    for (const folder of this.fallbackFolders()) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
      this.watchers.push(watcher,
        watcher.onDidChange(uri => this.fileChanged(uri)),
        watcher.onDidCreate(uri => this.filesChanged([uri])),
        watcher.onDidDelete(uri => this.filesChanged([uri])),
      );
    }
  }

  /**
   * 비활성 창에서 감시를 중단하고 복귀 때 누락된 외부 변경을 한 번 재조정한다.
   * @param focused VS Code가 알려 준 현재 창 포커스 상태
   * @returns 반환값 없이 watcher·timer·공유 snapshot 수명을 조정한다.
   */
  private focusChanged(focused: boolean): void {
    if (this.disposed) return;
    this.clearTimer();
    this.rebuildWatchers();
    logInfo(`working tree decoration watcher ${focused ? "resumed" : "suspended"}`, { repositories: this.repositories.size });
    if (!focused) return;
    for (const repository of this.repositories.values()) invalidateWorkingTreeSnapshot(repository.root);
    void this.discoverWorkspace(this.epoch);
  }

  /** 예약 timer와 burst 시작 시각을 함께 해제해 다음 이벤트 묶음의 최대 대기가 독립적이게 한다. */
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.burstStartedAt = undefined;
  }

  /** 구독·watcher·진행 중 표시 소비자를 해제하며 다른 공유 status 소비자의 조회는 유지한다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.clearTimer();
    for (const repository of this.repositories.values()) repository.controller.abort();
    for (const subscription of [...this.subscriptions, ...this.watchers]) subscription.dispose();
    this.repositories.clear();
    this.directoryRoots.clear();
    this.resourceRoots.clear();
    this.changed.dispose();
    logInfo("working tree file decoration provider disposed");
  }
}

/**
 * 공급자와 VS Code 등록을 extension context에 묶는다.
 * @param context 확장 종료 때 등록과 내부 소비자를 해제할 컨텍스트
 * @param registry 확장 공통 저장소 탐색 레지스트리
 * @param api 다른 확장에도 노출하는 동일한 공유 작업 상태 API
 * @returns 반환값 없이 기존 API 계약과 비교 장식 공급자를 유지한다.
 */
export function registerWorkingTreeFileDecorations(context: vscode.ExtensionContext, registry: GitServiceRegistry, api: GitSimpleCompareApi): void {
  if (!api.workingTreeStatus) return;
  const provider = new WorkingTreeFileDecorationProvider(registry, api.workingTreeStatus);
  context.subscriptions.push(provider, vscode.window.registerFileDecorationProvider(provider));
}

/**
 * 현재 workspace의 resource만 허용하고 내장 Git과 자체 장식의 설정 우선순위를 존중한다.
 * - Projects 카탈로그의 외부 저장소 URI 때문에 창마다 모든 저장소의 status를 읽지 않게 한다.
 * @param uri Explorer·resourceUri 트리가 장식을 요청한 파일/폴더
 * @returns 현재 열린 workspace 범위이며 내장 Git이 꺼지고 장식이 켜져 있으면 true
 */
function usesFallback(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") return false;
  if (!(vscode.workspace.workspaceFolders ?? []).some(folder => uriBelongsToRoot(uri, folder.uri.fsPath))) return false;
  const config = vscode.workspace.getConfiguration("git", uri);
  return !config.get<boolean>("enabled", true) && config.get<boolean>("decorations.enabled", true);
}

/**
 * 공유 porcelain의 XY를 기본 Git 배지·테마 색·번역 툴팁으로 투영한다.
 * - working 상태를 index보다 우선하고 미추적 U와 충돌 !를 구별한다. rename 양쪽 URI도 유지한다.
 * @param root 저장소 절대 경로
 * @param porcelain NUL 구분 공유 작업 상태 출력
 * @returns URI 문자열로 상수 시간 조회할 표시 인덱스. 정상/ignored 파일은 포함하지 않는다.
 */
export function workingTreeFileDecorations(root: string, porcelain: string): Map<string, vscode.FileDecoration> {
  const decorations = new Map<string, vscode.FileDecoration>();
  for (const entry of parsePorcelainEntries(porcelain)) {
    const presentation = entryPresentation(entry);
    if (!presentation) continue;
    const resource = vscode.Uri.file(path.resolve(root, entry.path));
    if (!uriBelongsToRoot(resource, root)) continue;
    const decoration = new vscode.FileDecoration(presentation.badge, presentation.tooltip, new vscode.ThemeColor(presentation.color));
    decoration.propagate = presentation.badge !== "D";
    decorations.set(resource.toString(), decoration);
    if (entry.oldPath && entry.xy.includes("R")) {
      const original = vscode.Uri.file(path.resolve(root, entry.oldPath));
      if (uriBelongsToRoot(original, root)) decorations.set(original.toString(), decoration);
    }
  }
  return decorations;
}

/** 원래 XY를 native Git의 우선순위·상태 문구·의미 기반 색 토큰으로 변환한다. */
function entryPresentation(entry: PorcelainEntry): { badge: string; tooltip: string; color: string } | undefined {
  const [index, working] = entry.xy;
  if (entry.xy === "??") return { badge: "U", tooltip: vscode.l10n.t("Untracked"), color: "gitDecoration.untrackedResourceForeground" };
  if (entry.xy === "!!" || entry.xy === "  ") return undefined;
  if (entry.xy.includes("U") || entry.xy === "AA" || entry.xy === "DD") {
    return { badge: "!", tooltip: vscode.l10n.t("Merge conflict"), color: "gitDecoration.conflictingResourceForeground" };
  }
  const staged = working === " ";
  const code = staged ? index : working;
  switch (code) {
    case "M": return { badge: "M", tooltip: staged ? vscode.l10n.t("Index Modified") : vscode.l10n.t("Modified"), color: staged ? "gitDecoration.stageModifiedResourceForeground" : "gitDecoration.modifiedResourceForeground" };
    case "A": return { badge: "A", tooltip: staged ? vscode.l10n.t("Index Added") : vscode.l10n.t("Intent to Add"), color: "gitDecoration.addedResourceForeground" };
    case "D": return { badge: "D", tooltip: staged ? vscode.l10n.t("Index Deleted") : vscode.l10n.t("Deleted"), color: staged ? "gitDecoration.stageDeletedResourceForeground" : "gitDecoration.deletedResourceForeground" };
    case "R": return { badge: "R", tooltip: staged ? vscode.l10n.t("Index Renamed") : vscode.l10n.t("Intent to Rename"), color: "gitDecoration.renamedResourceForeground" };
    case "C": return { badge: "C", tooltip: vscode.l10n.t("Index Copied"), color: "gitDecoration.renamedResourceForeground" };
    case "T": return { badge: "T", tooltip: vscode.l10n.t("Type changed"), color: "gitDecoration.modifiedResourceForeground" };
    default: return undefined;
  }
}

/** 파일과 조상을 삭제 전후 모두 알리고 마지막 변경이 사라진 폴더의 전파 색도 해제한다. */
function affectedUris(root: string, resources: string[]): vscode.Uri[] {
  const affected = new Map<string, vscode.Uri>();
  for (const resource of resources) {
    let uri = vscode.Uri.parse(resource);
    while (uriBelongsToRoot(uri, root)) {
      affected.set(uri.toString(), uri);
      if (path.resolve(uri.fsPath) === root) break;
      uri = vscode.Uri.file(path.dirname(uri.fsPath));
    }
  }
  return [...affected.values()];
}
