// 그래프 패널의 rebase 관련 메시지를 처리하는 라우터.
// - graphPanel.ts 는 웹뷰 생애주기와 공통 라우팅만 맡고, rebase 실행/진행 표시 조립은 여기서 담당한다.
import type { ToWebviewMessage, FromWebviewMessage } from "./graphProtocol";
import {
  abortGraphRebase,
  continueGraphRebase,
  openPausedRebaseEditFile,
  prepareGraphRebase,
  runGraphRebase,
} from "./graphRebaseActions";
import type { GraphRebaseControlResult, GraphRebaseDeps } from "./graphRebaseActions";
import {
  graphRebaseResultProgress,
  graphRebaseStartingProgress,
} from "./graphRebaseProgress";
import type { GraphRebaseProgressAction } from "./graphRebaseProgress";
import type { RebaseItem, RebaseResult } from "../git/rebaseService";

type GraphRebaseMessage = Extract<
  FromWebviewMessage,
  | { type: "openRebaseEditFile" }
  | { type: "prepareGraphRebase" }
  | { type: "continueGraphRebase" }
  | { type: "abortGraphRebase" }
  | { type: "runGraphRebase" }
>;

/** 그래프 rebase 라우터가 필요한 패널 의존성 */
export interface GraphRebaseRouterDeps extends GraphRebaseDeps {
  post: (message: ToWebviewMessage) => void;
}

/**
 * 웹뷰 메시지가 그래프 rebase 실행/제어 메시지인지 확인한다.
 * @param msg 웹뷰에서 받은 메시지
 * @returns rebase 라우터가 처리해야 하는 메시지면 true
 */
export function isGraphRebaseMessage(
  msg: FromWebviewMessage
): msg is GraphRebaseMessage {
  return (
    msg.type === "openRebaseEditFile" ||
    msg.type === "prepareGraphRebase" ||
    msg.type === "continueGraphRebase" ||
    msg.type === "abortGraphRebase" ||
    msg.type === "runGraphRebase"
  );
}

/**
 * 그래프 rebase 메시지를 실행하고 결과/진행 상태를 웹뷰로 보낸다.
 * @param msg rebase 관련 웹뷰 메시지
 * @param deps git 서비스/확장 URI/그래프 새로고침/post 의존성
 */
export async function handleGraphRebaseMessage(
  msg: GraphRebaseMessage,
  deps: GraphRebaseRouterDeps
): Promise<void> {
  if (msg.type === "openRebaseEditFile") {
    await openPausedRebaseEditFile(msg.path, deps);
    return;
  }
  if (msg.type === "prepareGraphRebase") {
    const plan = await prepareGraphRebase(msg.hash, msg.onto, deps);
    deps.post({ type: "graphRebasePlan", plan });
    return;
  }
  if (msg.type === "runGraphRebase") {
    await runWithProgress(deps, "run", msg.items, () =>
      runGraphRebase(
        msg.base,
        Boolean(msg.root),
        msg.onto,
        msg.items,
        msg.editPath,
        deps
      )
    );
    return;
  }
  if (msg.type === "continueGraphRebase") {
    const items = msg.items ?? [];
    await runWithProgress(deps, "continue", items, () =>
      continueGraphRebase(deps, items, msg.changedHashes)
    );
    return;
  }
  await runWithProgress(deps, "abort", [], () => abortGraphRebase(deps));
}

/** rebase 제어 작업을 실행하고 예외도 failed 진행 상태로 표시한다. */
async function runWithProgress(
  deps: GraphRebaseRouterDeps,
  action: GraphRebaseProgressAction,
  items: RebaseItem[],
  task: () => Promise<RebaseResult | GraphRebaseControlResult>
): Promise<void> {
  deps.post(graphRebaseStartingProgress(action, items));
  try {
    postRebaseResult(deps, action, await task(), items);
  } catch (err) {
    postRebaseResult(deps, action, { status: "failed", message: errText(err) }, items);
    throw err;
  }
}

/** rebase 결과를 진행 배너와 기존 rebase UI 상태 메시지로 함께 보낸다. */
function postRebaseResult(
  deps: GraphRebaseRouterDeps,
  action: GraphRebaseProgressAction,
  result: RebaseResult | GraphRebaseControlResult,
  items: RebaseItem[]
): void {
  deps.post(graphRebaseResultProgress(action, result, items));
  if (result.status === "completed" || result.status === "aborted" || result.status === "noop") {
    deps.post({ type: "graphRebaseClear" });
  } else if (result.status === "paused" && result.paused) {
    deps.post({ type: "graphRebasePaused", paused: result.paused });
  } else if (result.status === "conflicts") {
    deps.post({ type: "graphRebaseOperation", active: true });
  }
}

/** 알 수 없는 예외를 진행 배너에 넣을 짧은 문자열로 변환한다. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
