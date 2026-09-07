// 그래프 interactive rebase 세션을 git metadata 아래에 저장하는 모듈.
// - rebase 는 VS Code/webview 수명보다 길게 이어질 수 있으므로, 진행 상태를 .git 아래에
//   원자적으로 기록해 확장 reload 뒤에도 Git 이 관리 중인 todo 와 UI 계획을 다시 연결한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import type {
  RebaseItem,
  RebasePausedState,
  RebasePlanInfo,
  RebaseResult,
  RebaseStoppedState,
} from "./rebaseService";
import type { RebaseTodoProgress } from "./rebaseTodoProgress";
import { readRebaseTodoProgress } from "./rebaseTodoProgress";
import type { GitOperationIdentity } from "./operationControl";

/** 세션 파일 포맷 버전. 구조 변경 시 migration 기준으로 사용한다. */
export const REBASE_SESSION_VERSION = 1;

/** 세션 파일이 나타내는 rebase 진행 단계 */
export type RebaseSessionPhase =
  | "running"
  | "paused"
  | "conflicts"
  | "stopped"
  | "failed"
  | "completed"
  | "aborted"
  | "noop";

/** 세션 파일에 남기는 개별 상태 전환 기록 */
export interface RebaseSessionEvent {
  at: string;
  action: string;
  phase: RebaseSessionPhase;
  detail?: Record<string, unknown>;
}

/** 복원에 필요한 그래프 rebase 세션 스냅샷 */
export interface RebaseSessionState {
  version: typeof REBASE_SESSION_VERSION;
  kind: "graph-rebase";
  operationId: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  phase: RebaseSessionPhase;
  lastAction: string;
  plan: RebasePlanInfo;
  items: RebaseItem[];
  progress?: RebaseTodoProgress;
  paused?: RebasePausedState;
  stopped?: RebaseStoppedState;
  message?: string;
  restoringLocalChanges?: boolean;
  events: RebaseSessionEvent[];
  /** 실제로 시작한 native rebase 세대. 연결 정보가 없는 옛 세션은 자동 복원하지 않는다. */
  nativeOperation?: GitOperationIdentity;
}

/** 세션 상태를 갱신할 때 호출부가 넘길 수 있는 값 */
export interface RebaseSessionUpdate {
  action: string;
  phase: RebaseSessionPhase;
  items?: RebaseItem[];
  paused?: RebasePausedState;
  stopped?: RebaseStoppedState;
  message?: string;
  restoringLocalChanges?: boolean;
  detail?: Record<string, unknown>;
  nativeOperation?: GitOperationIdentity;
}

const MAX_EVENTS = 80;

/**
 * 현재 저장소의 그래프 rebase 세션 파일 경로를 반환한다.
 * - `git rev-parse --git-path` 를 사용해 linked worktree 에서도 올바른 metadata 위치를 얻는다.
 * @param repoRoot 저장소 루트
 * @returns `.git/gitsimplecompare/rebase-session.json` 절대 경로
 */
export async function rebaseSessionStatePath(repoRoot: string): Promise<string> {
  const raw = (
    await runGit(
      ["rev-parse", "--git-path", "gitsimplecompare/rebase-session.json"],
      repoRoot
    )
  ).trim();
  return path.resolve(repoRoot, raw);
}

/**
 * 새 그래프 rebase 세션을 시작 상태로 기록한다.
 * - rebase 실행 전에 호출해, Git 이 중간에 충돌/정지로 빠져도 계획을 복원할 근거를 남긴다.
 * @param repoRoot 저장소 루트
 * @param plan     그래프 rebase 계획 스냅샷
 * @param items    사용자가 확정한 todo 항목(순서/action/message 포함)
 * @returns 저장된 상태와 파일 경로
 */
export async function startRebaseSessionState(
  repoRoot: string,
  plan: RebasePlanInfo,
  items: RebaseItem[]
): Promise<{ state: RebaseSessionState; path: string }> {
  const now = new Date().toISOString();
  const state: RebaseSessionState = {
    version: REBASE_SESSION_VERSION,
    kind: "graph-rebase",
    operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    repoRoot,
    createdAt: now,
    updatedAt: now,
    phase: "running",
    lastAction: "run",
    plan: cloneJson(plan),
    items: cloneJson(items),
    progress: await readRebaseTodoProgress(repoRoot).catch(() => undefined),
    events: [
      {
        at: now,
        action: "run",
        phase: "running",
        detail: {
          base: plan.base,
          root: Boolean(plan.root),
          onto: plan.onto,
          items: items.length,
        },
      },
    ],
  };
  const statePath = await writeRebaseSessionState(repoRoot, state);
  return { state, path: statePath };
}

/**
 * 기존 그래프 rebase 세션 상태를 읽는다.
 * @param repoRoot 저장소 루트
 * @returns 세션 파일이 있고 포맷을 이해할 수 있으면 상태, 아니면 undefined
 */
