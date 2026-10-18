// pull 중 로컬 변경을 안전하게 보존하고 충돌 rollback 을 지원하는 git 서비스.
// - graph/command UI 는 이 서비스의 결과만 보고 사용자 메시지와 뷰 갱신을 담당한다.
// - git 상태 변경은 runGit 을 통해서만 수행해 git 접근 경계를 유지한다.
import { detectOperation, detectOperationInGitDir } from "./conflictService";
import { GitError, runGit } from "./gitExec";
import { PullRollbackStore, type PullRollbackSnapshot } from "./pullRollbackStore";
import { readGitCheckoutIdentity } from "./repositoryIdentity";
import { readGitConfigSnapshot } from "./gitConfigSnapshot";
import { hasWorkingTreeChanges } from "./workingTreeChanges";
export type { PullRollbackSnapshot } from "./pullRollbackStore";

type LocalChangeBlocker = "none" | "tracked" | "untracked" | "mixed";

export type PullConflictStage = "pull" | "restoreLocalChanges";

export type PullCurrentResult =
  | { status: "completed"; hadLocalChanges: boolean }
  | {
      status: "conflicts";
      hadLocalChanges: boolean;
      stage: PullConflictStage;
      snapshot?: PullRollbackSnapshot;
      errorMessage: string;
    };

export type PullSnapshotCleanupResult =
  | { status: "none" }
  | { status: "restored"; snapshot: PullRollbackSnapshot }
  | { status: "dropped"; snapshot: PullRollbackSnapshot }
  | { status: "conflicts"; snapshot: PullRollbackSnapshot; errorMessage: string };

/**
 * pull 시점의 로컬 변경을 임시 stash 로 보존하고, 충돌 시 pre-pull 상태로 되돌리는 서비스.
 */
export class PullService {
  private readonly snapshots: PullRollbackStore;

  /** 이 저장소의 worktree별 복구 기록 관리자를 준비한다. */
  constructor(public readonly repoRoot: string) {
    this.snapshots = new PullRollbackStore(repoRoot);
  }

  /**
   * 현재 브랜치를 pull 한다. 로컬 변경이 있어도 먼저 그대로 pull 을 시도하고,
   * pull 이 로컬 변경 때문에 막힌 경우에만 임시 stash 를 만든 뒤 다시 pull 한다.
   * @returns 완료 또는 충돌 상태. 충돌 상태에는 rollback 에 필요한 snapshot 이 포함될 수 있다.
   */
  async pullCurrent(): Promise<PullCurrentResult> {
    const { head, branch, gitDir } = await readGitCheckoutIdentity(this.repoRoot);
    const operation = detectOperationInGitDir(gitDir);
    if (operation !== "none") throw new Error(`Cannot pull while ${operation} is in progress.`);
    const target = await this.readPullTarget(branch);
    const hadLocalChanges = await this.hasLocalChanges();

    try {
      await this.runPull();
    } catch (err) {
      const state = await this.tryIsConflictState(err);
      if (state.conflicted) {
        return this.conflictResult("pull", hadLocalChanges, undefined, err);
      }
      // pull 자체의 fetch 결과로 부재를 판별해 별도 ls-remote 연결을 만들지 않는다.
      if (err instanceof GitError && /couldn't find remote ref|no such ref was fetched/i.test(err.stderr)) {
        throw new Error(`Configured upstream '${target.remote}/${target.mergeRef.replace(/^refs\/heads\//, "")}' was not found. Choose another upstream or recreate the remote branch before pulling.`);
      }
      const blocker = classifyLocalChangeBlocker(err);
      if (!hadLocalChanges || blocker === "none") {
        throw err;
      }
      const snapshot = await this.createRollbackSnapshot(
        head,
        branch,
        shouldIncludeUntracked(blocker)
      );
      if (!snapshot) {
        throw err;
      }
      return this.pullAfterSnapshot(snapshot, hadLocalChanges);
    }

    return { status: "completed", hadLocalChanges };
  }

