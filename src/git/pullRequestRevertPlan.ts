// PR revert 대상 commit을 선택하고 로컬 object database에 준비하는 Git 서비스.
// - 병합 결과가 현재 브랜치에 있으면 실제로 반영된 merge commit을 우선 사용한다.
// - 원본 PR commit이 필요하지만 로컬에 없으면 GitHub pull ref를 숨김 ref로 fetch한다.
import { runGit, runGitBuffer, runGitWithInput } from "./gitExec";
import { PullRequestCommitMaterializer } from "./pullRequestCommitMaterializer";
import type { PullRequestInfo } from "./pullRequestInfo";
import { pullRequestRevertCommitHashes } from "./pullRequestOperationFormat";

/** revert 메뉴가 요구하는 commit 구성 방식 */
export type PullRequestRevertOperation = "squashRevert" | "rebaseRevert";

/** revert 계획이 선택한 Git 이력 출처 */
export type PullRequestRevertTargetKind = "mergedResult" | "originalCommits";

/** 한 번의 git revert에 전달할 commit과 선택적인 mainline 정보 */
export interface PullRequestRevertCommit {
  hash: string;
  mainline?: number;
}

/** PR revert 사전검증에서 만든 실행 계획 */
export interface PullRequestRevertPlan {
  prNumber: number;
  operation: PullRequestRevertOperation;
  preparedHead: string;
  targetKind: PullRequestRevertTargetKind;
  commits: PullRequestRevertCommit[];
  outsideCurrentBranch: number;
  materialized: boolean;
  materializedRef?: string;
  materializedHead?: string;
  materializedPreviousHead?: string;
}

/** 병합 결과 commit을 직접 revert할 수 있는지 확인한 결과 */
interface MergedResultCandidate {
  hash: string;
  parents: string[];
}

/**
 * PR revert의 대상 선택과 원본 commit materialize를 담당한다.
 * UI나 명령 계층에 의존하지 않으므로 다른 PR 작업에서도 같은 준비 규칙을 재사용할 수 있다.
 */
export class PullRequestRevertPlanService {
  private readonly commitMaterializer: PullRequestCommitMaterializer;

  constructor(public readonly repoRoot: string) {
    this.commitMaterializer = new PullRequestCommitMaterializer(repoRoot);
  }

  /**
   * 현재 HEAD를 기준으로 안전하게 실행 가능한 PR revert 계획을 만든다.
   * - Squash Revert는 현재 이력에 포함된 GitHub merge 결과를 가장 정확한 대상으로 우선한다.
   * - Rebase Revert는 commit 단위를 보존해야 하므로 원본 PR commit 목록을 계속 사용한다.
   * - 원본 object가 없으면 `refs/pull/<번호>/head`를 namespaced ref로 가져온 뒤 모두 재검증한다.
   * @param pr GitHub에서 조회한 PR 정보
   * @param operation 실행할 revert 모드
   * @param expectedHead 호출자가 이미 고정한 현재 HEAD. 생략하면 이 메서드가 HEAD를 조회한다.
   * @returns 정규화된 전체 hash와 materialize 상태를 담은 실행 계획
   */
  async prepare(
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation,
    expectedHead?: string
  ): Promise<PullRequestRevertPlan> {
    const preparedHead = expectedHead
      ? await this.normalizeRequiredCommit(expectedHead, "current HEAD")
      : await this.currentHead();
    if (operation === "squashRevert") {
      const merged = await this.mergedResultCandidate(pr, preparedHead);
      if (merged) {
        const requestedCount = pullRequestRevertCommitHashes(pr).length;
        if (merged.parents.length !== 1 || requestedCount <= 1) {
          return this.mergedResultPlan(pr, operation, preparedHead, merged);
        }
        const originalPlan = await this.prepareOriginalCommits(
          pr,
          operation,
          preparedHead
        );
        if (await this.mergedResultMatchesOriginalRange(merged, originalPlan.commits)) {
          return this.mergedResultPlan(
            pr,
            operation,
            preparedHead,
            merged,
            originalPlan
          );
        }
        return originalPlan;
      }
    }
    return this.prepareOriginalCommits(pr, operation, preparedHead);
  }

