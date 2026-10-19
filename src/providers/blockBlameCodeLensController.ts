// 함수/클래스/인터페이스 같은 소스 블록 위에 주요 Git 작업자 Code Vision을 표시한다.
// - 언어 심볼/표시 변환은 blockBlameCodeLensPresentation에, Git 집계는 git 계층에 위임한다.
// - 이 모듈은 VS Code 이벤트, 설정, 문서별 비동기 캐시의 생애주기만 담당한다.
import * as vscode from "vscode";
import type { PreparedFileBlame } from "../git/blameService";
import { isBlameRepositoryScopeCurrent, readBlameCacheIdentity } from "../git/blameCacheIdentity";
import { SharedGitRead } from "../git/sharedGitRead";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo } from "../ui/outputLog";
import { createBlockBlameCodeLens } from "./blockBlameCodeLensPresentation";
import { BlockBlameSourceCache } from "./blockBlameSourceCache";
import { loadBlockBlameSnapshot, type BlockBlameSnapshot } from "./blockBlameSnapshotLoader";

const CONFIG_SECTION = "gitSimpleCompare";
const SHOW_CONFIG_KEY = "blameBlock.show";
const FULL_SHOW_CONFIG_KEY = `${CONFIG_SECTION}.${SHOW_CONFIG_KEY}`;
const BLOCK_CONTEXT_KEY = "gitSimpleCompare.blame.block.visible";
const CACHE_TTL_MS = 60_000;
const EMPTY_CACHE_TTL_MS = 500;
const SYMBOL_RETRY_DELAYS_MS = [250, 750, 1500];
const SKIP_LOG_TTL_MS = 15_000;

/** 같은 문서에 들어오는 여러 viewport 요청이 한 Git 프로세스를 공유하기 위한 캐시 항목. */
interface CachedSnapshot {
  /** 캐시에 들어간 TextDocument.version */
  documentVersion: number;
  languageId: string;
  /** 커밋/브랜치 변경 뒤 오래된 결과가 유지되지 않게 하는 만료 시각 */
  expiresAt: number;
  /** 진행 중 조회까지 공유하는 snapshot promise */
  read: SharedGitRead<BlockBlameSnapshot>;
  repoRoot?: string;
  cacheIdentity?: string;
  bytes: number;
}

/** 반복 viewport 요청이 같은 skip 로그를 쏟지 않게 하는 최근 로그 정보. */
interface SkipLogRecord {
  /** 마지막으로 같은 이유를 기록한 시각 */
  at: number;
  /** 마지막 skip 이유 */
  reason: string;
}

/**
 * 파일 문서의 블록 작성자 Code Vision, 설정 상태, 캐시 무효화를 함께 관리한다.
 * - VS Code 는 보이는 범위마다 provider 를 다시 부를 수 있으므로 문서 버전별 promise 를 공유한다.
 * - 저장되지 않은 문서는 디스크 blame 과 줄 위치가 어긋날 수 있어 의도적으로 표시하지 않는다.
 */
