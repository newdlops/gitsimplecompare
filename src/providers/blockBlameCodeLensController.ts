// 함수/클래스/인터페이스 같은 소스 블록 위에 주요 Git 작업자 Code Vision을 표시한다.
// - 언어 심볼/표시 변환은 blockBlameCodeLensPresentation에, Git 집계는 git 계층에 위임한다.
// - 이 모듈은 VS Code 이벤트, 설정, 문서별 비동기 캐시의 생애주기만 담당한다.
import * as vscode from "vscode";
import {
  summarizeBlockBlame,
  type BlockBlameSummary,
} from "../git/blockBlameModel";
import { GitBlameService } from "../git/blameService";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo } from "../ui/outputLog";
import {
  createBlockBlameCodeLens,
  readSourceBlocks,
} from "./blockBlameCodeLensPresentation";

const CONFIG_SECTION = "gitSimpleCompare";
const SHOW_CONFIG_KEY = "blameBlock.show";
const FULL_SHOW_CONFIG_KEY = `${CONFIG_SECTION}.${SHOW_CONFIG_KEY}`;
const BLOCK_CONTEXT_KEY = "gitSimpleCompare.blame.block.visible";
const CACHE_TTL_MS = 60_000;
const SKIP_LOG_TTL_MS = 15_000;
const MAX_BLOCKS_PER_DOCUMENT = 400;

/** 한 문서 버전에서 언어 심볼과 Git blame 을 결합한 캐시 결과. */
interface BlockBlameSnapshot {
  /** 조회 시점 TextDocument.version */
  documentVersion: number;
  /** 선언 위치 순서로 정렬된 블록별 작업자 요약 */
  summaries: BlockBlameSummary[];
}

/** 같은 문서에 들어오는 여러 viewport 요청이 한 Git 프로세스를 공유하기 위한 캐시 항목. */
interface CachedSnapshot {
  /** 캐시에 들어간 TextDocument.version */
  documentVersion: number;
  /** 커밋/브랜치 변경 뒤 오래된 결과가 유지되지 않게 하는 만료 시각 */
  expiresAt: number;
  /** 진행 중 조회까지 공유하는 snapshot promise */
  promise: Promise<BlockBlameSnapshot>;
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
  private readonly skipLogs = new Map<string, SkipLogRecord>();
  private visible = readBlockBlameVisibility();
  private registered = false;
  private disposed = false;

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
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file") {
          this.invalidateDocument(document.uri, "documentSaved");
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === "file") {
          this.invalidateDocument(event.document.uri, "documentChanged", false);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cache.delete(document.uri.toString());
        this.skipLogs.delete(document.uri.toString());
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme === "file") {
          this.evictExpiredCache();
          this.changeEmitter.fire();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(FULL_SHOW_CONFIG_KEY)) {
          this.applyConfiguration("configuration");
        }
      })
    );
    void syncBlockBlameContext(this.visible);
    logInfo("block blame code vision provider registered", {
      visible: this.visible,
    });
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
    if (!this.visible || token.isCancellationRequested) {
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

    try {
      const snapshot = await this.getSnapshot(document);
      if (
        token.isCancellationRequested ||
        document.version !== snapshot.documentVersion ||
        document.isDirty ||
        !this.visible
      ) {
        return [];
      }
      return snapshot.summaries
        .map((summary) => createBlockBlameCodeLens(document, summary))
        .filter((lens): lens is vscode.CodeLens => lens !== undefined);
    } catch (error) {
      logError("block blame code vision failed", error, {
        path: document.uri.fsPath,
      });
      return [];
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
   * Git HEAD/index 또는 작업 파일 상태가 바뀌었을 때 모든 blame snapshot 을 버린다.
   * @param reason OUTPUT 채널에서 무효화 원인을 추적할 문자열
   */
  refresh(reason: string): void {
    if (this.cache.size === 0) {
      return;
    }
    const documents = this.cache.size;
    this.cache.clear();
    this.changeEmitter.fire();
    logInfo("block blame code vision cache refreshed", { reason, documents });
  }

  /** provider 등록, 이벤트 emitter, 진행 중 캐시 참조를 모두 정리한다. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
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
  private getSnapshot(
    document: vscode.TextDocument
  ): Promise<BlockBlameSnapshot> {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.documentVersion === document.version &&
      cached.expiresAt > Date.now()
    ) {
      return cached.promise;
    }

    const promise = this.loadSnapshot(document);
    const entry: CachedSnapshot = {
      documentVersion: document.version,
      expiresAt: Date.now() + CACHE_TTL_MS,
      promise,
    };
    this.cache.set(key, entry);
    void promise.catch(() => {
      if (this.cache.get(key) === entry) {
        this.cache.delete(key);
      }
    });
    return promise;
  }

  /**
   * 저장소 탐색과 DocumentSymbol 조회를 병렬로 실행한 뒤 파일 blame 을 블록별로 집계한다.
   * @param document 저장된 file 문서
   * @returns 현재 문서 버전에 해당하는 snapshot
   */
  private async loadSnapshot(
    document: vscode.TextDocument
  ): Promise<BlockBlameSnapshot> {
    const version = document.version;
    const [service, blocks] = await Promise.all([
      this.registry.resolve(dirname(document.uri.fsPath)),
      readSourceBlocks(document),
    ]);
    if (!service) {
      this.logSkip(document, "no-repository");
      return { documentVersion: version, summaries: [] };
    }
    if (blocks.length === 0) {
      this.logSkip(document, "no-supported-symbols");
      return { documentVersion: version, summaries: [] };
    }

    const selectedBlocks = blocks.slice(0, MAX_BLOCKS_PER_DOCUMENT);
    const blame = await new GitBlameService(service.repoRoot).getFileBlame(
      document.uri.fsPath
    );
    const summaries = selectedBlocks
      .map((block) => summarizeBlockBlame(block, blame))
      .filter((summary) => summary.primaryContributor !== undefined);
    logInfo("block blame code vision loaded", {
      path: service.toRepoRelative(document.uri.fsPath),
      symbols: blocks.length,
      displayed: summaries.length,
      truncated: blocks.length > selectedBlocks.length,
      blameLines: blame.length,
    });
    return { documentVersion: version, summaries };
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
    this.cache.clear();
    void syncBlockBlameContext(next);
    this.changeEmitter.fire();
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
      if (value.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
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

/**
 * 저장소 탐색 시작점으로 사용할 파일의 디렉터리 경로를 구한다.
 * @param fsPath 플랫폼 파일 경로
 * @returns 마지막 경로 구분자 앞부분
 */
function dirname(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index >= 0 ? fsPath.slice(0, index) : fsPath;
}
