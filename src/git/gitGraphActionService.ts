// Graph 웹뷰에서 요청하는 checkout/branch/tag/sync/commit 변경 명령을 모은 서비스 모듈.
// - 읽기 중심인 GitLogService와 쓰기 명령을 분리해 캐시 무효화 경계를 한곳에서 관리한다.
// - 실제 Git 실행은 공유 실행기(runGit)와 push 전용 서비스만 사용한다.
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { invalidateRemoteTagCache } from "./gitTagService";
import { readGraphLocalBranchSnapshot } from "./graphLocalBranches";
import { isUnpushedLocalHead, localNameFromRemoteRef, splitRemoteRef } from "./gitRefNames";
import {
  ForcePushMode,
  PushCurrentPlan,
  PushCurrentResult,
  forcePushCurrent,
  pushCurrentWithAutoUpstream,
} from "./pushService";

const FIELD_SEPARATOR = "\x1f";

/** 커밋 revert가 완료됐거나 충돌 해결 단계에 진입했음을 표현하는 결과다. */
export type RevertCommitResult =
  | {
      status: "reverted";
      branch: string;
      targetHash: string;
      beforeHead: string;
      afterHead: string;
    }
  | {
      status: "conflicts";
      branch: string;
      targetHash: string;
      beforeHead: string;
    };

/** Graph가 제공하는 Git 변경 액션과 후속 캐시 무효화를 한 책임으로 묶는다. */
export class GitGraphActionService {
  /**
   * 저장소와 변경 직후 실행할 캐시 무효화 함수를 보관한다.
   * @param repoRoot Git 명령을 실행할 저장소 루트
   * @param invalidateRefs 브랜치/커밋 ref가 바뀐 뒤 조회 캐시를 비우는 함수
   */
  constructor(
    private readonly repoRoot: string,
    private readonly invalidateRefs: () => void
  ) {}

  /**
   * 선택한 로컬 브랜치로 전환하고 성공 시 ref 캐시를 비운다.
   * @param branchName 전환할 로컬 브랜치 이름
   * @param merge 작업트리 변경을 3-way merge하며 전환할지 여부
   */
  async checkoutLocalBranch(branchName: string, merge = false): Promise<void> {
    await this.ensureCheckoutAllowed();
    try {
      await runGit(["switch", ...(merge ? ["--merge"] : []), branchName], this.repoRoot);
    } finally {
      // --merge checkout은 충돌로 실패를 보고해도 HEAD/index를 바꿀 수 있어 실패 경로도 무효화한다.
      this.invalidateRefs();
    }
  }

  /**
   * 원격 브랜치를 추적하는 같은 이름의 로컬 브랜치를 만들고 전환한다.
   * @param remoteBranch checkout할 원격 브랜치 short name
   * @param merge 작업트리 변경을 3-way merge하며 전환할지 여부
   * @returns 생성하고 전환한 로컬 브랜치 이름
   */
  async checkoutRemoteBranchAsLocal(remoteBranch: string, merge = false): Promise<string> {
    await this.ensureCheckoutAllowed();
    const localName = localNameFromRemoteRef(remoteBranch);
    try {
      await runGit(
        ["switch", ...(merge ? ["--merge"] : []), "-c", localName, "--track", remoteBranch],
        this.repoRoot
      );
    } finally {
      this.invalidateRefs();
    }
    return localName;
  }

  /**
   * 지정 커밋으로 detached HEAD 전환을 수행한다.
   * @param hash 전환할 커밋 해시
   * @param merge 로컬 변경을 3-way merge하며 전환할지 여부
   */
  async checkoutCommitDetached(hash: string, merge = false): Promise<void> {
    await this.ensureCheckoutAllowed();
    try {
      await runGit(["switch", ...(merge ? ["--merge"] : []), "--detach", hash], this.repoRoot);
    } finally {
      this.invalidateRefs();
    }
  }

  /**
   * rebase 중 checkout이 저장소 상태를 더 복잡하게 만들지 않도록 사전 차단한다.
   * @returns checkout 가능하면 완료되고, 불가능하면 사용자 표시용 오류를 던진다.
   */
  async ensureCheckoutAllowed(): Promise<void> {
    if (await detectOperation(this.repoRoot) === "rebase") {
      throw new Error("Cannot checkout while a rebase is in progress. Continue or abort the rebase first.");
    }
  }

  /** 지정 커밋을 시작점으로 새 로컬 브랜치를 만들고 ref 캐시를 비운다. */
  async createBranchAt(name: string, startPoint: string): Promise<void> {
    await runGit(["branch", name, startPoint], this.repoRoot);
    this.invalidateRefs();
  }

