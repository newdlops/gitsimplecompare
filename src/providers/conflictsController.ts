// 충돌 해결 기능의 조정자(controller) 모듈.
// - 저장소 탐지 → 충돌/작업상태 조회 → 트리뷰·컨텍스트 키 갱신을 한곳에서 처리한다.
//   git 접근은 ConflictService, 표시는 ConflictsTreeProvider 에 위임한다(경계 분리).
import * as vscode from "vscode";
import * as path from "node:path";
import { ConflictService, MergeOperation } from "../git/conflictService";
import { PullService } from "../git/pullService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo } from "../ui/outputLog";
import { ConflictsTreeProvider } from "./conflictsTreeProvider";
import type { PullRequestWorktreeRecovery } from "../git/pullRequestWorktreeRecoveryState";

export const PR_RECOVERY_ACTIVE_CONTEXT = "gitSimpleCompare.prRecoveryActive";
export const PR_PREREQUISITES_AVAILABLE_CONTEXT = "gitSimpleCompare.prPrerequisitesAvailable";

/** 충돌 존재 여부를 when 절에서 쓰기 위한 컨텍스트 키(불리언) */
export const HAS_CONFLICTS_CONTEXT = "gitSimpleCompare.hasConflicts";
/** 진행 중 작업(merge/rebase 등)이 있는지를 when 절에서 쓰기 위한 컨텍스트 키(불리언) */
export const OPERATION_IN_PROGRESS_CONTEXT =
  "gitSimpleCompare.operationInProgress";
/** 진행 중 작업이 rebase 인지를 when 절에서 쓰기 위한 컨텍스트 키(불리언) */
export const OPERATION_IS_REBASE_CONTEXT = "gitSimpleCompare.operationIsRebase";
/** pull 충돌을 pull 직전 상태로 되돌릴 snapshot 이 있는지를 when 절에서 쓰기 위한 컨텍스트 키 */
export const PULL_ROLLBACK_AVAILABLE_CONTEXT =
  "gitSimpleCompare.pullRollbackAvailable";

/** 트리/컨텍스트 키까지 반영이 끝난 충돌 상태 snapshot이다. */
export interface ConflictsRefreshSnapshot {
  repoRoot: string;
  conflicts: string[];
  operation: MergeOperation;
}

/** 조회 중인 service는 게시하지 않고 전체 상태가 준비된 뒤 같은 시점에 공개한다. */
interface ConflictsReadState extends ConflictsRefreshSnapshot {
  service?: ConflictService;
  pullRollbackAvailable: boolean;
}

/**
 * 충돌 해결 UI 의 상태를 관리하는 컨트롤러.
 * - 명령 핸들러는 이 컨트롤러의 메서드/서비스를 통해 동작한다.
 */
export class ConflictsController implements vscode.Disposable {
  private service?: ConflictService;
  private operation: MergeOperation = "none";
  private refreshPromise?: Promise<void>;
  private requestSeq = 0;
  private disposed = false;
  private appliedState?: ConflictsReadState;
  private contextValues?: boolean[];
  private recovery?: PullRequestWorktreeRecovery;
  private returnedRecovery?: { worktreePath: string; originRoot: string };
  private readonly onDidRefreshEmitter =
    new vscode.EventEmitter<ConflictsRefreshSnapshot>();

  /** index 기반 충돌 목록이 UI까지 반영된 뒤 발생하는 이벤트다. */
  readonly onDidRefresh = this.onDidRefreshEmitter.event;

  constructor(
    private readonly registry: GitServiceRegistry,
    private readonly provider: ConflictsTreeProvider,
    private readonly showRecoveryContext?: (recovery: PullRequestWorktreeRecovery | undefined, count: number) => void
  ) {}

  /** 원래 작업트리와 구분해 현재 Conflicts 뷰가 해결 중인 PR 작업을 반환한다. */
  get currentRecovery(): PullRequestWorktreeRecovery | undefined { return this.recovery; }

