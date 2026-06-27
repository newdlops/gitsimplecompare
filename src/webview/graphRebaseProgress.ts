// 그래프 rebase 실행 결과를 웹뷰 진행 상태 메시지로 변환하는 모듈.
// - git/rebase 실행 모듈은 git 상태만 반환하고, 화면 문구/단계 계산은 여기서 담당한다.
import type {
  RebaseItem,
  RebasePausedState,
  RebaseResult,
  RebaseStoppedState,
} from "../git/rebaseService";
import type { GraphRebaseControlResult } from "./graphRebaseActions";
import type { GraphRebaseProgress, ToWebviewMessage } from "./graphProtocol";

export type GraphRebaseProgressAction = "run" | "continue" | "skip" | "abort";
type GraphRebaseAnyResult = RebaseResult | GraphRebaseControlResult;

/**
 * rebase 명령을 실행하기 직전 웹뷰에 보낼 진행 상태를 만든다.
 * @param action 사용자가 누른 rebase 제어 동작
 * @param items 현재 그래프 rebase todo 항목
 * @returns 웹뷰가 배너를 그릴 수 있는 진행 상태 메시지
 */
export function graphRebaseStartingProgress(
  action: GraphRebaseProgressAction,
  items: RebaseItem[] = []
): ToWebviewMessage {
  const counts = todoCounts(items);
  const detail = action === "run"
    ? `${counts.kept} commit(s) will be replayed from ${counts.total} todo item(s).`
    : action === "continue"
      ? "Saving edit changes and running git rebase --continue."
      : action === "skip"
        ? "Running git rebase --skip for the current todo item."
        : "Running git rebase --abort and restoring the branch state.";
  return progressMessage({
    phase: "running",
    action,
    title: actionTitle(action),
    detail,
    step: 0,
    total: counts.total,
    active: true,
  });
}

/**
 * rebase 실행 결과를 pause/conflict/failure 위치가 포함된 진행 상태로 변환한다.
 * @param action 사용자가 누른 rebase 제어 동작
 * @param result git/rebase 실행 결과
 * @param items 현재 그래프 rebase todo 항목
 * @returns 웹뷰가 배너와 그래프 강조를 갱신할 수 있는 메시지
 */
export function graphRebaseResultProgress(
  action: GraphRebaseProgressAction,
  result: GraphRebaseAnyResult,
  items: RebaseItem[] = []
): ToWebviewMessage {
  if (result.status === "paused" && result.paused) {
    return pausedProgress(action, result.paused, items);
  }
  if (result.status === "conflicts") {
    return stoppedProgress(action, result, items);
  }
  if (result.status === "stopped") {
    return todoStoppedProgress(action, result, items);
  }
  if (result.status === "failed") {
    return failedProgress(action, result, items);
  }
  if (result.status === "completed") {
    return terminalProgress(action, "completed", "Rebase completed", "Graph and Changes were refreshed.");
  }
  if (result.status === "aborted") {
    return terminalProgress(action, "aborted", "Rebase aborted", "The branch was restored to the pre-rebase state.");
  }
  return terminalProgress(action, "noop", "Nothing to rebase", "No commit needed to be replayed.");
}

/** edit todo 에서 멈춘 상태의 진행 메시지를 만든다. */
function pausedProgress(
  action: GraphRebaseProgressAction,
  paused: RebasePausedState,
  items: RebaseItem[]
): ToWebviewMessage {
  const stopped = { hash: paused.hash, originalHash: paused.originalHash };
  const position = todoPosition(items, stopped.originalHash || stopped.hash);
  return progressMessage({
    phase: "paused",
    action,
    title: "Paused at edit commit",
    detail: `${positionText(position, stopped)} Edit files for this commit, then Continue or Skip.`,
    hash: stopped.hash,
    originalHash: stopped.originalHash,
    step: position?.step,
    total: position?.total ?? todoCounts(items).total,
    active: true,
  });
}

/** 파일 충돌 없이 Git rebase todo 에서 멈춘 상태의 진행 메시지를 만든다. */
function todoStoppedProgress(
  action: GraphRebaseProgressAction,
  result: GraphRebaseAnyResult,
  items: RebaseItem[]
): ToWebviewMessage {
  const position = todoPosition(items, result.stopped?.originalHash || result.stopped?.hash);
  return progressMessage({
    phase: "paused",
    action,
    title: "Rebase paused at todo",
    detail: `${positionText(position, result.stopped)} ${result.message || "Resolve the current Git rebase step, then Continue, Skip, or Abort."}`.trim(),
    hash: result.stopped?.hash,
    originalHash: result.stopped?.originalHash,
    step: position?.step,
    total: position?.total ?? todoCounts(items).total,
    guidance: resultGuidance(result),
    active: true,
  });
}

