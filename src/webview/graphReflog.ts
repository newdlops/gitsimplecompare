// 그래프 웹뷰의 reflog 패널 데이터를 전송하는 모듈.
// - git reflog 조회는 git/reflogService 에 위임하고, 이 모듈은 웹뷰 메시지와 로그만 담당한다.
import type { ToWebviewMessage } from "./graphProtocol";
import { readReflogEntries } from "../git/reflogService";
import { logError, logInfo } from "../ui/outputLog";

/** reflog 전송에 필요한 의존성 */
export interface GraphReflogDeps {
  repoRoot: string;
  post: (message: ToWebviewMessage) => void;
}

/** reflog 조회 모드 옵션 */
export interface GraphReflogSendOptions {
  includeUnreachable?: boolean;
  signal?: AbortSignal;
  requestId?: number;
}

/**
 * HEAD reflog 를 읽어 그래프 웹뷰로 보낸다.
 * @param deps    저장소 루트와 post 함수
 * @param options 느린 unreachable object 스캔 포함 여부
 */
export async function sendGraphReflog(
  deps: GraphReflogDeps,
  options: GraphReflogSendOptions = {}
): Promise<void> {
  const includeUnreachable = Boolean(options.includeUnreachable);
  const started = Date.now();
  try {
    logInfo("graph reflog requested", {
      repoRoot: deps.repoRoot,
      includeUnreachable,
    });
    const entries = await readReflogEntries(deps.repoRoot, { includeUnreachable, signal: options.signal });
    options.signal?.throwIfAborted();
    deps.post({ type: "graphReflog", entries, scannedObjects: includeUnreachable, requestId: options.requestId });
    logInfo("graph reflog sent", {
      repoRoot: deps.repoRoot,
      entries: entries.length,
      objects: entries.filter((entry) => entry.source === "unreachable").length,
      includeUnreachable,
      elapsed: Date.now() - started,
    });
  } catch (error) {
    if (options.signal?.aborted) { logInfo("graph reflog cancelled", { repoRoot: deps.repoRoot }); return; }
    logError("graph reflog failed", error, { repoRoot: deps.repoRoot, includeUnreachable });
    throw error;
  }
}

/** 패널별 reflog 조회를 소유하고 선택 교체·닫기·저장소 전환 뒤의 늦은 게시를 막는다. */
export class GraphReflogSender {
  private pending?: { controller: AbortController; requestId?: number; deps: GraphReflogDeps };

  /** @param read 실제 조회 또는 수명 검증에서 주입할 읽기 경계 */
  constructor(private readonly read = sendGraphReflog) {}

  /** 현재 조회만 취소하며 오래된 닫기 메시지가 새 조회를 중단하지 않게 requestId를 대조한다. */
  cancel(reason: string, requestId?: number): void {
    const current = this.pending;
    if (!current || requestId !== undefined && current.requestId !== requestId) return;
    current.controller.abort(); this.pending = undefined;
    current.deps.post({ type: "graphReflogCancelled", requestId: current.requestId });
    logInfo("graph reflog lifecycle cancelled", { repoRoot: current.deps.repoRoot, reason });
  }

  /** 조회 결과와 오류는 현재 요청에만 전달한다. 취소는 일반 오류 알림으로 바꾸지 않는다. */
  async send(deps: GraphReflogDeps, options: GraphReflogSendOptions = {}): Promise<void> {
    this.cancel("replaced");
    const current = { controller: new AbortController(), requestId: options.requestId, deps };
    this.pending = current;
    const scoped: GraphReflogDeps = { ...deps, post: message => {
      if (this.pending === current && !current.controller.signal.aborted) deps.post(message);
    } };
    try { await this.read(scoped, { ...options, signal: current.controller.signal }); }
    catch (error) {
      if (this.pending === current && !current.controller.signal.aborted) deps.post({
        type: "graphReflogError", requestId: current.requestId, message: error instanceof Error ? error.message : String(error),
      });
    } finally { if (this.pending === current) this.pending = undefined; }
  }
}