  /**
   * 로컬 변경 때문에 pull 이 막힌 뒤 snapshot 을 만든 상태에서 pull 을 재시도하고,
   * 완료되면 snapshot 을 작업트리에 적용한다.
   * @param snapshot pull 직전 로컬 변경을 담은 stash
   * @param hadLocalChanges pull 시작 전 로컬 변경 존재 여부
   */
  private async pullAfterSnapshot(
    snapshot: PullRollbackSnapshot,
    hadLocalChanges: boolean
  ): Promise<PullCurrentResult> {
    try {
      await this.runPull();
    } catch (err) {
      const state = await this.tryIsConflictState(err);
      if (state.conflicted) {
        await this.snapshots.bind(snapshot, "pull", snapshot.head);
        return this.conflictResult("pull", hadLocalChanges, snapshot, err);
      }
      await this.restoreSnapshotAfterUnexpectedFailure(snapshot, err);
      throw err;
    }

    await this.snapshots.bind(snapshot, "restoreLocalChanges", await this.currentHead());
    try {
      await this.applySnapshot(snapshot);
    } catch (err) {
      if (
        (await this.tryIsConflictState(err)).conflicted ||
        isStashApplyConflict(err)
      ) {
        return this.conflictResult(
          "restoreLocalChanges",
          hadLocalChanges,
          snapshot,
          err
        );
      }
      await this.restoreSnapshotAfterUnexpectedFailure(snapshot, err);
      throw err;
    }

    await this.dropSnapshot(snapshot);
    return { status: "completed", hadLocalChanges };
  }

  /**
   * 현재 브랜치·worktree·작업과 일치하는 pull rollback snapshot을 확인한다.
   * @returns rollback 가능한 snapshot. 없으면 undefined
   */
  async findLatestPullRollbackSnapshot(): Promise<PullRollbackSnapshot | undefined> {
    return this.snapshots.find();
  }

  /**
   * 현재 작업과 연결된 snapshot으로 pull 직전 HEAD/작업트리 상태를 복원한다.
   * @param expectedId 확인창에서 승인한 snapshot ID. 실행 전 기록이 바뀌면 중단한다.
   * @returns 사용한 snapshot. 없으면 undefined
   */
  async rollbackLatestPull(expectedId?: string): Promise<PullRollbackSnapshot | undefined> {
    const snapshot = await this.findLatestPullRollbackSnapshot();
    if (expectedId && snapshot?.id !== expectedId) {
      throw new Error("Pull recovery changed after confirmation. Refresh and try again. Saved changes remain in the stash.");
    }
    if (!snapshot) {
      return undefined;
    }
    await this.rollbackSnapshot(snapshot);
    return snapshot;
  }

  /**
   * pull merge 충돌이 해결된 뒤 pre-pull 로컬 변경 snapshot 을 복원하고 stash 를 제거한다.
   * @returns snapshot 복원/충돌/없음 상태
   */
  async restoreSnapshotAfterResolvedPull(): Promise<PullSnapshotCleanupResult> {
    const snapshot = await this.snapshots.find("resolvedPull");
    if (!snapshot || (await this.tryIsConflictState()).conflicted) {
      return { status: "none" };
    }
    await this.snapshots.bind(snapshot, "restoreLocalChanges", await this.currentHead());
    try {
      await this.applySnapshot(snapshot);
    } catch (err) {
      if (
        (await this.tryIsConflictState(err)).conflicted ||
        isStashApplyConflict(err)
      ) {
        return {
          status: "conflicts",
          snapshot,
          errorMessage: errorText(err),
        };
      }
      throw err;
    }
    await this.dropSnapshot(snapshot);
    return { status: "restored", snapshot };
  }

  /**
   * stash apply 충돌이 모두 해결되어 snapshot 내용이 이미 작업트리에 반영된 경우 stash 만 제거한다.
   * @returns 제거한 snapshot 정보. 아직 충돌/작업이 남아 있으면 none
   */
  async dropSnapshotAfterResolvedRestore(): Promise<PullSnapshotCleanupResult> {
    const snapshot = await this.snapshots.find("resolvedRestore");
    if (!snapshot || (await this.tryIsConflictState()).conflicted) {
      return { status: "none" };
    }
    await this.snapshots.assertCurrent(snapshot, "resolvedRestore");
    await this.dropSnapshot(snapshot);
    return { status: "dropped", snapshot };
  }