  /** 로컬 브랜치를 일반 삭제하거나 force 삭제하고 ref 캐시를 비운다. */
  async deleteLocalBranch(name: string, force = false): Promise<void> {
    await runGit(["branch", force ? "-D" : "-d", name], this.repoRoot);
    this.invalidateRefs();
  }

  /** remote/name 형식의 원격 브랜치를 원격 저장소에서 삭제한다. */
  async deleteRemoteBranch(ref: string): Promise<void> {
    const parsed = splitRemoteRef(ref);
    await runGit(["push", parsed.remote, "--delete", parsed.branch], this.repoRoot);
    this.invalidateRefs();
  }

  /** Graph 액션 picker에서 사용할 정상 로컬·원격 브랜치 목록을 반환한다. */
  async getBranches(): Promise<{ name: string; kind: "local" | "remote" }[]> {
    const out = await runGit(
      ["for-each-ref", "--format=%(refname:short)\x1f%(refname)", "refs/heads", "refs/remotes"],
      this.repoRoot
    );
    return out.split("\n").filter((line) => line.trim()).flatMap((line) => {
      const [name, full] = line.split(FIELD_SEPARATOR);
      if (!name || name.endsWith("/HEAD")) return [];
      return [{ name, kind: full.startsWith("refs/remotes/") ? "remote" as const : "local" as const }];
    });
  }

  /** 지정 커밋에 lightweight tag를 만든다. */
  async createTag(name: string, target: string): Promise<void> {
    await runGit(["tag", name, target], this.repoRoot);
  }

  /** 지정한 로컬 tag를 삭제한다. */
  async deleteTag(name: string): Promise<void> {
    await runGit(["tag", "-d", name], this.repoRoot);
  }