/** 충돌로 멈춘 상태의 진행 메시지를 만든다. */
function stoppedProgress(
  action: GraphRebaseProgressAction,
  result: GraphRebaseAnyResult,
  items: RebaseItem[]
): ToWebviewMessage {
  const stopped = result.stopped;
  const position = todoPosition(items, stopped?.originalHash || stopped?.hash);
  return progressMessage({
    phase: "conflicts",
    action,
    title: "Paused with conflicts",
    detail: `${positionText(position, stopped)} ${result.message || "Resolve conflicts, then Continue, Skip, or Abort."}`.trim(),
    hash: stopped?.hash,
    originalHash: stopped?.originalHash,
    step: position?.step,
    total: position?.total ?? todoCounts(items).total,
    guidance: resultGuidance(result),
    active: true,
  });
}

/** 실패/취소 상태의 진행 메시지를 만든다. */
function failedProgress(
  action: GraphRebaseProgressAction,
  result: GraphRebaseAnyResult,
  items: RebaseItem[]
): ToWebviewMessage {
  const cancelled = result.message === "cancelled";
  const stopped = result.paused
    ? { hash: result.paused.hash, originalHash: result.paused.originalHash }
    : result.stopped;
  const position = todoPosition(items, stopped?.originalHash || stopped?.hash);
  return progressMessage({
    phase: cancelled ? "cancelled" : "failed",
    action,
    title: cancelled ? `${actionTitle(action)} cancelled` : "Rebase failed",
    detail: cancelled
      ? "The current graph rebase state was left unchanged."
      : `${positionText(position, stopped)} ${result.message || "See Git Simple Compare output for details."}`.trim(),
    hash: stopped?.hash,
    originalHash: stopped?.originalHash,
    step: position?.step,
    total: position?.total ?? todoCounts(items).total,
    guidance: resultGuidance(result),
    active: !cancelled,
  });
}

/** 완료/중단/noop 처럼 더 이상 활성 작업이 없는 진행 메시지를 만든다. */
function terminalProgress(
  action: GraphRebaseProgressAction,
  phase: GraphRebaseProgress["phase"],
  title: string,
  detail: string
): ToWebviewMessage {
  return progressMessage({ phase, action, title, detail, active: false });
}

/** 진행 상태 payload 를 웹뷰 메시지 형태로 감싼다. */
function progressMessage(progress: GraphRebaseProgress): ToWebviewMessage {
  return { type: "graphRebaseProgress", progress };
}

/** todo 항목 수와 실제 replay 대상 수를 계산한다. */
function todoCounts(items: RebaseItem[]): { total: number; kept: number } {
  return {
    total: items.length,
    kept: items.filter((item) => item.action !== "drop").length,
  };
}

/** 특정 해시가 todo 몇 번째 항목인지 계산한다. */
function todoPosition(
  items: RebaseItem[],
  hash: string | undefined
): { step: number; total: number } | undefined {
  if (!hash) {
    return undefined;
  }
  const index = items.findIndex((item) => item.hash === hash);
  return index >= 0 ? { step: index + 1, total: items.length } : undefined;
}

/** 위치/해시 정보를 배너 상세 문구 앞부분으로 만든다. */
function positionText(
  position: { step: number; total: number } | undefined,
  stopped: RebaseStoppedState | undefined
): string {
  if (position) {
    return `Todo item ${position.step} of ${position.total}.`;
  }
  const hash = stopped?.originalHash || stopped?.hash;
  return hash ? `Commit ${hash.slice(0, 10)}.` : "";
}

/** 사용자 액션 이름을 진행 상태 제목으로 바꾼다. */
function actionTitle(action: GraphRebaseProgressAction): string {
  if (action === "continue") {
    return "Continuing rebase";
  }
  if (action === "skip") {
    return "Skipping rebase item";
  }
  return action === "abort" ? "Aborting rebase" : "Starting rebase";
}

/** control result 에 포함된 추가 안내를 progress payload 로 전달한다. */
function resultGuidance(result: GraphRebaseAnyResult): string[] | undefined {
  return "guidance" in result && Array.isArray(result.guidance)
    ? result.guidance
    : undefined;
}
