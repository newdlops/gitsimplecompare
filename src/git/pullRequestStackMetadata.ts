// 로컬 PR stack parent 메타데이터와 layer branch 생명주기를 담당하는 서비스 모듈.
// - 저장소 파일을 만들지 않고 branch.<name>.gscStack* 로컬 Git 설정에 관계를 기록한다.
// - GitHub에 게시하기 전에도 worktree 전체가 같은 stack 관계를 공유할 수 있다.
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { runGit } from "./gitExec";
import type { StackLocalBranch } from "./pullRequestStackModel";
import { WorktreeService, type WorktreeInfo } from "./worktreeService";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";
const PARENT_KEY = "gscStackParent";
const PARENT_HEAD_KEY = "gscStackParentHead";

/** 새 stack layer를 만들 때 필요한 parent와 선택적 worktree 입력 */
export interface CreatePullRequestStackLayerOptions {
  /** 생성할 로컬 branch short name */
  branch: string;
  /** stack에서 바로 아래에 놓일 branch 이름 */
  parentBranch: string;
  /** 새 branch 시작점으로 검증된 parent commit/ref */
  parentRef: string;
  /** 값이 있으면 branch만 만들지 않고 linked worktree도 함께 만든다. */
  worktreePath?: string;
}

/** merged layer 정리 결과. main/current worktree는 자동 제거하지 않고 이유를 반환한다. */
export interface PullRequestStackLayerCleanupResult {
  branch: string;
  removedBranch: boolean;
  removedWorktree?: string;
  skippedReason?: "main-worktree" | "current-worktree";
}

