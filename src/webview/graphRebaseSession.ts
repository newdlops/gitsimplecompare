// 그래프 interactive rebase 세션의 기록/복원 흐름을 담당한다.
// - git/rebaseSessionState 는 파일 저장만 담당하고, 이 모듈은 웹뷰 메시지와 Git 상태를 연결한다.
import { ConflictService } from "../git/conflictService";
import { runGit } from "../git/gitExec";
import type {
  RebaseItem,
  RebasePlanInfo,
  RebaseResult,
} from "../git/rebaseService";
import { RebaseService } from "../git/rebaseService";
import {
  isActiveRebaseSession,
  readRebaseSessionState,
  recordRebaseSessionResult,
  startRebaseSessionState,
  updateRebaseSessionState,
} from "../git/rebaseSessionState";
import { readRebaseTodoProgress } from "../git/rebaseTodoProgress";
import { logInfo } from "../ui/outputLog";
import type { GraphRebaseControlResult, GraphRebaseDeps } from "./graphRebaseActions";
import { graphRebaseTodoProgressMessage } from "./graphRebaseTodoProgress";
import type { ToWebviewMessage } from "./graphProtocol";

/** rebase 실행 시작 세션을 만들 때 필요한 입력 */
export interface GraphRebaseSessionStartInput {
  base: string;
  root: boolean;
  onto?: string;
  items: RebaseItem[];
}

/** 세션 복원에 필요한 post 의존성 */
export interface GraphRebaseSessionRestoreDeps extends GraphRebaseDeps {
  post: (message: ToWebviewMessage) => void;
}

/**
 * 그래프 rebase 실행 전에 복원 가능한 세션 스냅샷을 기록한다.
 * - 이 기록이 성공해야만 rebase 를 시작한다. 그래야 중간 충돌/정지 뒤에 UI 계획을 잃지 않는다.
 * @param input rebase 실행 기준과 todo 항목
 * @param deps  그래프 패널 의존성
 * @returns 세션 파일 경로
 */
export async function beginGraphRebaseSession(
  input: GraphRebaseSessionStartInput,
  deps: Pick<GraphRebaseDeps, "logService">
): Promise<string> {
  const repoRoot = deps.logService.repoRoot;
  const service = new RebaseService(repoRoot);
  const plan = await buildSessionPlan(repoRoot, service, input);
  const saved = await startRebaseSessionState(repoRoot, plan, input.items);
  logInfo("graph rebase session recorded", {
    repoRoot,
    operationId: saved.state.operationId,
    statePath: saved.path,
    items: input.items.length,
    base: input.base,
    root: input.root,
    onto: input.onto,
  });
  return saved.path;
}

/**
 * rebase 제어 명령을 실행하기 직전 세션 파일에 의도를 남긴다.
 * - 이미 rebase 중이면 세션 파일 쓰기 실패가 사용자의 복구 명령을 막지 않도록 호출부에서 best-effort 로 다룬다.
 * @param repoRoot 저장소 루트
 * @param action   continue/skip/abort 같은 제어 동작
 * @param items    최신 UI todo 항목
 */
export async function recordGraphRebaseSessionCheckpoint(
  repoRoot: string,
  action: string,
  items: RebaseItem[]
): Promise<void> {
  const state = await updateRebaseSessionState(repoRoot, {
    action,
    phase: "running",
    items,
    detail: { event: "requested", items: items.length },
  });
  if (state) {
    logInfo("graph rebase session checkpoint recorded", {
      repoRoot,
      action,
      operationId: state.operationId,
      phase: state.phase,
    });
  }
}

/**
 * rebase 제어 결과를 세션 파일에 기록한다.
 * @param repoRoot 저장소 루트
 * @param action   사용자가 실행한 동작
 * @param result   git/rebase 실행 결과
 * @param items    최신 UI todo 항목
 */