export async function readRebaseSessionState(
  repoRoot: string
): Promise<RebaseSessionState | undefined> {
  const statePath = await rebaseSessionStatePath(repoRoot);
  const raw = await fs.readFile(statePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Partial<RebaseSessionState>;
  if (
    parsed.version !== REBASE_SESSION_VERSION ||
    parsed.kind !== "graph-rebase" ||
    !parsed.operationId ||
    !parsed.plan
  ) {
    return undefined;
  }
  return parsed as RebaseSessionState;
}

/**
 * 세션 상태에 이벤트를 추가하고 최신 Git todo 진행률을 함께 저장한다.
 * - 호출부는 rebase continue/skip/abort 전후 상태 전환마다 이 함수를 호출한다.
 * @param repoRoot 저장소 루트
 * @param update   새 단계와 결과 정보
 * @returns 갱신한 상태. 기존 세션 파일이 없으면 undefined
 */
export async function updateRebaseSessionState(
  repoRoot: string,
  update: RebaseSessionUpdate
): Promise<RebaseSessionState | undefined> {
  const current = await readRebaseSessionState(repoRoot);
  if (!current) {
    return undefined;
  }
  const now = new Date().toISOString();
  const event: RebaseSessionEvent = {
    at: now,
    action: update.action,
    phase: update.phase,
    detail: update.detail,
  };
  const next: RebaseSessionState = {
    ...current,
    nativeOperation: update.nativeOperation ?? current.nativeOperation,
    updatedAt: now,
    phase: update.phase,
    lastAction: update.action,
    items: cloneJson(update.items ?? current.items),
    plan: {
      ...current.plan,
      items: cloneJson(update.items ?? current.items),
    },
    progress: await readRebaseTodoProgress(repoRoot).catch(() => undefined),
    paused: cloneJson(update.paused),
    stopped: cloneJson(update.stopped),
    message: update.message,
    restoringLocalChanges: update.restoringLocalChanges,
    events: [...current.events, event].slice(-MAX_EVENTS),
  };
  await writeRebaseSessionState(repoRoot, next);
  return next;
}

/**
 * rebase 실행 결과를 세션 phase 로 기록한다.
 * @param repoRoot 저장소 루트
 * @param action   사용자가 실행한 제어 동작(run/continue/skip/abort)
 * @param result   git rebase 실행 결과
 * @param items    최신 UI todo 항목
 */
export async function recordRebaseSessionResult(
  repoRoot: string,
  action: string,
  result: RebaseResultLike,
  items: RebaseItem[],
  nativeOperation?: GitOperationIdentity
): Promise<RebaseSessionState | undefined> {
  return updateRebaseSessionState(repoRoot, {
    action,
    nativeOperation,
    phase: phaseFromResult(result),
    items,
    paused: result.paused,
    stopped: result.stopped,
    message: result.message,
    restoringLocalChanges: result.restoringLocalChanges,
    detail: {
      status: result.status,
      message: result.message,
      paused: result.paused?.originalHash ?? result.paused?.hash,
      stopped: result.stopped?.originalHash ?? result.stopped?.hash,
    },
  });
}

/**
 * 일반/그래프 제어가 해당 세션의 Git 작업을 끝내면 디스크 상태도 terminal로 갱신한다.
 * @param before 실제 제어 명령의 이전 작업. 다른 세션은 갱신하지 않는다.
 * @param after 명령 이후 상태. 같은 세대의 다음 todo에서 멈췄으면 세션을 유지한다.
 */
export async function finishControlledRebaseSession(
  repoRoot: string, before: GitOperationIdentity, after: GitOperationIdentity, action: string
): Promise<void> {
  if (before.operation !== "rebase") return;
  const state = await readRebaseSessionState(repoRoot);
  if (!state?.nativeOperation || state.nativeOperation.gitDir !== before.gitDir ||
      state.nativeOperation.generation !== before.generation) return;
  if (after.operation === "rebase" && after.generation === before.generation) return;
  const restoringLocalChanges = after.operation === "none" && Boolean(await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], repoRoot));
  await updateRebaseSessionState(repoRoot, {
    action, phase: action === "abort" ? "aborted" : "completed", restoringLocalChanges,
    detail: { event: "nativeOperationEnded", generation: before.generation },
  });
}

/**
 * 세션 파일이 복원 대상인지 판단한다.
 * - 완료/중단/noop 은 다음 패널 reload 때 UI 를 되살릴 필요가 없다.
 * @param state 읽어 둔 세션 상태
 */
export function isActiveRebaseSession(state: RebaseSessionState): boolean {
  return !["completed", "aborted", "noop"].includes(state.phase);
}

/**
 * 세션 상태를 원자적으로 쓴다.
 * @param repoRoot 저장소 루트
 * @param state    저장할 세션 상태
 * @returns 실제 파일 경로
 */
async function writeRebaseSessionState(
  repoRoot: string,
  state: RebaseSessionState
): Promise<string> {
  const statePath = await rebaseSessionStatePath(repoRoot);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
  return statePath;
}

/** rebase 결과 status 를 세션 phase 로 변환한다. */
function phaseFromResult(result: RebaseResultLike): RebaseSessionPhase {
  switch (result.status) {
    case "completed":
      return "completed";
    case "conflicts":
      return "conflicts";
    case "paused":
      return "paused";
    case "stopped":
      return "stopped";
    case "aborted":
      return "aborted";
    case "noop":
      return "noop";
    default:
      return "failed";
  }
}

/** 세션 기록에 필요한 rebase 결과 최소 형태 */
type RebaseResultLike = RebaseResult | {
  status: "completed" | "conflicts" | "failed" | "paused" | "aborted" | "stopped";
  message?: string;
  restoringLocalChanges?: boolean;
  paused?: RebasePausedState;
  stopped?: RebaseStoppedState;
};

/** JSON 파일에 쓰기 전 undefined/prototype 을 제거한 plain object 로 만든다. */
function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