/** 로컬 stack 메타데이터와 layer branch를 다루는 서비스 */
export class PullRequestStackMetadataService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 로컬 branch, upstream tip, stack parent/head, worktree 점유 상태를 한 번에 읽는다.
   * @returns Git Graph 모델과 restack 계획이 공유할 branch 배열
   */
  async listBranches(): Promise<StackLocalBranch[]> {
    const [records, remoteRefs, worktrees] = await Promise.all([
      this.readLocalBranchRecords(),
      this.readRemoteRefHashes(),
      new WorktreeService(this.repoRoot).listWorktrees(),
    ]);
    const worktreeByBranch = new Map(
      worktrees.filter((item) => item.branch).map((item) => [item.branch!, item.path])
    );
    return Promise.all(records.map(async (record) => {
      const [name, hash, upstream, subject] = record.split(FIELD_SEPARATOR);
      const [parentBranch, parentHead] = await Promise.all([
        this.readConfig(name, PARENT_KEY),
        this.readConfig(name, PARENT_HEAD_KEY),
      ]);
      return {
        name,
        hash,
        upstream: upstream || undefined,
        upstreamHash: upstream ? remoteRefs.get(upstream) : undefined,
        subject: subject || undefined,
        parentBranch,
        parentHead,
        worktreePath: worktreeByBranch.get(name),
      };
    }));
  }

  /**
   * child branch의 parent와 그 시점 parent tip을 함께 기록한다.
   * - 현재 메타데이터에 cycle이 있거나 parent가 child 자신이면 저장 전에 중단한다.
   * @param branch 메타데이터를 기록할 로컬 child branch
   * @param parentBranch 바로 아래 parent branch 이름
   * @param parentHead 마지막으로 정렬된 parent commit OID
   */
  async setParent(
    branch: string,
    parentBranch: string,
    parentHead: string
  ): Promise<void> {
    const child = await this.assertLocalBranch(branch);
    const parent = requiredValue(parentBranch, "Stack parent branch is required.");
    const head = await this.resolveCommit(parentHead);
    if (child === parent) {
      throw new Error("A stack layer cannot be its own parent.");
    }
    await this.assertNoCycle(child, parent);
    await runGit(["config", "--local", configKey(child, PARENT_KEY), parent], this.repoRoot);
    await runGit(["config", "--local", configKey(child, PARENT_HEAD_KEY), head], this.repoRoot);
  }

  /**
   * restack이 끝난 layer의 parent tip만 최신 commit으로 갱신한다.
   * @param branch 갱신할 로컬 child branch
   * @param parentHead rebase 결과가 올라간 parent commit OID
   */
  async updateParentHead(branch: string, parentHead: string): Promise<void> {
    const child = await this.assertLocalBranch(branch);
    const head = await this.resolveCommit(parentHead);
    await runGit(["config", "--local", configKey(child, PARENT_HEAD_KEY), head], this.repoRoot);
  }

  /**
   * branch의 stack 관계만 지워 일반 branch로 되돌린다.
   * @param branch 메타데이터를 지울 local branch
   */
  async clearParent(branch: string): Promise<void> {
    const child = requiredValue(branch, "Stack branch is required.");
    await Promise.all([
      this.unsetConfig(child, PARENT_KEY),
      this.unsetConfig(child, PARENT_HEAD_KEY),
    ]);
  }

  /**
   * restack Abort가 작업 전 parent 설정을 값의 유무까지 그대로 복원한다.
   * - 과거 버전이나 수동 설정으로 parentHead가 없던 관계에는 새 값을 임의로 만들지 않는다.
   * @param branch 복원할 로컬 child branch
   * @param parentBranch 작업 전 parent. 없으면 일반 branch 상태로 되돌린다.
   * @param parentHead 작업 전 parent tip. 없으면 해당 config key를 제거한다.
   */
  async restoreParent(
    branch: string,
    parentBranch?: string,
    parentHead?: string
  ): Promise<void> {
    const child = await this.assertLocalBranch(branch);
    if (!parentBranch) {
      await this.clearParent(child);
      return;
    }
    const parent = requiredValue(parentBranch, "Stack parent branch is required.");
    await this.assertNoCycle(child, parent);
    const head = parentHead ? await this.resolveCommit(parentHead) : undefined;
    await runGit(["config", "--local", configKey(child, PARENT_KEY), parent], this.repoRoot);
    if (head) {
      await runGit(["config", "--local", configKey(child, PARENT_HEAD_KEY), head], this.repoRoot);
    } else {
      await this.unsetConfig(child, PARENT_HEAD_KEY);
    }
  }

  /**
   * parent tip에서 새 child branch를 만들고 stack 관계를 원자적으로 최대한 가깝게 기록한다.
   * - worktree 생성 뒤 설정 기록이 실패하면 방금 만든 worktree/branch만 안전하게 정리한다.
   * @param options branch, parent, 시작 ref, 선택적 worktree 경로
   * @returns 생성된 branch의 시작 commit OID
   */
  async createLayer(options: CreatePullRequestStackLayerOptions): Promise<string> {
    const branch = requiredValue(options.branch, "New stack branch is required.");
    const parentBranch = requiredValue(options.parentBranch, "Stack parent branch is required.");
    const worktrees = new WorktreeService(this.repoRoot);
    await worktrees.assertValidBranchName(branch);
    await this.assertBranchMissing(branch);
    const parentHead = await this.resolveCommit(options.parentRef);
    const worktreePath = options.worktreePath
      ? path.resolve(options.worktreePath)
      : undefined;
    let created = false;
    try {
      if (worktreePath) {
        await worktrees.createWorktree({
          worktreePath,
          startPoint: parentHead,
          newBranch: branch,
        });
      } else {
        await runGit(["branch", branch, parentHead], this.repoRoot);
      }
      created = true;
      await this.setParent(branch, parentBranch, parentHead);
      return parentHead;
    } catch (error) {
      if (created) {
        await this.cleanupFailedCreation(branch, worktreePath);
      }
      throw error;
    }
  }

  /**
   * merged layer의 linked worktree와 local branch를 Git 안전 검사에 따라 정리한다.
   * - main/current worktree는 폴더를 닫거나 branch를 전환해야 하므로 건드리지 않는다.
   * - branch 삭제는 `-d`만 사용해 아직 합쳐지지 않은 commit이 있으면 Git이 거부하게 한다.
   * @param branch 정리할 merged local branch
   * @returns 제거 여부와 건너뛴 이유
   */
  async cleanupMergedLayer(branch: string): Promise<PullRequestStackLayerCleanupResult> {
    const name = await this.assertLocalBranch(branch);
    const worktrees = await new WorktreeService(this.repoRoot).listWorktrees();
    const owner = worktrees.find((item) => item.branch === name);
    if (owner?.isMain) {
      return { branch: name, removedBranch: false, skippedReason: "main-worktree" };
    }
    if (owner && await pathsReferToSameDirectory(owner.path, this.repoRoot)) {
      return { branch: name, removedBranch: false, skippedReason: "current-worktree" };
    }
    if (owner) {
      await this.assertCleanWorktree(owner);
      await new WorktreeService(this.repoRoot).removeWorktree(owner.path, false);
    }
    await runGit(["branch", "-d", name], this.repoRoot);
    return {
      branch: name,
      removedBranch: true,
      removedWorktree: owner?.path,
    };
  }

  /**
   * local branch 또는 remote tracking branch 이름을 현재 commit OID로 해석한다.
   * @param branch short branch 또는 임의 commit-ish
   * @returns 검증된 전체 commit OID
   */
  async resolveBranchHead(branch: string): Promise<string> {
    const name = requiredValue(branch, "Stack branch is required.");
    const candidates = [
      `refs/heads/${name}`,
      `refs/remotes/origin/${name}`,
      name,
    ];
    for (const candidate of candidates) {
      const hash = await this.resolveCommit(candidate).catch(() => "");
      if (hash) {
        return hash;
      }
    }
    throw new Error(`Stack parent '${name}' is not available locally.`);
  }

  /** 로컬 branch for-each-ref 출력을 구분자 기반 레코드 배열로 읽는다. */
  private async readLocalBranchRecords(): Promise<string[]> {
    const format = [
      "%(refname:short)",
      "%(objectname)",
      "%(upstream:short)",
      "%(subject)",
    ].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
    const output = await runGit(
      ["for-each-ref", `--format=${format}`, "refs/heads"],
      this.repoRoot
    );
    return output.split(RECORD_SEPARATOR)
      .map((record) => record.replace(/^\r?\n|\r?\n$/g, ""))
      .filter(Boolean);
  }

  /** remote tracking ref 이름별 commit OID map을 읽는다. */
  private async readRemoteRefHashes(): Promise<Map<string, string>> {
    const output = await runGit(
      ["for-each-ref", `--format=%(refname:short)${FIELD_SEPARATOR}%(objectname)${RECORD_SEPARATOR}`, "refs/remotes"],
      this.repoRoot
    );
    return new Map(output.split(RECORD_SEPARATOR).map((record) => {
      const [name, hash] = record.replace(/^\r?\n|\r?\n$/g, "").split(FIELD_SEPARATOR);
      return [name, hash] as const;
    }).filter(([name, hash]) => Boolean(name && hash)));
  }

  /** branch config key 하나를 읽고 없으면 undefined를 반환한다. */
  private async readConfig(branch: string, key: string): Promise<string | undefined> {
    const output = await runGit(
      ["config", "--local", "--get", configKey(branch, key)],
      this.repoRoot
    ).catch(() => "");
    return output.trim() || undefined;
  }

  /** 저장된 parent를 따라가며 새 관계가 cycle을 만들지 검사한다. */
  private async assertNoCycle(branch: string, parentBranch: string): Promise<void> {
    const byName = new Map((await this.listBranches()).map((item) => [item.name, item]));
    const visited = new Set<string>([branch]);
    let current: string | undefined = parentBranch;
    while (current) {
      if (visited.has(current)) {
        throw new Error(`Stack parent '${parentBranch}' would create a cycle.`);
      }
      visited.add(current);
      current = byName.get(current)?.parentBranch;
    }
  }

  /** branch가 존재하는지 확인하고 정규화된 이름을 반환한다. */
  private async assertLocalBranch(branch: string): Promise<string> {
    const name = requiredValue(branch, "Stack branch is required.");
    await runGit(["show-ref", "--verify", `refs/heads/${name}`], this.repoRoot);
    return name;
  }

  /** 새 branch 이름이 아직 사용되지 않았는지 확인한다. */
  private async assertBranchMissing(branch: string): Promise<void> {
    const exists = await runGit(
      ["show-ref", "--verify", `refs/heads/${branch}`],
      this.repoRoot
    ).then(() => true, () => false);
    if (exists) {
      throw new Error(`Branch '${branch}' already exists.`);
    }
  }

  /** commit-ish를 전체 commit OID로 정규화한다. */
  private async resolveCommit(ref: string): Promise<string> {
    const value = requiredValue(ref, "Stack commit is required.");
    const hash = (await runGit(
      ["rev-parse", "--verify", `${value}^{commit}`],
      this.repoRoot
    )).trim();
    if (!hash) {
      throw new Error(`Commit '${value}' is not available.`);
    }
    return hash;
  }

  /** failed create가 남긴 방금 생성된 worktree와 branch만 안전하게 되돌린다. */
  private async cleanupFailedCreation(branch: string, worktreePath?: string): Promise<void> {
    if (worktreePath) {
      await new WorktreeService(this.repoRoot)
        .removeWorktree(worktreePath, false)
        .catch(() => undefined);
    }
    await runGit(["branch", "-d", branch], this.repoRoot).catch(() => undefined);
  }

  /** 삭제할 linked worktree가 clean인지 확인한다. */
  private async assertCleanWorktree(worktree: WorktreeInfo): Promise<void> {
    const status = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      worktree.path
    );
    if (status) {
      throw new Error(`Worktree '${worktree.path}' has local changes and was not removed.`);
    }
  }

  /** config key가 없어도 성공하도록 local 설정을 지운다. */
  private async unsetConfig(branch: string, key: string): Promise<void> {
    await runGit(
      ["config", "--local", "--unset-all", configKey(branch, key)],
      this.repoRoot
    ).catch(() => undefined);
  }
}

/** branch subsection의 stack 설정 key를 만든다. */
function configKey(branch: string, key: string): string {
  return `branch.${branch}.${key}`;
}

/** 필수 문자열을 trim하고 빈 값이면 호출부 문맥의 오류를 던진다. */
function requiredValue(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

/** macOS의 /var→/private/var 같은 별칭까지 해소해 두 worktree 경로가 같은지 비교한다. */
async function pathsReferToSameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(path.resolve(value)).catch(() => path.resolve(value));
  const [leftPath, rightPath] = await Promise.all([canonical(left), canonical(right)]);
  return leftPath === rightPath;
}