  /**
   * 명시적으로 선택한 PR 복구 worktree에 충돌 명령을 고정하거나 원래 저장소로 돌아간다.
   * @param recovery 검증된 복구 기록. undefined면 임시 파일을 보존한 채 보기만 종료한다.
   */
  async setPullRequestRecovery(recovery?: PullRequestWorktreeRecovery): Promise<void> {
    if (this.recovery && !recovery) this.returnedRecovery = this.recovery;
    this.recovery = recovery;
    if (recovery) this.returnedRecovery = undefined;
    this.requestSeq++;
    await vscode.commands.executeCommand("setContext", PR_RECOVERY_ACTIVE_CONTEXT, Boolean(recovery));
    await vscode.commands.executeCommand("setContext", PR_PREREQUISITES_AVAILABLE_CONTEXT,
      recovery?.command === "squash" || recovery?.command === "rebase");
    await this.refresh();
  }

  /** 현재 대상 저장소의 ConflictService(없으면 undefined). */
  get current(): ConflictService | undefined {
    return this.service;
  }

  /** 현재 진행 중인 git 작업 종류. */
  get currentOperation(): MergeOperation {
    return this.operation;
  }

  /** 진행 중 응답을 무효화하고 이후 refresh와 구독자 게시를 중단한다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestSeq++;
    this.onDidRefreshEmitter.dispose();
  }

  /**
   * 저장소를 탐지해 충돌 목록과 작업 상태를 다시 읽고 UI/컨텍스트를 갱신한다.
   * - 조용히 동작한다(저장소가 없어도 경고를 띄우지 않음). 자주 호출되기 때문.
   * - 중복 호출자는 같은 Promise를 기다려, Continue 이후 최신 충돌 상태보다 먼저 진행하지 않는다.
   * @returns 마지막 요청의 트리/컨텍스트/구독자 게시까지 완료되는 공유 Promise
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requestSeq++;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.resolve().then(() => this.drainRefreshes());
    return this.refreshPromise;
  }

  /**
   * 실행 중 하나와 최신 후속 조회 하나로 burst를 합치고 오래된 성공/실패는 게시하지 않는다.
   * - 앞 조회가 실패해도 이미 예약된 새 저장소의 조회를 잃지 않는다.
   * - Promise를 완료하기 전에 소유권을 해제해 완료 직후 들어온 요청도 별도 조회로 시작한다.
   * @returns 최신 요청을 반영하면 완료하며, 최신 요청 자체의 실패만 호출자에게 전파한다.
   */
  private async drainRefreshes(): Promise<void> {
    try {
      while (!this.disposed) {
        const requestId = this.requestSeq;
        try {
          const state = await this.readState(requestId);
          if (state && this.isCurrent(requestId)) await this.applyState(state, requestId);
          else logInfo("conflicts refresh skipped", { requestId, reason: "superseded" });
        } catch (error) {
          if (this.disposed) return;
          if (!this.isCurrent(requestId)) {
            logInfo("conflicts refresh skipped", {
              requestId, reason: "superseded-error",
              message: error instanceof Error ? error.message : String(error),
            });
          } else {
            logError("conflicts refresh failed", error, { requestId });
            throw error;
          }
        }
        if (requestId === this.requestSeq) return;
      }
    } finally {
      this.refreshPromise = undefined;
    }
  }

  /**
   * 저장소와 충돌/작업/복구 상태를 읽되 명령 대상이나 표시 상태는 아직 바꾸지 않는다.
   * - 이미 폐기된 요청은 다음 단계의 Git 조회를 시작하지 않아 최신 갱신을 지연시키지 않는다.
   * @param requestId 각 조회 단계 사이에서 최신 요청인지 확인할 세대
   * @returns 현재 요청의 후보 상태. 더 최신 요청이나 dispose로 폐기됐으면 undefined
   */
  private async readState(requestId: number): Promise<ConflictsReadState | undefined> {
    const repoRoot = await this.resolveRepoRoot();
    if (!this.isCurrent(requestId)) return undefined;
    if (!repoRoot) {
      return { repoRoot: "", conflicts: [], operation: "none", pullRollbackAvailable: false };
    }

    const service = this.service?.repoRoot === repoRoot
      ? this.service : new ConflictService(repoRoot);
    const [conflicts, operation] = await Promise.all([
      service.listConflicts(),
      service.getOperation(),
    ]);
    if (!this.isCurrent(requestId)) return undefined;
    const snapshot =
      conflicts.length > 0 || operation !== "none"
        ? await new PullService(repoRoot).findLatestPullRollbackSnapshot()
        : undefined;
    return { repoRoot, service, conflicts, operation, pullRollbackAvailable: Boolean(snapshot) };
  }

