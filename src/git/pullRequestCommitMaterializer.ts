// GitHub PR 원본 commit object를 로컬 저장소에 준비하고 숨김 ref 수명주기를 관리하는 서비스.
// - 일반 branch fetch에 포함되지 않는 refs/pull/<번호>/head를 필요할 때만 가져온다.
// - squash/rebase/revert가 같은 object 검증과 조건부 ref 정리 규칙을 공유하게 한다.
import { GitError, runGit, runGitWithInput } from "./gitExec";
import type { PullRequestInfo } from "./pullRequestInfo";

/** PR 작업에 사용할 정규화된 commit 목록과 선택적인 숨김 ref 복구 정보 */
export interface PullRequestCommitMaterialization {
  commits: string[];
  materialized: boolean;
  materializedRef?: string;
  materializedHead?: string;
  materializedPreviousHead?: string;
}

/** 여러 commit object를 한 번에 조회한 결과 */
interface ResolvedCommitSet {
  resolved: string[];
  missing: string[];
}

/** GitHub PR head를 확장 전용 ref에 fetch한 결과 */
interface MaterializedPullRequestHead {
  ref: string;
  hash: string;
  previousHead?: string;
}

const MATERIALIZED_PR_REF_PREFIX = "refs/gitsimplecompare/pr-heads";

/** PR 원본 commit object의 조회·fetch·정리를 담당하는 재사용 가능한 Git 서비스 */
export class PullRequestCommitMaterializer {
  constructor(
    public readonly repoRoot: string,
    private readonly preferredRemote = "origin"
  ) {}

