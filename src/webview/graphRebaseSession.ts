// 그래프 interactive rebase 세션의 기록/복원 흐름을 담당한다.
// - git/rebaseSessionState 는 파일 저장만 담당하고, 이 모듈은 웹뷰 메시지와 Git 상태를 연결한다.
import { ConflictService, type MergeOperation } from "../git/conflictService";
import { isConflictMutationActive } from "../git/conflictMutationCoordinator";
import { runGit } from "../git/gitExec";
import { assertGitOperation, captureGitOperation } from "../git/operationControl";
import { bindStartedRebase } from "../git/rebaseSessionIdentity";
import { captureRebaseCheckout } from "../git/rebasePlanSafety";
import type {
  RebaseItem,
  RebasePlanInfo,
  RebaseResult,
} from "../git/rebaseService";
import { RebaseService } from "../git/rebaseService";
import { REBASE_RESTORE_CONFLICT_MESSAGE } from "../git/rebasePlanSafety";
import {
  isActiveRebaseSession,
  readRebaseSessionState,
  recordRebaseSessionResult,
  startRebaseSessionState,
  updateRebaseSessionState,
} from "../git/rebaseSessionState";
import { readRebaseTodoProgress } from "../git/rebaseTodoProgress";
import { logError, logInfo } from "../ui/outputLog";
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
 * 화면에 게시한 실행 상태를 실제 Git 작업과 맞춰 외부 Continue/Abort 뒤 남는 paused UI를 정리한다.
 * - 전체 그래프 fingerprint나 느린 PR/commit 조회와 독립적으로 동작한다.
 * - 실행 전 계획과 로컬 변경 복원 충돌 안내는 보존하고, 읽기 실패를 완료로 취급하지 않는다.
 */
export class GraphRebaseSessionSync {
  private repoRoot = "";
  private active = false;
  private running = false;
  private generation = 0;
  private disposed = false;
  private pendingReason?: string;
  private refreshPromise?: Promise<void>;

  /**
   * UI 전송과 Git 읽기 경계를 주입한다. 기본 reader는 linked worktree의 native marker를 확인한다.
   * @param post 현재 패널에 보낼 정리 메시지
   * @param readOperation 테스트에서 외부 Git 완료와 응답 순서를 제어할 수 있는 작업 조회
   */
  constructor(
    private readonly post: (message: ToWebviewMessage) => void,
    private readonly readOperation: (repoRoot: string) => Promise<MergeOperation> =
      repoRoot => new ConflictService(repoRoot).getOperation()
  ) {}

  /** 저장소 교체 시 이전 화면과 조회를 무효화해 다른 저장소의 계획에 오래된 결과를 보내지 않는다. */
  setRepository(repoRoot: string): void {
    if (this.repoRoot === repoRoot || this.disposed) return;
    const hadRepository = Boolean(this.repoRoot);
    this.repoRoot = repoRoot;
    this.active = false;
    this.running = false;
    this.invalidate();
    if (hadRepository) this.post({ type: "graphRebaseClear" });
  }

  /**
   * 이미 UI로 보내는 메시지만 관찰해 계획/실행/정지/종료를 추적한다.
   * @param message 패널의 공통 post 경계를 통과하는 protocol 메시지
   */
  observe(message: ToWebviewMessage): void {
    if (this.disposed) return;
    if (message.type === "graphRebasePlan" || message.type === "graphRebaseClear") {
      this.active = false;
      this.running = false;
    } else if (message.type === "graphRebasePaused") {
      this.active = true;
      this.running = false;
    } else if (message.type === "graphRebaseOperation") {
      this.active = message.active;
      this.running = false;
    } else if (message.type === "graphRebaseProgress") {
      this.active = message.progress.active;
      this.running = message.progress.phase === "running";
    } else return;
    this.invalidate();
  }

  /** hide/저장소 변경/새 UI 상태에서 이미 시작한 조회만 폐기하고 현재 표시 상태는 보존한다. */
  invalidate(): void {
    this.generation++;
    this.pendingReason = undefined;
  }

  /** 패널 폐기 후에는 Git 조회와 늦은 UI 게시를 모두 중단한다. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  /**
   * 외부 metadata 변경, 수동 refresh, focus/reveal에 Git 작업 종료를 확인한다.
   * @param reason OUTPUT에 남길 동기화 원인
   * @returns 이벤트 burst를 합친 최신 조회까지 기다리는 Promise
   */
  refresh(reason: string): Promise<void> {
    if (!this.canRead()) return Promise.resolve();
    this.pendingReason = reason;
    if (!this.refreshPromise) this.refreshPromise = Promise.resolve().then(() => this.drain());
    return this.refreshPromise;
  }

  /** 최신 후속 조회만 남기고 과거 읽기가 새 실행/저장소/계획을 정리하지 못하게 한다. */
  private async drain(): Promise<void> {
    try {
      while (this.pendingReason && this.canRead()) {
        const reason = this.pendingReason;
        this.pendingReason = undefined;
        const repoRoot = this.repoRoot;
        const generation = this.generation;
        try {
          const operation = await this.readOperation(repoRoot);
          if (generation !== this.generation || this.pendingReason || !this.canRead()) continue;
          if (operation === "rebase") continue;
          this.active = false;
          this.post({ type: "graphRebaseClear" });
          logInfo("graph rebase state reconciled", { repoRoot, reason, operation, previous: "active", active: false });
        } catch (error) {
          if (generation === this.generation && !this.disposed) {
            logError("graph rebase state reconciliation failed", error, { repoRoot, reason });
          }
        }
      }
    } finally {
      this.refreshPromise = undefined;
    }
  }

  /** 확장의 자체 Start/Continue/Abort 중간 상태는 native 완료로 오인하지 않는다. */
  private canRead(): boolean {
    return !this.disposed && Boolean(this.repoRoot) && this.active && !this.running &&
      !isConflictMutationActive(this.repoRoot);
  }
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
  const nativeOperation = action === "run" ? await bindStartedRebase(repoRoot) : undefined;
  const state = await recordRebaseSessionResult(repoRoot, action, result, items, nativeOperation);
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
  if (state?.restoringLocalChanges && operation === "none" && (await conflictService.listConflicts()).length) {
    deps.post({ type: "graphRebaseProgress", progress: {
      action: "continue", phase: "conflicts", active: false,
      title: "Local changes need conflict resolution", detail: REBASE_RESTORE_CONFLICT_MESSAGE,
    } });
    deps.post({ type: "graphRebaseOperation", active: false, restoringLocalChanges: true });
    return true;
  }
  if (!state || !isActiveRebaseSession(state) || operation !== "rebase") {
    return false;
  }

  const expected = await captureGitOperation(repoRoot);
  if (!state.nativeOperation || expected.operation !== "rebase" ||
      state.nativeOperation.gitDir !== expected.gitDir || state.nativeOperation.generation !== expected.generation) {
    logInfo("graph rebase session restore skipped", { repoRoot, operationId: state.operationId, reason: "differentNativeOperation" });
    deps.post({ type: "graphRebaseClear" });
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

  await assertGitOperation(repoRoot, expected);
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
  const [branch, upstream, commits, checkout] = await Promise.all([
    runGit(["branch", "--show-current"], repoRoot).then((out) => out.trim()),
    runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      repoRoot
    ).then((out) => out.trim()).catch(() => undefined),
    service.getCommits(input.base, input.root),
    captureRebaseCheckout(repoRoot),
  ]);
  return {
    branch,
    checkout,
    upstream,
    base: input.base,
    root: input.root,
    onto: input.onto,
    baseReason: "selected",
    commits,
    items: input.items,
  };
}