  /**
   * 최신 요청의 상태만 공개하고 실제로 바뀐 트리/컨텍스트만 갱신한다.
   * - 경로가 같아도 index blob은 바뀔 수 있으므로 내용 구독자에게는 매번 완료를 알린다.
   * @param state 모든 조회가 끝난 저장소 snapshot
   * @param requestId context 적용 도중 추가 요청이 들어왔는지 검사할 세대
   */
  private async applyState(state: ConflictsReadState, requestId: number): Promise<void> {
    await this.updateContext(state.conflicts, state.operation, state.pullRollbackAvailable);
    if (!this.isCurrent(requestId)) return;
    const previous = this.appliedState;
    const treeChanged = !previous || previous.repoRoot !== state.repoRoot ||
      previous.conflicts.length !== state.conflicts.length ||
      previous.conflicts.some((file, index) => file !== state.conflicts[index]);
    if (treeChanged) this.provider.setState(state.repoRoot, [...state.conflicts]);
    this.service = state.service;
    this.operation = state.operation;
    this.appliedState = { ...state, conflicts: [...state.conflicts] };
    this.showRecoveryContext?.(this.recovery, state.conflicts.length);
    this.onDidRefreshEmitter.fire({
      repoRoot: state.repoRoot, conflicts: [...state.conflicts], operation: state.operation,
    });
    logInfo("conflicts refreshed", {
      repoRoot: state.repoRoot,
      count: state.conflicts.length,
      operation: state.operation,
      pullRollbackAvailable: state.pullRollbackAvailable,
      treeChanged,
    });
  }

  /** dispose나 더 최신 refresh로 폐기된 요청이면 false를 반환한다. */
  private isCurrent(requestId: number): boolean {
    return !this.disposed && requestId === this.requestSeq;
  }

  // ---- 내부 구현 ----

  /**
   * 충돌을 살펴볼 저장소 루트를 조용히 찾는다.
   * - 활성 에디터 파일 → 워크스페이스 폴더 순. 경고 메시지는 띄우지 않는다.
   */
  private async resolveRepoRoot(): Promise<string | undefined> {
    if (this.recovery) return this.recovery.worktreePath;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === "file") {
      if (this.returnedRecovery) {
        const relative = path.relative(this.returnedRecovery.worktreePath, active.fsPath);
        if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
          return this.returnedRecovery.originRoot;
        }
      }
      const fromActive = await this.registry.resolve(dirNameOf(active.fsPath));
      if (fromActive) {
        return fromActive.repoRoot;
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const svc = await this.registry.resolve(folder.uri.fsPath);
      if (svc) {
        return svc.repoRoot;
      }
    }
    return undefined;
  }

  /**
   * 충돌/작업 상태를 컨텍스트 키에 반영한다(뷰 노출·버튼 토글에 사용).
   * @param conflicts 충돌 파일 목록
   * @param operation 진행 중 작업 종류
   * @param pullRollbackAvailable pull 이전 상태로 되돌릴 복구 snapshot 존재 여부
   * @returns 실제 setContext 호출이 모두 적용될 때까지 기다린다.
   */
  private async updateContext(
    conflicts: string[],
    operation: MergeOperation,
    pullRollbackAvailable: boolean
  ): Promise<void> {
    const values = [conflicts.length > 0, operation !== "none", operation === "rebase", pullRollbackAvailable];
    if (this.contextValues?.every((value, index) => value === values[index])) return;
    const keys = [HAS_CONFLICTS_CONTEXT, OPERATION_IN_PROGRESS_CONTEXT, OPERATION_IS_REBASE_CONTEXT, PULL_ROLLBACK_AVAILABLE_CONTEXT];
    try {
      const results = await Promise.allSettled(keys.map((key, index) =>
        vscode.commands.executeCommand("setContext", key, values[index])));
      // 하나가 실패해도 이전 명령이 새 refresh 뒤에 도착하지 않도록 모두 완료시킨다.
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      // 요청이 이미 superseded여도 전송한 값은 기록해야 다음 요청이 올바르게 되돌린다.
      this.contextValues = values;
    } catch (error) {
      this.contextValues = undefined;
      throw error;
    }
  }
}

/**
 * 경로에서 디렉터리 부분만 떼어낸다(플랫폼 구분자 모두 고려).
 * @param fsPath 파일 경로
 */
function dirNameOf(fsPath: string): string {
  const idx = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return idx >= 0 ? fsPath.slice(0, idx) : fsPath;
}