  /**
   * 계획 준비 중 만든 숨김 PR ref를 더 이상 필요하지 않을 때 조건부로 정리한다.
   * - 기존 ref가 있었으면 원래 값으로 복원하고, 새로 만든 ref면 삭제한다.
   * - ref가 다른 작업에 의해 새 hash로 갱신됐으면 건드리지 않아 동시 실행 결과를 보호한다.
   * - commit object 자체는 Git의 일반 unreachable-object 보존 정책에 맡긴다.
   * @param plan release할 materialize 정보가 포함된 계획
   * @returns 이 호출이 실제 ref를 복원하거나 삭제했으면 true
   */
  async release(plan: PullRequestRevertPlan): Promise<boolean> {
    return this.commitMaterializer.release(plan);
  }

  /**
   * 전달된 계획이 같은 PR·모드·HEAD를 대상으로 준비됐는지 검증한다.
   * 확인창을 띄운 뒤 브랜치가 움직인 경우 오래된 inverse patch를 적용하지 않게 차단한다.
   * @param plan UI 사전검증 단계에서 준비한 계획
   * @param pr 지금 실행하려는 PR
   * @param operation 지금 실행하려는 revert 모드
   * @param currentHead 실제 작업 시작 직전 HEAD
   */
  assertPreparedPlan(
    plan: PullRequestRevertPlan,
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation,
    currentHead: string
  ): void {
    if (plan.prNumber !== pr.number || plan.operation !== operation) {
      throw new Error(`PR #${pr.number} revert plan does not match the requested operation.`);
    }
    if (plan.preparedHead !== currentHead) {
      throw new Error(
        `Current HEAD changed after PR #${pr.number} revert was prepared. ` +
          "Review the updated branch and run the operation again."
      );
    }
  }

  /**
   * 현재 브랜치에 실제로 포함된 GitHub merge 결과를 Squash Revert 후보로 반환한다.
   * GitHub가 MERGED 상태와 merge hash를 모두 제공하고 해당 commit이 HEAD의 조상일 때만 사용한다.
   * @param pr PR 상태와 merge 결과 hash
   * @param currentHead 현재 브랜치 HEAD
   * @returns 직접 revert 가능한 merge commit과 부모 목록, 아니면 undefined
   */
  private async mergedResultCandidate(
    pr: PullRequestInfo,
    currentHead: string
  ): Promise<MergedResultCandidate | undefined> {
    if (pr.state.toUpperCase() !== "MERGED" || !pr.mergeHash) {
      return undefined;
    }
    const hash = await this.resolveOptionalCommit(pr.mergeHash);
    if (!hash || !await this.isAncestor(hash, currentHead)) {
      return undefined;
    }
    return { hash, parents: await this.commitParents(hash) };
  }

  /**
   * 검증된 GitHub merge 결과를 단일 Squash Revert 계획으로 변환한다.
   * 다중 commit 단일-parent 결과를 판별하며 PR head를 fetch했다면 cleanup 정보를 그대로 운반한다.
   * @param pr 계획에 기록할 PR
   * @param operation 항상 squashRevert인 호출 모드
   * @param preparedHead 사용자 확인 전 고정한 현재 HEAD
   * @param merged 실제 현재 브랜치에 포함된 merge 결과
   * @param materializedPlan 결과 검증을 위해 원본 PR head를 가져온 선택 계획
   * @returns merge 결과 commit 하나를 되돌리는 실행 계획
   */
  private mergedResultPlan(
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation,
    preparedHead: string,
    merged: MergedResultCandidate,
    materializedPlan?: PullRequestRevertPlan
  ): PullRequestRevertPlan {
    return {
      prNumber: pr.number,
      operation,
      preparedHead,
      targetKind: "mergedResult",
      commits: [{
        hash: merged.hash,
        mainline: merged.parents.length > 1 ? 1 : undefined,
      }],
      outsideCurrentBranch: 0,
      materialized: materializedPlan?.materialized ?? false,
      materializedRef: materializedPlan?.materializedRef,
      materializedHead: materializedPlan?.materializedHead,
      materializedPreviousHead: materializedPlan?.materializedPreviousHead,
    };
  }