  /**
   * 요청한 PR commit을 모두 실제 commit object로 정규화한다.
   * 로컬에 하나라도 없으면 GitHub pull ref를 숨김 ref로 fetch한 뒤 전체 목록을 다시 검증한다.
   * @param pr PR 번호와 오류 문구에 사용할 GitHub 정보
   * @param hashes GitHub API가 제공한 작업 순서의 commit OID 목록
   * @returns 입력 순서를 보존한 전체 OID와 fetch한 ref의 조건부 복구 정보
   */
  async prepare(
    pr: PullRequestInfo,
    hashes: string[]
  ): Promise<PullRequestCommitMaterialization> {
    const requested = Array.from(new Set(hashes.filter(Boolean)));
    if (!requested.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to prepare.`);
    }
    let commitSet = await this.resolveCommitSet(requested);
    let materialized: MaterializedPullRequestHead | undefined;
    if (commitSet.missing.length > 0) {
      materialized = await this.materializePullRequestHead(pr);
      await this.assertFetchedHeadMatches(pr, materialized);
      commitSet = await this.resolveCommitSet(requested);
    }
    if (commitSet.missing.length > 0) {
      await this.releaseFetchedHeadQuietly(materialized);
      throw new Error(
        `PR #${pr.number} commit object(s) are unavailable after fetching its pull ref: ` +
          commitSet.missing.map(shortHash).join(", ")
      );
    }
    return {
      commits: commitSet.resolved,
      materialized: Boolean(materialized),
      materializedRef: materialized?.ref,
      materializedHead: materialized?.hash,
      materializedPreviousHead: materialized?.previousHead,
    };
  }

  /**
   * 준비 중 만든 숨김 ref를 다른 작업의 갱신을 덮지 않는 compare-and-swap 방식으로 정리한다.
   * 기존 ref가 있었으면 원래 commit으로 복원하고, 이번 작업이 새로 만들었으면 삭제한다.
   * @param prepared prepare가 반환했거나 같은 materialize 필드를 가진 작업 계획
   * @returns 이 호출이 실제 ref를 복원하거나 삭제했으면 true
   */
  async release(
    prepared: Pick<
      PullRequestCommitMaterialization,
      "materializedRef" | "materializedHead" | "materializedPreviousHead"
    >
  ): Promise<boolean> {
    if (!prepared.materializedRef || !prepared.materializedHead) {
      return false;
    }
    const current = await this.resolveOptionalCommit(prepared.materializedRef);
    if (current !== prepared.materializedHead) {
      return false;
    }
    const args = prepared.materializedPreviousHead
      ? [
        "update-ref",
        prepared.materializedRef,
        prepared.materializedPreviousHead,
        prepared.materializedHead,
      ]
      : ["update-ref", "-d", prepared.materializedRef, prepared.materializedHead];
    await runGit(args, this.repoRoot);
    return true;
  }

  /**
   * 원본 commit OID 목록을 한 Git 프로세스로 commit object에 정규화한다.
   * `cat-file --batch-check`를 사용해 큰 PR도 commit마다 별도 프로세스를 만들지 않는다.
   * @param hashes GitHub가 제공한 commit OID 목록
   * @returns 입력 순서를 유지한 전체 hash와 누락 OID
   */
  private async resolveCommitSet(hashes: string[]): Promise<ResolvedCommitSet> {
    const expressions = hashes.map((hash) => `${hash}^{commit}`);
    const output = await runGitWithInput(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      this.repoRoot,
      `${expressions.join("\n")}\n`
    );
    const lines = output.trimEnd().split("\n");
    const resolved: string[] = [];
    const missing: string[] = [];
    for (let index = 0; index < hashes.length; index++) {
      const parts = (lines[index] || "").trim().split(/\s+/);
      if (parts.length === 2 && parts[1] === "commit") {
        resolved.push(parts[0]);
      } else {
        missing.push(hashes[index]);
      }
    }
    return { resolved, missing };
  }

  /**
   * GitHub가 제공하는 PR head ref를 확장 전용 숨김 ref로 fetch한다.
   * destination ref를 명시해 FETCH_HEAD가 바뀌어도 충돌 해결에 필요한 object를 유지한다.
   * @param pr fetch할 양의 PR 번호와 표시 정보
   * @returns 생성된 namespaced ref와 fetch 전 ref 상태
   */
  private async materializePullRequestHead(
    pr: PullRequestInfo
  ): Promise<MaterializedPullRequestHead> {
    if (!Number.isInteger(pr.number) || pr.number <= 0) {
      throw new Error("Cannot fetch a pull request without a valid positive number.");
    }
    const ref = materializedRefForPullRequest(pr.number);
    const source = `refs/pull/${pr.number}/head`;
    const previousHead = await this.resolveOptionalCommit(ref);
    const remote = await this.resolveFetchRemote();
    try {
      await runGit(
        ["fetch", "--no-tags", remote, `+${source}:${ref}`],
        this.repoRoot
      );
      const hash = await this.normalizeRequiredCommit(
        ref,
        `PR #${pr.number} fetched head`
      );
      return { ref, hash, previousHead };
    } catch (error) {
      await this.restoreMaterializedRefAfterFailedFetch(ref, previousHead);
      throw new Error(
        `PR #${pr.number} commit objects are not available locally, and ${source} ` +
          `could not be fetched from ${remote}. ${gitErrorText(error)}`
      );
    }
  }

  /**
   * GraphQL 조회 뒤 PR head가 움직였는지 fetch 결과와 비교한다.
   * fast-forward 갱신이면 예전 commit도 새 head의 조상으로 함께 fetch되므로, 단순 object 존재 검사만으로는
   * 오래된 PR 일부만 적용할 수 있다. 이 경우 사용자가 최신 PR을 다시 확인하도록 작업을 중단한다.
   * @param pr 작업 시작 시 UI가 보유한 GitHub PR head OID
   * @param materialized 방금 pull ref에서 fetch한 실제 head와 ref 복구 정보
   */
  private async assertFetchedHeadMatches(
    pr: PullRequestInfo,
    materialized: MaterializedPullRequestHead
  ): Promise<void> {
    if (
      !pr.headHash ||
      pr.headHash.toLowerCase() === materialized.hash.toLowerCase()
    ) {
      return;
    }
    await this.releaseFetchedHeadQuietly(materialized);
    throw new Error(
      `PR #${pr.number} head changed from ${shortHash(pr.headHash)} to ` +
        `${shortHash(materialized.hash)}. Refresh the pull request and run the operation again.`
    );
  }

  /**
   * pull ref fetch에 사용할 Git remote를 결정한다.
   * 일반적인 origin을 우선하되 origin 없이 다른 이름만 쓰는 clone에서는 정렬된 첫 remote로 폴백한다.
   * @returns 저장소에 실제로 등록된 fetch remote 이름
   */
  private async resolveFetchRemote(): Promise<string> {
    const remotes = (await runGit(["remote"], this.repoRoot))
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean)
      .sort();
    if (remotes.includes(this.preferredRemote)) {
      return this.preferredRemote;
    }
    if (remotes[0]) {
      return remotes[0];
    }
    throw new Error(
      `PR commit objects are not available locally, and repository has no Git remote to fetch them from.`
    );
  }

  /**
   * ref/hash가 commit이면 전체 hash를 반환하고, object가 없거나 다른 타입이면 undefined를 반환한다.
   * @param ref 검사할 ref 또는 OID
   * @returns 정규화된 commit hash 또는 undefined
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
   * @returns 검증된 전체 commit hash
   */
  private async normalizeRequiredCommit(ref: string, label: string): Promise<string> {
    const hash = await this.resolveOptionalCommit(ref);
    if (!hash) {
      throw new Error(`${label} does not resolve to a commit: ${ref}`);
    }
    return hash;
  }

  /**
   * 계획 준비 후 검증이 실패했을 때 이미 만든 숨김 ref를 가능한 범위에서 정리한다.
   * cleanup 오류가 원래 누락-object 오류를 가리지 않도록 실패를 의도적으로 삼킨다.
   * @param materialized 생성 전이면 undefined, 생성 후면 ref/hash 쌍
   */
  private async releaseFetchedHeadQuietly(
    materialized: MaterializedPullRequestHead | undefined
  ): Promise<void> {
    if (!materialized) {
      return;
    }
    await this.release({
      materializedRef: materialized.ref,
      materializedHead: materialized.hash,
      materializedPreviousHead: materialized.previousHead,
    }).catch(() => false);
  }

  /**
   * fetch 실패 전부터 존재하던 확장 ref를 보존하고, 실패 중 새 값이 기록됐을 때만 원복한다.
   * @param ref fetch destination ref
   * @param previousHead fetch 시작 전 ref가 가리키던 선택 commit
   */
  private async restoreMaterializedRefAfterFailedFetch(
    ref: string,
    previousHead: string | undefined
  ): Promise<void> {
    const current = await this.resolveOptionalCommit(ref);
    if (!current || current === previousHead) {
      return;
    }
    await runGit(
      previousHead
        ? ["update-ref", ref, previousHead, current]
        : ["update-ref", "-d", ref, current],
      this.repoRoot
    ).catch(() => "");
  }
}

/**
 * PR 번호를 확장 전용 숨김 ref path로 변환한다.
 * @param number 양의 GitHub PR 번호
 * @returns 다른 extension ref와 충돌하지 않는 full ref
 */
export function materializedRefForPullRequest(number: number): string {
  return `${MATERIALIZED_PR_REF_PREFIX}/${number}`;
}

/**
 * 긴 commit hash를 오류와 OUTPUT 필드에 적합한 길이로 줄인다.
 * @param hash Git이 반환했거나 GitHub가 제공한 commit OID
 * @returns 사용자가 서로 구분할 수 있는 앞 10자리 hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/**
 * GitError의 stderr/stdout을 보존해 fetch 실패 원인을 한 문자열로 만든다.
 * @param error git fetch 또는 ref 검증에서 발생한 오류
 * @returns 사용자 알림과 OUTPUT 로그에 전달할 원문 중심의 진단 문자열
 */
function gitErrorText(error: unknown): string {
  if (error instanceof GitError) {
    return [error.stderr.trim(), error.stdout.trim(), error.message]
      .filter(Boolean)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
