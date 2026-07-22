// merged PR 뒤의 child를 새 root로 승격시키는 Advance 작업을 담당하는 서비스 모듈.
// - GitHub merge 상태와 실제 원격 base tip을 확인한 뒤 restack 계획만 만들고 실행은 공용 executor에 맡긴다.
// - restack 완료 뒤 Submit/Sync와 merged branch/worktree 안전 정리를 조립할 API를 제공한다.
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import {
  PullRequestStackMetadataService,
  type PullRequestStackLayerCleanupResult,
} from "./pullRequestStackMetadata";
import {
  PullRequestStackRestackService,
  type PullRequestStackParentOverride,
  type PullRequestStackRestackPlan,
  type PullRequestStackRestackPostAction,
} from "./pullRequestStackRestack";
import {
  PullRequestStackSubmitService,
  type PullRequestStackSubmitResult,
} from "./pullRequestStackSubmitService";
import { WorktreeService } from "./worktreeService";

interface AdvancePullRequestInfo {
  number: number;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

/** Advance preview와 restack 실행에 함께 전달할 준비 결과 */
export interface PullRequestStackAdvancePlan {
  mergedPullRequest: AdvancePullRequestInfo;
  mergedBranch: string;
  previousParentBranch: string;
  promotedBranches: string[];
  remoteTargetHash: string;
  restack: PullRequestStackRestackPlan;
}

/** Advance restack 뒤 PR base/push 동기화 결과 */
export interface PullRequestStackAdvanceSyncResult {
  mergedBranch: string;
  promotedBranches: string[];
  submittedStacks: PullRequestStackSubmitResult[];
}

/** merged branch/worktree 정리 확인창에 보여 줄 read-only 안전 진단 */
export interface PullRequestStackCleanupPreview {
  branch: string;
  branchExists: boolean;
  worktreePath?: string;
  mainWorktree: boolean;
  currentWorktree: boolean;
  clean: boolean;
  canAutoCleanup: boolean;
  reason?: string;
}

/** Command Palette에서 Advance 대상을 고를 때 사용할 merged layer 후보 */
export interface PullRequestStackAdvanceCandidate {
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  baseBranch: string;
  childBranches: string[];
}

/** merged layer 승격, 동기화, 선택적 정리를 수행하는 서비스 */
export class PullRequestStackAdvanceService {
  private readonly metadata: PullRequestStackMetadataService;

  constructor(public readonly repoRoot: string) {
    this.metadata = new PullRequestStackMetadataService(repoRoot);
  }

  /**
   * 로컬 child를 가진 layer 중 GitHub 상태가 MERGED인 Advance 후보를 찾는다.
   * - 개별 gh 조회 실패는 다른 후보 탐색을 막지 않고 해당 branch만 제외한다.
   * @returns merged PR 번호/base/direct child가 붙은 후보 목록
   */
  async listCandidates(): Promise<PullRequestStackAdvanceCandidate[]> {
    const branches = await this.metadata.listBranches();
    const childrenByParent = new Map<string, string[]>();
    for (const branch of branches) {
      if (!branch.parentBranch) continue;
      const children = childrenByParent.get(branch.parentBranch) || [];
      children.push(branch.name);
      children.sort((left, right) => left.localeCompare(right));
      childrenByParent.set(branch.parentBranch, children);
    }
    const candidates: PullRequestStackAdvanceCandidate[] = [];
    for (const [branch, childBranches] of childrenByParent) {
      const pullRequest = await this.pullRequestForBranch(branch).catch(() => undefined);
      if (!pullRequest || pullRequest.state.toUpperCase() !== "MERGED") continue;
      candidates.push({
        branch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        baseBranch: pullRequest.baseRefName,
        childBranches,
      });
    }
    return candidates.sort((left, right) =>
      left.pullRequestNumber - right.pullRequestNumber
    );
  }