  /** 작업트리나 index 에 커밋되지 않은 변경이 있는지 확인한다. */
  async hasLocalChanges(): Promise<boolean> {
    return hasWorkingTreeChanges(this.repoRoot);
  }

  /** 현재 브랜치의 upstream 변경을 merge pull 방식으로 가져온다. */
  private async runPull(): Promise<void> {
    await runGit(["pull", "--no-rebase", "--no-edit"], this.repoRoot, { retryOnLock: false });
  }

  /** 지정 snapshot 을 기준으로 pull 직전 상태를 복원한다. */
  private async rollbackSnapshot(
    snapshot: PullRollbackSnapshot,
    purpose: "rollback" | "automatic" = "rollback"
  ): Promise<void> {
    await this.snapshots.assertCurrent(snapshot, purpose);
    const expectedHead = await this.currentHead();
    await this.abortOperationIfNeeded();
    await this.snapshots.assertOrigin(snapshot.branch, expectedHead);
    await runGit(["reset", "--hard", snapshot.head], this.repoRoot, { retryOnLock: false });
    await this.popSnapshot(snapshot);
  }

  /** 현재 HEAD 해시를 읽어 rollback 기준점으로 사용한다. */
  private async currentHead(): Promise<string> {
    return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
  }

  /**
   * 현재 브랜치의 upstream 설정을 한 번 읽고 원격 존재 확인은 native pull의 fetch에 맡긴다.
   * @param branch 현재 브랜치 이름
   * @returns 같은 조회에서 확인한 remote와 merge ref. 미설정·detached HEAD는 pull 전에 거부한다.
   */
  private async readPullTarget(branch: string): Promise<{ remote: string; mergeRef: string }> {
    if (!branch || branch === "DETACHED") {
      throw new Error("Cannot pull while HEAD is detached.");
    }
    const config = await readGitConfigSnapshot(this.repoRoot, "^branch\\.");
    const remote = config.get(`branch.${branch}.remote`)?.trim();
    const mergeRef = config.get(`branch.${branch}.merge`)?.trim();
    if (!remote || !mergeRef) {
      throw new Error(`Branch '${branch}' has no upstream configured.`);
    }
    return { remote, mergeRef };
  }

  /**
   * pre-pull 로컬 변경을 담은 stash 를 만들고 stash list 에서 marker 를 찾아 반환한다.
   * @param head pull 직전 HEAD
   * @param branch pull 직전 브랜치 이름
   * @param includeUntracked untracked 파일이 pull 을 막은 경우에만 true
   */
  private async createRollbackSnapshot(
    head: string,
    branch: string,
    includeUntracked: boolean
  ): Promise<PullRollbackSnapshot | undefined> {
    return this.snapshots.create(head, branch, includeUntracked);
  }

  /** 현재 저장소가 충돌 또는 진행 중 작업 상태인지 확인한다. */
  private async isConflictState(): Promise<boolean> {
    const [operation, conflicts] = await Promise.all([
      detectOperation(this.repoRoot),
      runGit(["diff", "--name-only", "--diff-filter=U", "-z"], this.repoRoot),
    ]);
    return operation !== "none" || conflicts.length > 0;
  }

  /**
   * 충돌 상태 조회 자체가 일시적 spawn 오류 등으로 실패해도 원래 git 오류를 덮어쓰지 않는다.
   * - cause 가 없을 때는 cleanup 안전장치로 호출된 경우이므로 실패 시 충돌 상태처럼 보수적으로 취급한다.
   * @param cause 충돌 가능성을 판단할 원래 git 오류
   */
  private async tryIsConflictState(
    cause?: unknown
  ): Promise<{ conflicted: boolean; error?: unknown }> {
    try {
      return { conflicted: await this.isConflictState() };
    } catch (error) {
      return {
        conflicted: cause === undefined ? true : isLikelyConflictError(cause),
        error,
      };
    }
  }