  /**
   * 단일-parent mergeHash의 patch가 원본 PR 전체 commit 범위와 같은지 확인한다.
   * GitHub rebase merge의 mergeHash는 마지막 commit만 가리킬 수 있으므로, 이 검사가 실패하면
   * 원본 commit 전체를 역순 revert해 일부 변경만 되돌리는 오동작을 막는다.
   * @param merged 현재 브랜치에 포함된 단일-parent merge 결과
   * @param reversedCommits 최신→오래된 순서로 정규화한 원본 PR commit
   * @returns 두 범위의 stable patch-id가 같고 비어 있지 않으면 true
   */
  private async mergedResultMatchesOriginalRange(
    merged: MergedResultCandidate,
    reversedCommits: PullRequestRevertCommit[]
  ): Promise<boolean> {
    if (merged.parents.length !== 1 || reversedCommits.length <= 1) {
      return false;
    }
    const commits = [...reversedCommits].reverse().map((commit) => commit.hash);
    const firstParents = await this.commitParents(commits[0]);
    if (firstParents.length !== 1) {
      return false;
    }
    for (let index = 1; index < commits.length; index++) {
      const parents = await this.commitParents(commits[index]);
      if (parents.length !== 1 || parents[0] !== commits[index - 1]) {
        return false;
      }
    }
    const [mergedPatchId, originalPatchId] = await Promise.all([
      this.rangePatchId(merged.parents[0], merged.hash),
      this.rangePatchId(firstParents[0], commits[commits.length - 1]),
    ]);
    return Boolean(mergedPatchId) && mergedPatchId === originalPatchId;
  }

  /**
   * 두 commit tree 사이의 binary-safe diff를 stable patch-id 하나로 정규화한다.
   * line number나 commit metadata가 달라도 같은 변경이면 동일하게 비교할 수 있다.
   * @param from 범위 시작 commit
   * @param to 범위 끝 commit
   * @returns 변경이 있으면 stable patch-id, 빈 diff면 빈 문자열
   */
  private async rangePatchId(from: string, to: string): Promise<string> {
    const diff = await runGitBuffer(
      ["diff", "--binary", "--full-index", "--no-ext-diff", from, to, "--"],
      this.repoRoot
    );
    const output = await runGitWithInput(
      ["patch-id", "--stable"],
      this.repoRoot,
      diff
    );
    return output.trim().split(/\s+/)[0] || "";
  }