  /**
   * merged layer의 direct child를 이전 base 위로 옮기는 연쇄 restack preview를 만든다.
   * - base tip은 로컬 main이 아니라 fetch한 실제 원격 branch OID를 사용해 merge 결과를 포함한다.
   * - 여러 direct child가 있으면 각 subtree를 같은 operation 안에서 부모 우선으로 처리한다.
   * @param mergedBranch GitHub에서 merge된 stack layer branch
   * @param remote base branch를 fetch하고 이후 child를 push할 Git remote
   * @returns 사용자 확인에 필요한 승격 관계와 공용 restack plan
   */
  async createPlan(
    mergedBranch: string,
    remote: string
  ): Promise<PullRequestStackAdvancePlan> {
    const branchName = mergedBranch.trim();
    if (!branchName) {
      throw new Error("Merged stack branch is required.");
    }
    await this.assertRemote(remote);
    const [pullRequest, branches] = await Promise.all([
      this.pullRequestForBranch(branchName),
      this.metadata.listBranches(),
    ]);
    if (pullRequest.state.toUpperCase() !== "MERGED") {
      throw new Error(`Pull request #${pullRequest.number} for '${branchName}' is not merged.`);
    }
    const merged = branches.find((branch) => branch.name === branchName);
    const previousParentBranch = merged?.parentBranch || pullRequest.baseRefName;
    if (!previousParentBranch) {
      throw new Error(`The previous base for '${branchName}' could not be determined.`);
    }
    const children = branches.filter((branch) => branch.parentBranch === branchName);
    if (!children.length) {
      throw new Error(`Merged layer '${branchName}' has no local child to promote.`);
    }
    const remoteTargetHash = await this.fetchRemoteBranch(remote, previousParentBranch);
    const mergedHead = merged?.hash
      || await this.resolveCommit(`refs/remotes/${remote}/${branchName}`)
        .catch(() => "");
    const overrides: Record<string, PullRequestStackParentOverride> = {};
    for (const child of children) {
      const oldParentHead = child.parentHead || mergedHead;
      if (!oldParentHead) {
        throw new Error(`The old parent boundary for '${child.name}' is unavailable.`);
      }
      overrides[child.name] = {
        parentBranch: previousParentBranch,
        oldParentHead,
        parentTargetHash: remoteTargetHash,
      };
    }
    const postAction: PullRequestStackRestackPostAction = {
      kind: "advance",
      mergedBranch: branchName,
      promotedBranches: children.map((branch) => branch.name),
      remote,
    };
    const restack = await new PullRequestStackRestackService(this.repoRoot)
      .createPlan(postAction.promotedBranches, overrides, postAction);
    return {
      mergedPullRequest: pullRequest,
      mergedBranch: branchName,
      previousParentBranch,
      promotedBranches: postAction.promotedBranches,
      remoteTargetHash,
      restack,
    };
  }

  /**
   * Advance restack이 완료된 promoted subtree들을 push하고 PR base/body를 동기화한다.
   * - direct child가 여러 개면 서로 다른 root stack이므로 각각 한 번씩 Submit/Sync한다.
   * @param postAction pending restack state에 보존된 Advance 후속 정보
   * @param draft 새 PR이 필요한 예외 상황에서 draft로 만들지 여부
   * @returns 각 promoted stack의 push/PR 결과
   */
  async syncPromotedStacks(
    postAction: PullRequestStackRestackPostAction,
    draft = true
  ): Promise<PullRequestStackAdvanceSyncResult> {
    if (postAction.kind !== "advance") {
      throw new Error("Unsupported stack restack post action.");
    }
    const submittedStacks: PullRequestStackSubmitResult[] = [];
    for (const branch of postAction.promotedBranches) {
      submittedStacks.push(await new PullRequestStackSubmitService(this.repoRoot).submit({
        branch,
        remote: postAction.remote,
        draft,
      }));
    }
    return {
      mergedBranch: postAction.mergedBranch,
      promotedBranches: [...postAction.promotedBranches],
      submittedStacks,
    };
  }

  /**
   * 사용자가 승인한 merged branch/worktree 정리를 Git의 clean/merged 검사 아래 수행한다.
   * @param mergedBranch 정리할 merged local branch
   * @returns 실제 제거 또는 main/current worktree 건너뜀 결과
   */
  async cleanupMergedLayer(
    mergedBranch: string
  ): Promise<PullRequestStackLayerCleanupResult> {
    return this.metadata.cleanupMergedLayer(mergedBranch);
  }