export class BlockBlameCodeLensController
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly sources = new BlockBlameSourceCache();
  private readonly skipLogs = new Map<string, SkipLogRecord>();
  private readonly symbolRetries = new Map<string, { version: number; attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  private visible = readBlockBlameVisibility();
  private registered = false;
  private disposed = false;
  private readonly readControllers = new Set<AbortController>();
  private preload?: { key: string; controller: AbortController };
  private providerRequests = 0;

  /**
   * 저장소 탐색 레지스트리를 주입받아 문서별 GitBlameService 를 지연 생성한다.
   * @param registry 확장 전체가 공유하는 저장소/GitService 레지스트리
   */
  constructor(private readonly registry: GitServiceRegistry) {}

  /**
   * file 문서용 CodeLensProvider와 캐시 무효화 이벤트를 등록한다.
   * @returns 확장 비활성화 때 모든 리소스를 정리할 이 컨트롤러
   */
  register(): vscode.Disposable {
    if (this.registered) {
      return this;
    }
    this.registered = true;
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.window.onDidChangeWindowState(state => this.handleWindowFocus(state.focused)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file") {
          this.invalidateDocument(document.uri, "documentSaved");
          if (document.uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) this.preloadActiveDocument();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === "file") {
          this.invalidateDocument(event.document.uri, "documentChanged", false);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.preload?.key === document.uri.toString()) this.cancelPreload();
        this.sources.invalidate(document.uri.toString());
        this.clearSymbolRetry(document.uri.toString());
        void this.cache.get(document.uri.toString())?.read.dispose();
        this.cache.delete(document.uri.toString());
        this.skipLogs.delete(document.uri.toString());
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.preload?.key !== editor?.document.uri.toString()) this.cancelPreload();
        if (editor?.document.uri.scheme === "file") {
          this.evictExpiredCache();
          this.changeEmitter.fire();
          this.preloadActiveDocument();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(FULL_SHOW_CONFIG_KEY)) {
          this.applyConfiguration("configuration");
        }
        if (event.affectsConfiguration("editor.codeLens")) {
          this.cancelPreload(); this.preloadActiveDocument();
        }
      })
    );
    void syncBlockBlameContext(this.visible);
    logInfo("block blame code vision provider registered", {
      visible: this.visible,
    });
    this.preloadActiveDocument();
    return this;
  }

  /**
   * 문서의 각 지원 블록에 선언문 위 클릭 가능한 주요 작업자 CodeLens를 만든다.
   * @param document 현재 파일 문서
   * @param token 문서 전환으로 요청이 취소됐는지 알려 주는 토큰
   * @returns 선언 위치 순서의 작성자 CodeLens 목록
   */
  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (this.disposed || !this.visible || !vscode.window.state.focused || token.isCancellationRequested) {
      return [];
    }
    if (document.uri.scheme !== "file") {
      this.logSkip(document, "non-file");
      return [];
    }
    if (document.isDirty) {
      this.logSkip(document, "dirty-document");
      return [];
    }

    const controller = new AbortController();
    this.providerRequests++;
    this.readControllers.add(controller);
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      const snapshot = await this.getSnapshot(document, controller.signal);
      if (
        token.isCancellationRequested ||
        document.version !== snapshot.documentVersion ||
        document.isDirty ||
        !vscode.window.state.focused ||
        !this.visible
      ) {
        return [];
      }
      return snapshot.summaries
        .map((summary) => createBlockBlameCodeLens(document, summary))
        .filter((lens): lens is vscode.CodeLens => lens !== undefined);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return [];
      logError("block blame code vision failed", error, {
        path: document.uri.fsPath,
      });
      return [];
    } finally { subscription.dispose(); this.readControllers.delete(controller); }
  }

  /** focus를 잃으면 표시 소비자만 취소하고 복귀 시 최신 HEAD/문서로 CodeLens를 다시 요청한다. */
  private handleWindowFocus(focused: boolean): void {
    if (this.disposed) return;
    if (!focused) {
      this.cancelPreload();
      for (const controller of this.readControllers) controller.abort();
      for (const retry of this.symbolRetries.values()) {
        if (retry.timer) clearTimeout(retry.timer);
        retry.timer = undefined;
      }
      logInfo("block blame code vision suspended", { reason: "window-unfocused", reads: this.readControllers.size });
    } else {
      // 완료 결과는 다음 요청에서 실제 identity를 확인한다. 포커스만으로 심볼까지 버리지 않는다.
      this.changeEmitter.fire();
      this.preloadActiveDocument();
      logInfo("block blame code vision resumed", { reason: "window-focused" });
    }
  }

  /**
   * 블록 작성자 Code Vision 설정을 전역 범위에서 켜거나 끈다.
   * @returns 설정 저장이 끝났을 때 완료되는 Promise
   */
  async toggleVisible(): Promise<void> {
    const next = !this.visible;
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(SHOW_CONFIG_KEY, next, vscode.ConfigurationTarget.Global);
    logInfo("block blame code vision visibility toggled", { visible: next });
    this.applyConfiguration("toggle");
  }

  /**
   * 현재 설정에서 읽은 블록 작성자 Code Vision 표시 여부를 반환한다.
   * @returns 표시 중이면 true
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Block Author 클릭에 쓸 전체 blame을 다시 조회하지 않고 검증해 돌려준다.
   * @param document 클릭 대상 저장 문서, signal 탭 변경/취소 신호
   * @returns HEAD/index/파일/설정과 중첩 저장소 경계까지 같은 완료 결과. 없으면 일반 Git 경로로 복귀한다.
   */
  async preparedFile(document: vscode.TextDocument, signal?: AbortSignal): Promise<PreparedFileBlame | undefined> {
    const cached = this.cache.get(document.uri.toString());
    const snapshot = cached?.read.peek(Infinity);
    if (!cached || !snapshot?.repoRoot || !snapshot.cacheIdentity || !snapshot.fileBlame) return undefined;
    if (!await this.isCurrentSnapshot(document, cached, signal)) return undefined;
    signal?.throwIfAborted();
    if (document.isDirty || document.version !== cached.documentVersion || document.languageId !== cached.languageId
      || this.disposed || !this.visible || !vscode.window.state.focused || this.cache.get(document.uri.toString()) !== cached
      || !cached.read.peek(Infinity)) return undefined;
    return { repoRoot: snapshot.repoRoot, cacheIdentity: snapshot.cacheIdentity, blame: snapshot.fileBlame };
  }

  /**
   * 저장소 이벤트 뒤 완료 snapshot은 metadata로 재검증하고 진행 중 이전 조회만 취소한다.
   * @param reason OUTPUT 채널에서 무효화 원인을 추적할 문자열
   */
  refresh(reason: string): void {
    if (this.cache.size === 0) {
      return;
    }
    const documents = this.cache.size;
    this.cancelPreload();
    for (const [key, cached] of this.cache) {
      if (!cached.read.peek(Infinity)) { void cached.read.dispose(); this.cache.delete(key); }
    }
    this.changeEmitter.fire();
    logInfo("block blame code vision cache revalidation requested", { reason, documents, retained: this.cache.size });
    this.preloadActiveDocument();
  }

  /** provider 등록, 이벤트 emitter, 진행 중 캐시 참조를 모두 정리한다. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelPreload();
    this.sources.clear();
    for (const key of this.symbolRetries.keys()) this.clearSymbolRetry(key);
    for (const controller of this.readControllers) controller.abort();
    this.readControllers.clear();
    for (const cached of this.cache.values()) void cached.read.dispose();
    this.cache.clear();
    this.skipLogs.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /**
   * 문서 버전과 TTL 이 일치하는 snapshot promise 를 재사용하고 아니면 새로 읽는다.
   * @param document blame 과 언어 심볼을 결합할 저장된 문서
   * @returns 블록별 주요 작업자 snapshot
   */
  private async getSnapshot(
    document: vscode.TextDocument,
    signal?: AbortSignal
  ): Promise<BlockBlameSnapshot> {
    signal?.throwIfAborted();
    if (this.disposed || !this.visible || !vscode.window.state.focused || document.isDirty) throw new DOMException("Blame cancelled.", "AbortError");
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.documentVersion === document.version && cached.languageId === document.languageId
    ) {
      if (cached.read.hasConsumers() || (!cached.repoRoot && cached.expiresAt > Date.now())) {
        return cached.read.read({ signal, maxCacheAgeMs: CACHE_TTL_MS });
      }
      const current = await this.isCurrentSnapshot(document, cached, signal);
      // 같은 오래된 완료 값을 검사하던 다른 viewport가 먼저 새 세대를 만들었으면 그 조회를 공유한다.
      if (this.cache.get(key) !== cached) return this.getSnapshot(document, signal);
      if (current) return cached.read.peek(Infinity)!;
    }

    if (cached) void cached.read.dispose();
    const read = new SharedGitRead(async abort => {
      const value = await this.loadSnapshot(document, abort);
      entry.repoRoot = value.repoRoot; entry.cacheIdentity = value.cacheIdentity;
      entry.bytes = value.fileBlame?.reduce((sum, line) => sum + 256 + 2 * (line.commit.length + line.authorName.length
        + line.authorMail.length + line.summary.length + line.filename.length + line.content.length), 0) ?? 0;
      // 언어 서버 초기화 전의 빈 심볼/저장소 결과를 정상 blame과 같은 60초 동안 유지하지 않는다.
      entry.expiresAt = Date.now() + (value.repoRoot ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS);
      return value;
    }, value => value);
    const entry: CachedSnapshot = {
      documentVersion: document.version,
      languageId: document.languageId,
      expiresAt: Date.now() + CACHE_TTL_MS,
      read,
      bytes: 0,
    };
    this.cache.set(key, entry);
    const promise = read.read({ signal, maxCacheAgeMs: CACHE_TTL_MS });
    void promise.then(() => this.pruneSnapshotCache(), () => {
      if (this.cache.get(key) === entry && !entry.read.hasConsumers()) {
        this.cache.delete(key);
      }
    });
    return promise;
  }

  /**
   * 독립 loader에 조회를 위임하고 빈 심볼의 제한된 재시도만 컨트롤러 수명에 연결한다.
   * @param document 저장된 file 문서
   * @returns 현재 문서 버전에 해당하는 snapshot
   */
  private async loadSnapshot(
    document: vscode.TextDocument,
    signal: AbortSignal
  ): Promise<BlockBlameSnapshot> {
    const snapshot = await loadBlockBlameSnapshot(document, this.registry, this.sources, signal);
    signal.throwIfAborted();
    if (snapshot.skipReason) {
      this.logSkip(document, snapshot.skipReason);
      if (snapshot.skipReason === "no-supported-symbols") this.scheduleSymbolRetry(document);
    } else this.clearSymbolRetry(document.uri.toString());
    return snapshot;
  }

  /** 완료 값은 기존 TTL 안에서도 metadata로 검증한다. 검증 중 문서/설정/캐시가 바뀌면 재사용하지 않는다. */
  private async isCurrentSnapshot(document: vscode.TextDocument, cached: CachedSnapshot, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!cached.repoRoot || !cached.cacheIdentity || cached.expiresAt <= Date.now() || !cached.read.peek(Infinity) || cached.documentVersion !== document.version
      || cached.languageId !== document.languageId || document.isDirty || this.disposed || !this.visible || !vscode.window.state.focused) return false;
    const [identity, sameScope] = await Promise.all([
      readBlameCacheIdentity(cached.repoRoot, document.uri.fsPath),
      isBlameRepositoryScopeCurrent(cached.repoRoot, document.uri.fsPath),
    ]);
    signal?.throwIfAborted();
    return !!identity && sameScope && identity === cached.cacheIdentity && !this.disposed && this.visible && !document.isDirty
      && vscode.window.state.focused && document.version === cached.documentVersion && document.languageId === cached.languageId
      && cached.expiresAt > Date.now() && this.cache.get(document.uri.toString()) === cached && !!cached.read.peek(Infinity);
  }

  /** VS Code provider 지연 전에 활성 저장 파일 하나만 준비하며 나중의 provider 소비자와 같은 조회를 공유한다. */
  private preloadActiveDocument(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (this.disposed || !this.visible || !vscode.window.state.focused || !document || document.isDirty || document.uri.scheme !== "file"
      || !vscode.workspace.getConfiguration("editor", document.uri).get<boolean>("codeLens", true)) return;
    if (this.preload?.key === document.uri.toString()) return;
    this.cancelPreload();
    const preload = { key: document.uri.toString(), controller: new AbortController() };
    this.preload = preload;
    const requests = this.providerRequests, version = document.version;
    void this.getSnapshot(document, preload.controller.signal).then(() => {
      if (this.preload === preload && !preload.controller.signal.aborted && version === document.version && requests === this.providerRequests) {
        this.changeEmitter.fire();
      }
    }).catch(error => {
      if (!preload.controller.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
        logError("block blame code vision preload failed", error, { path: document.uri.fsPath });
      }
    }).finally(() => { if (this.preload === preload) this.preload = undefined; });
  }

  /** 활성 탭/포커스/문서 수명이 끝나면 선행 소비자만 취소하고 다른 provider 소비자는 유지한다. */
  private cancelPreload(): void { this.preload?.controller.abort(); this.preload = undefined; }

  /** 완료 blame이 탭마다 쌓이지 않게 8문서/16MiB를 제한하되 활성 파일과 진행 중 소비자는 보호한다. */
  private pruneSnapshotCache(): void {
    let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    for (const [key, entry] of this.cache) {
      if ((this.cache.size > 8 || bytes > 16 * 1024 * 1024) && key !== active && !entry.read.hasConsumers()) {
        this.cache.delete(key); bytes -= entry.bytes; void entry.read.dispose();
      }
    }
  }

  /**
   * 한 문서의 캐시를 지우고 필요하면 VS Code에 CodeLens 재요청 이벤트를 보낸다.
   * @param uri 무효화할 문서 URI
   * @param reason OUTPUT 추적용 이벤트 이름
   * @param emitChange false 면 VS Code 자체 문서 변경 재요청에 맡긴다.
   */
  private invalidateDocument(
    uri: vscode.Uri,
    reason: string,
    emitChange = true
  ): void {
    if (this.preload?.key === uri.toString()) this.cancelPreload();
    this.sources.invalidate(uri.toString());
    void this.cache.get(uri.toString())?.read.dispose();
    this.clearSymbolRetry(uri.toString());
    const removed = this.cache.delete(uri.toString());
    if (emitChange) {
      this.changeEmitter.fire();
    }
    if (removed) {
      logInfo("block blame code vision document invalidated", {
        reason,
        path: uri.fsPath,
      });
    }
  }

  /**
   * 설정 변경을 상태/context/cache 에 원자적으로 반영한다.
   * @param reason configuration 또는 명령 토글 같은 변경 원인
   */
  private applyConfiguration(reason: string): void {
    const next = readBlockBlameVisibility();
    const changed = next !== this.visible;
    this.visible = next;
    this.cancelPreload();
    for (const key of this.symbolRetries.keys()) this.clearSymbolRetry(key);
    for (const cached of this.cache.values()) void cached.read.dispose();
    this.cache.clear();
    void syncBlockBlameContext(next);
    this.changeEmitter.fire();
    if (next) this.preloadActiveDocument();
    if (changed || reason !== "configuration") {
      logInfo("block blame code vision configuration applied", {
        reason,
        visible: next,
      });
    }
  }

  /** TTL 이 지난 문서 캐시만 제거해 탭 전환 시 최신 Git identity 를 다시 읽게 한다. */
  private evictExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now && key !== vscode.window.activeTextEditor?.document.uri.toString()) {
        void value.read.dispose();
        this.cache.delete(key);
      }
    }
  }

  /**
   * 언어 서버 시작 전의 빈 심볼 결과는 보이는 활성 문서에서 최대 세 번 다시 요청한다.
   * - 일반 텍스트·심볼이 없는 파일은 제한 뒤 멈춰 Git 조회나 무한 polling을 만들지 않는다.
   * @param document 심볼이 아직 없었던 저장 문서. version이 바뀌면 기존 재시도를 폐기한다.
   */
  private scheduleSymbolRetry(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (this.disposed || !this.visible || !vscode.window.state.focused || vscode.window.activeTextEditor?.document.uri.toString() !== key) return;
    let retry = this.symbolRetries.get(key);
    if (retry && retry.version !== document.version) { this.clearSymbolRetry(key); retry = undefined; }
    if (!retry) { retry = { version: document.version, attempts: 0 }; this.symbolRetries.set(key, retry); }
    if (retry.timer || retry.attempts >= SYMBOL_RETRY_DELAYS_MS.length) return;
    const delay = SYMBOL_RETRY_DELAYS_MS[retry.attempts++];
    retry.timer = setTimeout(() => {
      retry!.timer = undefined;
      if (this.disposed || !this.visible || !vscode.window.state.focused || document.isDirty || document.version !== retry!.version
        || vscode.window.activeTextEditor?.document.uri.toString() !== key) return;
      const cached = this.cache.get(key);
      if (cached?.read.hasConsumers()) return;
      void cached?.read.dispose();
      this.cache.delete(key);
      this.changeEmitter.fire();
      logInfo("block blame code vision symbols retried", { path: document.uri.fsPath, attempt: retry!.attempts, delayMs: delay });
    }, delay);
  }

  /** 문서 변경·성공·종료 때 해당 URI의 재시도 timer와 제한 횟수를 함께 해제한다. */
  private clearSymbolRetry(key: string): void {
    const retry = this.symbolRetries.get(key);
    if (retry?.timer) clearTimeout(retry.timer);
    this.symbolRetries.delete(key);
  }

  /**
   * 동일 문서/이유의 skip 로그를 짧은 시간 한 번만 남긴다.
   * @param document skip 된 문서
   * @param reason dirty/no-repo/no-symbol 같은 건너뛴 원인
   */
  private logSkip(document: vscode.TextDocument, reason: string): void {
    const key = document.uri.toString();
    const previous = this.skipLogs.get(key);
    const now = Date.now();
    if (
      previous &&
      previous.reason === reason &&
      now - previous.at < SKIP_LOG_TTL_MS
    ) {
      return;
    }
    this.skipLogs.set(key, { at: now, reason });
    logInfo("block blame code vision skipped", {
      reason,
      path: document.uri.fsPath,
    });
  }
}

/**
 * 현재 사용자 설정에서 블록 작성자 Code Vision 표시 여부를 읽는다.
 * @returns 설정이 없으면 기본 true, 명시적으로 끄면 false
 */
function readBlockBlameVisibility(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>(SHOW_CONFIG_KEY, true);
}

/**
 * Changes view title 의 checked/unchecked 토글 항목이 사용할 context key 를 맞춘다.
 * @param visible 현재 블록 Code Vision 표시 여부
 */
async function syncBlockBlameContext(visible: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", BLOCK_CONTEXT_KEY, visible);
}
