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
    const entries = await readReflogEntries(deps.repoRoot, { includeUnreachable });
    deps.post({ type: "graphReflog", entries, scannedObjects: includeUnreachable });
    logInfo("graph reflog sent", {
      repoRoot: deps.repoRoot,
      entries: entries.length,
      objects: entries.filter((entry) => entry.source === "unreachable").length,
      includeUnreachable,
      elapsed: Date.now() - started,
    });
  } catch (error) {
    logError("graph reflog failed", error, { repoRoot: deps.repoRoot, includeUnreachable });
    throw error;
  }
}