  /** 원격 tag를 삭제하고 해당 원격의 tag 조회 캐시만 비운다. */
  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `:refs/tags/${name}`], this.repoRoot);
    invalidateRemoteTagCache(this.repoRoot, remote);
  }

  /** 로컬 tag 목록을 Git 정렬 순서대로 반환한다. */
  async getTags(): Promise<string[]> {
    const out = await runGit(["tag", "--list"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 현재 저장소에 등록된 원격 저장소 이름을 반환한다. */
  async getRemotes(): Promise<string[]> {
    const out = await runGit(["remote"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 지정 tag를 원격으로 push하고 해당 원격의 tag 조회 캐시를 비운다. */
  async pushTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `refs/tags/${name}`], this.repoRoot);
    invalidateRemoteTagCache(this.repoRoot, remote);
  }

  /** 모든 원격 브랜치를 fetch/prune하고 변경된 ref 조회 캐시를 비운다. */
  async fetchAll(): Promise<void> {
    await runGit(["fetch", "--all", "--prune"], this.repoRoot);
    this.invalidateRefs();
  }

  /** 로컬 tag ref만 원격 상태와 동기화한다. */
  async fetchTags(): Promise<void> {
    await runGit(["fetch", "--tags"], this.repoRoot);
  }

  /** 현재 브랜치를 fast-forward 방식으로 pull하고 ref 조회 캐시를 비운다. */
  async pullCurrent(): Promise<void> {
    await runGit(["pull", "--ff-only"], this.repoRoot);
    this.invalidateRefs();
  }

  /** upstream 자동 설정 계획에 따라 현재 브랜치를 push하고 ref 캐시를 비운다. */
  async pushCurrent(plan?: PushCurrentPlan): Promise<PushCurrentResult> {
    const result = await pushCurrentWithAutoUpstream(this.repoRoot, plan);
    this.invalidateRefs();
    return result;
  }

  /** 사용자가 선택한 force 정책으로 현재 브랜치를 push하고 ref 캐시를 비운다. */
  async forcePushCurrent(mode: ForcePushMode, plan?: PushCurrentPlan): Promise<PushCurrentResult> {
    const result = await forcePushCurrent(this.repoRoot, mode, plan);
    this.invalidateRefs();
    return result;
  }

  /** 지정 커밋을 현재 브랜치에 cherry-pick하고 ref 캐시를 비운다. */
  async cherryPick(hash: string): Promise<void> {
    await runGit(["cherry-pick", hash], this.repoRoot);
    this.invalidateRefs();
  }

  /**
   * 현재 로컬 브랜치에 포함된 커밋을 revert하며 충돌 진입도 정상 결과로 구분한다.
   * @param hash revert 대상 커밋 해시
   * @param mainline merge commit에서 기준으로 삼을 부모 번호(1부터 시작)
   * @returns 새 HEAD 정보 또는 충돌 해결에 필요한 이전 HEAD 정보
   */
  async revertCommitOnCurrentBranch(hash: string, mainline?: number): Promise<RevertCommitResult> {
    if (isVirtualCommitHash(hash)) throw new Error("Virtual commits cannot be reverted.");
    await this.assertReadyForRevert();
    const branch = (await readGraphLocalBranchSnapshot(this.repoRoot)).branches.find((item) => item.current);
    if (!branch) throw new Error("Only commits on the current local branch can be reverted.");
    const targetHash = await this.normalizeCommit(hash);
    if (!(await this.isAncestor(targetHash, "HEAD"))) {
      throw new Error("Only commits on the current local branch can be reverted.");
    }
    await this.assertValidRevertMainline(targetHash, mainline);
    const beforeHead = await this.getHeadHash();
    if (!beforeHead) throw new Error("Cannot revert because HEAD is unavailable.");
    try {
      await runGit(
        ["revert", "--no-edit", ...(mainline ? ["-m", String(mainline)] : []), targetHash],
        this.repoRoot,
        { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } }
      );
    } catch (error) {
      this.invalidateRefs();
      if ((await detectOperation(this.repoRoot).catch(() => "none")) === "revert" && await this.hasUnmergedChanges()) {
        return { status: "conflicts", branch: branch.name, targetHash, beforeHead };
      }
      throw error;
    }
    const afterHead = await this.getHeadHash();
    if (!afterHead) throw new Error("Revert completed, but the new HEAD could not be read.");
    this.invalidateRefs();
    return { status: "reverted", branch: branch.name, targetHash, beforeHead, afterHead };
  }

  /**
   * 현재 브랜치의 최신 unpushed HEAD를 soft reset해 변경 내용을 staged 상태로 되돌린다.
   * @param hash 사용자가 되돌리려는 HEAD 커밋 해시
   */
  async undoLastUnpushedCommit(hash: string): Promise<void> {
    const branch = (await readGraphLocalBranchSnapshot(this.repoRoot)).branches.find((item) => item.current);
    if (!branch || branch.hash !== hash || !isUnpushedLocalHead(branch)) {
      throw new Error(`Commit is not an unpushed local HEAD: ${hash}`);
    }
    await runGit(["reset", "--soft", "HEAD~1"], this.repoRoot);
    this.invalidateRefs();
  }

  /** 진행 중인 Git 작업이나 unmerged 파일이 없어 revert를 안전하게 시작할 수 있는지 검증한다. */
  private async assertReadyForRevert(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") throw new Error(`Cannot revert while ${operation} is in progress.`);
    if (await this.hasUnmergedChanges()) throw new Error("Resolve unmerged files before reverting a commit.");
  }

  /** merge commit revert의 mainline 부모 번호가 실제 부모 범위 안인지 검증한다. */
  private async assertValidRevertMainline(hash: string, mainline?: number): Promise<void> {
    const parents = await this.getCommitParents(hash);
    if (parents.length <= 1) return;
    if (!Number.isInteger(mainline) || !mainline || mainline < 1 || mainline > parents.length) {
      throw new Error("Reverting a merge commit requires a mainline parent.");
    }
  }

  /** 지정 커밋의 부모 해시를 읽어 merge commit의 부모 수와 순서를 보존한다. */
  private async getCommitParents(hash: string): Promise<string[]> {
    const out = await runGit(["show", "-s", "--pretty=%P", hash], this.repoRoot);
    return out.trim().split(/\s+/).filter(Boolean);
  }

  /** ancestor가 target의 조상인지 Git의 merge-base 판정으로 확인한다. */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    try {
      await runGit(["merge-base", "--is-ancestor", ancestor, target], this.repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /** 충돌 해결이 필요한 unmerged 파일이 하나라도 남아 있는지 확인한다. */
  private async hasUnmergedChanges(): Promise<boolean> {
    const out = await runGit(["diff", "--name-only", "--diff-filter=U"], this.repoRoot);
    return out.trim().length > 0;
  }

  /** 입력 ref를 실제 commit으로 검증하고 전체 해시로 정규화한다. */
  private async normalizeCommit(hash: string): Promise<string> {
    return (await runGit(["rev-parse", "--verify", `${hash}^{commit}`], this.repoRoot)).trim();
  }

  /** 아직 커밋이 없는 저장소를 허용하면서 현재 HEAD 해시를 반환한다. */
  private async getHeadHash(): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    } catch {
      return undefined;
    }
  }
}

/** Graph 전용 가상 커밋 해시는 실제 Git 변경 명령의 대상으로 사용할 수 없음을 판정한다. */
function isVirtualCommitHash(hash: string): boolean {
  return hash === "__gsc_virtual_ongoing__" || hash === "__gsc_virtual_staged__";
}