  /**
   * 원본 PR commit 목록을 역순 revert 계획으로 준비한다.
   * 로컬에서 누락된 object가 하나라도 있으면 PR head ref를 fetch하고 전체 목록을 다시 확인한다.
   * @param pr 원본 commit OID와 PR 번호
   * @param operation squash/rebase revert 구분
   * @param preparedHead 사전검증 기준 HEAD
   * @returns 원본 commit 기반 계획
   */
  private async prepareOriginalCommits(
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation,
    preparedHead: string
  ): Promise<PullRequestRevertPlan> {
    const requested = pullRequestRevertCommitHashes(pr);
    if (!requested.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to revert.`);
    }
    const prepared = await this.commitMaterializer.prepare(pr, requested);
    try {
      await this.assertOriginalCommitsSupported(pr, prepared.commits);
      const outsideCurrentBranch = await this.countOutsideCurrentBranch(
        prepared.commits,
        preparedHead
      );
      return {
        prNumber: pr.number,
        operation,
        preparedHead,
        targetKind: "originalCommits",
        commits: prepared.commits.map((hash) => ({ hash })),
        outsideCurrentBranch,
        materialized: prepared.materialized,
        materializedRef: prepared.materializedRef,
        materializedHead: prepared.materializedHead,
        materializedPreviousHead: prepared.materializedPreviousHead,
      };
    } catch (error) {
      await this.commitMaterializer.release(prepared).catch(() => false);
      throw error;
    }
  }

  /**
   * 원본 목록에 merge commit이 있으면 자동 mainline 선택을 피하고 명확히 차단한다.
   * Squash Revert가 선택한 병합 결과는 별도 계획에서 `mainline=1`을 명시하므로 이 검사 대상이 아니다.
   * @param pr 오류 메시지에 사용할 PR 정보
   * @param commits 정규화된 원본 commit 목록
   */
  private async assertOriginalCommitsSupported(
    pr: PullRequestInfo,
    commits: string[]
  ): Promise<void> {
    for (const commit of commits) {
      const parents = await this.commitParents(commit);
      if (parents.length > 1) {
        throw new Error(
          `PR #${pr.number} contains merge commit ${shortHash(commit)}. ` +
            "Revert merge commits one by one."
        );
      }
    }
  }

  /**
   * 원본 PR commit 중 현재 HEAD의 조상이 아닌 수를 계산한다.
   * 이 값은 다른 브랜치에 inverse patch를 적용할 위험 경고에 사용한다.
   * @param commits 정규화된 원본 commit 목록
   * @param currentHead 현재 브랜치 HEAD
   */
  private async countOutsideCurrentBranch(
    commits: string[],
    currentHead: string
  ): Promise<number> {
    let count = 0;
    for (const commit of commits) {
      if (!await this.isAncestor(commit, currentHead)) {
        count++;
      }
    }
    return count;
  }

  /**
   * ref/hash가 commit이면 전체 hash를 반환하고, object가 없거나 다른 타입이면 undefined를 반환한다.
   * @param ref 검사할 ref 또는 OID
   */
  private async resolveOptionalCommit(ref: string): Promise<string | undefined> {
    const value = await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    ).catch(() => "");
    return value.trim() || undefined;
  }

  /**
   * 반드시 존재해야 하는 ref/hash를 전체 commit hash로 정규화한다.
   * @param ref 검사할 ref 또는 OID
   * @param label 사용자 오류에 표시할 대상 이름
   */
  private async normalizeRequiredCommit(ref: string, label: string): Promise<string> {
    const hash = await this.resolveOptionalCommit(ref);
    if (!hash) {
      throw new Error(`${label} does not resolve to a commit: ${ref}`);
    }
    return hash;
  }

  /**
   * 지정 commit의 부모 hash 목록을 순서대로 반환한다.
   * 첫 번째 부모는 GitHub merge commit을 `git revert -m 1`로 되돌릴 때 mainline이 된다.
   * @param hash 대상 commit
   */
  private async commitParents(hash: string): Promise<string[]> {
    const output = await runGit(["show", "-s", "--pretty=%P", hash], this.repoRoot);
    return output.trim().split(/\s+/).filter(Boolean);
  }

  /**
   * ancestor가 target 이력에 포함되는지 Git의 merge-base 규칙으로 판정한다.
   * exit code 1은 정상적인 비조상 결과이므로 false로 변환한다.
   * @param ancestor 조상 후보 commit
   * @param target 기준 commit
   */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    return runGit(
      ["merge-base", "--is-ancestor", ancestor, target],
      this.repoRoot
    ).then(() => true, () => false);
  }

  /** 현재 checkout된 HEAD를 전체 commit hash로 반환한다. */
  private async currentHead(): Promise<string> {
    return this.normalizeRequiredCommit("HEAD", "Current HEAD");
  }

}

export { materializedRefForPullRequest } from "./pullRequestCommitMaterializer";

/** 긴 commit hash를 오류와 OUTPUT 필드에 적합한 길이로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