  /** rollback 전에 진행 중인 merge/rebase 류 작업을 우선 abort 한다. */
  private async abortOperationIfNeeded(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") {
      await runGit([operation, "--abort"], this.repoRoot, { retryOnLock: false });
    }
  }

  /** 임시 rollback stash 를 stash 목록에서 제거한다. */
  private async dropSnapshot(snapshot: PullRollbackSnapshot): Promise<void> {
    await this.snapshots.drop(snapshot);
  }

  /**
   * stash snapshot 을 작업트리에 적용한다.
   * - apply 는 stash 를 삭제하지 않으므로 충돌 시 rollback 에 같은 snapshot 을 다시 사용할 수 있다.
   * @param snapshot 적용할 rollback snapshot
   */
  private async applySnapshot(snapshot: PullRollbackSnapshot): Promise<void> {
    await this.snapshots.apply(snapshot);
  }

  /**
   * rollback 시 snapshot 을 복원하고 stash 에서 제거한다.
   * - OID로 apply한 뒤 성공한 객체만 drop하므로 stash 순번 변경과 복원 실패에도 원본을 보존한다.
   * @param snapshot 복원할 rollback snapshot
   */
  private async popSnapshot(snapshot: PullRollbackSnapshot): Promise<void> {
    await this.snapshots.apply(snapshot, snapshot.head);
    await this.snapshots.assertOrigin(snapshot.branch, snapshot.head);
    await this.snapshots.drop(snapshot);
  }

  /** 예상 밖 실패 시 임시 stash 로 숨긴 로컬 변경을 되살린다. 복원 실패는 원인과 함께 다시 던진다. */
  private async restoreSnapshotAfterUnexpectedFailure(
    snapshot: PullRollbackSnapshot,
    originalError: unknown
  ): Promise<void> {
    try {
      await this.rollbackSnapshot(snapshot, "automatic");
    } catch (rollbackError) {
      throw new Error(
        `Pull failed and rollback snapshot restore also failed: ${errorText(
          rollbackError
        )}\nOriginal pull error: ${errorText(originalError)}`
      );
    }
  }

  /** 충돌 결과 객체를 만든다. */
  private conflictResult(
    stage: PullConflictStage,
    hadLocalChanges: boolean,
    snapshot: PullRollbackSnapshot | undefined,
    err: unknown
  ): PullCurrentResult {
    return {
      status: "conflicts",
      hadLocalChanges,
      stage,
      snapshot,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/** unknown 오류를 사용자/로그에 넣기 좋은 짧은 문자열로 변환한다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** stderr 까지 포함해 git 오류 판별에 사용할 문자열을 만든다. */
function errorFullText(err: unknown): string {
  return err instanceof GitError
    ? `${err.message}\n${err.stderr}`
    : errorText(err);
}

/** git 오류 메시지만으로도 충돌 상태로 판단할 수 있는지 확인한다. */
function isLikelyConflictError(err: unknown): boolean {
  return /CONFLICT|Automatic merge failed|needs merge|unmerged|fix conflicts/i.test(
    errorFullText(err)
  );
}

/** direct pull 이 로컬 변경 때문에 막힌 경우인지 분류한다. */
function classifyLocalChangeBlocker(err: unknown): LocalChangeBlocker {
  const text = errorFullText(err);
  const tracked =
    /Your local changes to the following files would be overwritten by (merge|checkout)/i.test(
      text
    ) ||
    /Please commit your changes or stash them before you merge/i.test(text) ||
    /Entry '.*' not uptodate\. Cannot merge/i.test(text);
  const untracked =
    /untracked working tree files? would be overwritten by (merge|checkout)/i.test(
      text
    ) ||
    /untracked working tree files? would be removed by merge/i.test(text) ||
    /The following untracked working tree files would be overwritten/i.test(text);
  if (tracked && untracked) {
    return "mixed";
  }
  if (tracked) {
    return "tracked";
  }
  if (untracked) {
    return "untracked";
  }
  return "none";
}

/** untracked 파일이 pull 을 막은 경우에만 snapshot 에 untracked 를 포함한다. */
function shouldIncludeUntracked(blocker: LocalChangeBlocker): boolean {
  return blocker === "untracked" || blocker === "mixed";
}

/** stash apply 가 사용자 해결이 필요한 상태로 멈췄는지 확인한다. */
function isStashApplyConflict(err: unknown): boolean {
  const text = errorFullText(err);
  return (
    isLikelyConflictError(err) ||
    /already exists, no checkout/i.test(text) ||
    /could not restore untracked files from stash/i.test(text) ||
    /would be overwritten by merge/i.test(text)
  );
}