  /**
   * merged layer 정리 전에 branch 점유 worktree와 변경 상태를 읽기만 한다.
   * - UI는 canAutoCleanup이 false면 삭제 확인을 제시하지 않고 사용자가 정리할 이유를 안내한다.
   * @param mergedBranch 진단할 merged local branch
   * @returns branch/worktree 존재와 clean/main/current 상태
   */
  async getCleanupPreview(
    mergedBranch: string
  ): Promise<PullRequestStackCleanupPreview> {
    const branch = mergedBranch.trim();
    const branchExists = await runGit(
      ["show-ref", "--verify", `refs/heads/${branch}`],
      this.repoRoot
    ).then(() => true, () => false);
    if (!branchExists) {
      return {
        branch,
        branchExists: false,
        mainWorktree: false,
        currentWorktree: false,
        clean: true,
        canAutoCleanup: false,
        reason: "The local merged branch no longer exists.",
      };
    }
    const worktrees = await new WorktreeService(this.repoRoot).listWorktrees();
    const owner = worktrees.find((item) => item.branch === branch);
    const currentWorktree = Boolean(
      owner && await pathsReferToSameDirectory(owner.path, this.repoRoot)
    );
    const clean = owner
      ? !(await runGit(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          owner.path
        ))
      : true;
    const reason = owner?.isMain
      ? "The branch is checked out in the main worktree. Switch branches first."
      : currentWorktree
        ? "The branch is checked out in the current worktree. Switch branches first."
        : !clean
          ? "The linked worktree has local changes."
          : undefined;
    return {
      branch,
      branchExists,
      worktreePath: owner?.path,
      mainWorktree: Boolean(owner?.isMain),
      currentWorktree,
      clean,
      canAutoCleanup: !owner?.isMain && !currentWorktree && clean,
      reason,
    };
  }

  /** GitHub에서 branch와 연결된 최신 PR의 merge 상태와 이전 base를 읽는다. */
  private async pullRequestForBranch(branch: string): Promise<AdvancePullRequestInfo> {
    const remoteBranch = await this.remoteBranchName(branch);
    const output = await runGh([
      "pr",
      "view",
      remoteBranch,
      "--json",
      "number,state,headRefName,baseRefName,url",
    ], this.repoRoot);
    const value = JSON.parse(output) as Partial<AdvancePullRequestInfo>;
    if (!value.number || !value.headRefName || !value.baseRefName) {
      throw new Error(`Pull request for '${remoteBranch}' could not be loaded.`);
    }
    return {
      number: Number(value.number),
      state: value.state || "",
      headRefName: value.headRefName,
      baseRefName: value.baseRefName,
      url: value.url || "",
    };
  }

  /** local branch upstream에서 GitHub PR head로 사용하는 remote 내부 branch 이름을 구한다. */
  private async remoteBranchName(branch: string): Promise<string> {
    const upstream = (await runGit([
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${branch}`,
    ], this.repoRoot)).trim();
    const slash = upstream.indexOf("/");
    return slash >= 0 ? upstream.slice(slash + 1) : branch;
  }

  /** remote base branch를 fetch해 rebase가 사용할 object와 정확한 FETCH_HEAD OID를 확보한다. */
  private async fetchRemoteBranch(remote: string, branch: string): Promise<string> {
    await runGit(
      ["fetch", "--no-tags", remote, `refs/heads/${branch}`],
      this.repoRoot
    );
    return this.resolveCommit("FETCH_HEAD");
  }

  /** 요청 remote가 현재 저장소에 등록돼 있는지 확인한다. */
  private async assertRemote(remote: string): Promise<void> {
    const remotes = (await runGit(["remote"], this.repoRoot))
      .split(/\r?\n/).filter(Boolean);
    if (!remote.trim() || !remotes.includes(remote.trim())) {
      throw new Error(`Git remote '${remote}' is not available.`);
    }
  }

  /** commit-ish를 현재 저장소의 전체 commit OID로 정규화한다. */
  private async resolveCommit(ref: string): Promise<string> {
    return (await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    )).trim();
  }
}

/** worktree가 현재 서비스 경로와 같은 디렉터리인지 symlink/시스템 별칭을 해소해 비교한다. */
async function pathsReferToSameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(path.resolve(value)).catch(() => path.resolve(value));
  const [leftPath, rightPath] = await Promise.all([canonical(left), canonical(right)]);
  return leftPath === rightPath;
}