export async function recordGraphRebaseSessionResult(
  repoRoot: string,
  action: string,
  result: RebaseResult | GraphRebaseControlResult,
  items: RebaseItem[]
): Promise<void> {
  const state = await recordRebaseSessionResult(repoRoot, action, result, items);
  if (state) {
    logInfo("graph rebase session result recorded", {
      repoRoot,
      action,
      operationId: state.operationId,
      phase: state.phase,
      status: result.status,
    });
  }
}

/**
 * 확장/webview reload 뒤 진행 중인 그래프 rebase 세션을 복원해 웹뷰에 보낸다.
 * - Git 이 실제로 rebase 중일 때만 복원한다. 완료된 과거 세션은 UI 를 되살리지 않는다.
 * @param deps 그래프 패널 의존성과 post 함수
 * @returns 세션을 복원했으면 true
 */
export async function restoreGraphRebaseSession(
  deps: GraphRebaseSessionRestoreDeps
): Promise<boolean> {
  const repoRoot = deps.logService.repoRoot;
  const conflictService = new ConflictService(repoRoot);
  const [state, operation] = await Promise.all([
    readRebaseSessionState(repoRoot).catch(() => undefined),
    conflictService.getOperation().catch(() => "none"),
  ]);
  if (!state || !isActiveRebaseSession(state) || operation !== "rebase") {
    return false;
  }

  const service = new RebaseService(repoRoot);
  const paused = await service.getPausedEditState().catch(() => undefined);
  const stopped = await service.getStoppedState().catch(() => undefined);
  const progress = await readRebaseTodoProgress(repoRoot).catch(() => undefined);
  const conflicts = await conflictService.listConflicts().catch(() => []);
  const phase = conflicts.length > 0 ? "conflicts" : paused ? "paused" : progress ? "stopped" : state.phase;
  await updateRebaseSessionState(repoRoot, {
    action: "restore",
    phase,
    items: state.items,
    paused,
    stopped,
    detail: { operation, progress: Boolean(progress), conflicts: conflicts.length },
  }).catch(() => undefined);

  deps.post({ type: "graphRebasePlan", plan: { ...state.plan, items: state.items } });
  if (progress) {
    deps.post(graphRebaseTodoProgressMessage({
      action: "continue",
      phase: conflicts.length > 0 ? "conflicts" : "paused",
      title: conflicts.length > 0
        ? "Paused with conflicts"
        : paused ? "Paused at edit commit" : "Rebase paused at todo",
      detail: conflicts.length > 0
        ? "Restored rebase session with conflicts. Resolve them, then Continue, Skip, or Abort."
        : paused
        ? "Restored rebase session. Edit files for this commit, then Continue or Skip."
        : "Restored rebase session from Git todo. Continue, Skip, or Abort.",
      progress,
      active: true,
    }));
  }
  if (paused) {
    deps.post({ type: "graphRebasePaused", paused });
  } else {
    deps.post({ type: "graphRebaseOperation", active: true });
  }
  logInfo("graph rebase session restored", {
    repoRoot,
    operationId: state.operationId,
    phase: state.phase,
    paused: paused?.originalHash ?? paused?.hash,
    stopped: stopped?.originalHash ?? stopped?.hash,
    conflicts: conflicts.length,
    todoDone: progress?.done,
    todoRemaining: progress?.remaining,
  });
  return true;
}

/** 저장된 세션 plan 을 현재 Git 상태와 UI todo 로 조립한다. */
async function buildSessionPlan(
  repoRoot: string,
  service: RebaseService,
  input: GraphRebaseSessionStartInput
): Promise<RebasePlanInfo> {
  const [branch, upstream, commits] = await Promise.all([
    runGit(["branch", "--show-current"], repoRoot).then((out) => out.trim()),
    runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      repoRoot
    ).then((out) => out.trim()).catch(() => undefined),
    service.getCommits(input.base, input.root),
  ]);
  return {
    branch,
    upstream,
    base: input.base,
    root: input.root,
    onto: input.onto,
    baseReason: "selected",
    commits,
    items: input.items,
  };
}
