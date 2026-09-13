// 모든 원격의 실제 heads와 로컬 브랜치를 비교하고 사용자가 선택한 로컬 ref만 정리한다.
// - remote-tracking 캐시나 upstream의 gone 표시는 원격 존재 여부의 근거로 사용하지 않는다.
// - 삭제 직전 재조회와 Git 자체의 worktree/merge 검사를 함께 사용한다.
import { createHash } from "node:crypto";
import { GitError, runGit, type RunGitOptions } from "./gitExec";
import { invalidateGitBranchListCaches } from "./gitBranchListCache";
import { parseWorktreePorcelain } from "./worktreeService";

/** 선택창과 삭제 재검증이 공유하는 로컬 브랜치의 정확한 tip 스냅샷이다. */
export interface StaleBranch {
  name: string;
  hash: string;
  subject: string;
  /** 현재 HEAD에 도달 가능한 브랜치인지 나타내며, 오래된 upstream 캐시는 신뢰하지 않는다. */
  merged: boolean;
  /** 현재 또는 다른 worktree에서 사용 중이면 삭제 선택에서 제외한다. */
  inUse: boolean;
}

/** 원격 이름이 아닌 로컬 브랜치를 기준으로 표시할 전체 현황 한 행이다. */
export interface InspectedLocalBranch extends StaleBranch {
  /** 이 저장소/worktree의 현재 체크아웃 브랜치인지 나타낸다. */
  current: boolean;
  /** 원격이 없으면 stale로 단정하지 않고 확인할 기준이 없음을 표시한다. */
  remoteState: "present" | "absent" | "unconfigured";
  /** 정확히 같은 브랜치 이름을 가진 실제 원격의 이름만 보관한다. */
  matchingRemotes: string[];
  /** 사용 중인 브랜치를 목록에서 숨기지 않고 보호 이유와 위치를 설명한다. */
  worktreePaths: string[];
}

/** 한 저장소와 원격 설정에 고정된 정리 후보 목록이다. */
export interface StaleBranchInspection {
  repoRoot: string;
  remotes: string[];
  /** URL 등 원격 설정 원문을 UI/로그에 노출하지 않고 설정 변경만 검출한다. */
  remoteConfigHash: string;
  /** 원격 존재 여부와 관계없이 모든 정상 로컬 브랜치를 이름순으로 유지한다. */
  localBranches: InspectedLocalBranch[];
  /** 삭제 서비스가 재검증할 stale 후보만 분리한다. 사용 중인 후보도 보호 상태로 남는다. */
  branches: StaleBranch[];
}

/** 일부 브랜치가 바뀌거나 삭제에 실패해도 나머지 처리 결과를 보존한다. */
export interface StaleBranchCleanupResult {
  deleted: StaleBranch[];
  unmerged: StaleBranch[];
  skipped: { branch: StaleBranch; reason: "changed" | "inUse" | "notStale" | "failed"; message?: string }[];
}

/** 원격 조회 취소를 정상적인 사용자 취소로 구별한다. */
export class StaleBranchCleanupCancelledError extends Error {
  /** 오류 알림 대신 취소 로그를 남기도록 고유 타입을 만든다. */
  constructor() { super("Stale branch cleanup cancelled."); }
}

/** 원격 하나라도 읽지 못했을 때 원격 이름과 원본 실패를 보존한다. */
export class StaleBranchRemoteError extends Error {
  /** @param remote 조회 실패한 원격 이름이며 URL이나 인증 값은 담지 않는다. */
  constructor(public readonly remote: string, cause: unknown) {
    super(`Could not inspect remote '${remote}'.`, { cause });
  }
}

/** 실행기를 주입해 Git 경합과 원격 실패를 실제 Git 또는 결정적인 대역으로 검증한다. */
export type StaleBranchGitRunner = (args: string[], cwd: string, options?: RunGitOptions) => Promise<string>;

/** stale 판별과 로컬 브랜치 삭제를 VS Code UI와 독립적으로 제공하는 서비스다. */
export class StaleBranchService {
  /** @param repoRoot 선택부터 삭제까지 유지할 저장소 @param git 공유 Git 실행기 */
  constructor(public readonly repoRoot: string, private readonly git: StaleBranchGitRunner = runGit) {}

  /**
   * 모든 로컬 브랜치의 원격 존재 여부를 읽고 stale 후보를 별도로 분리한다.
   * - 실제 원격을 읽으므로 fetch하지 않은 브랜치와 삭제 뒤 남은 tracking ref도 정확히 처리한다.
   * @param signal 진행 알림의 취소 신호
   * @returns 전체 로컬 현황과 보호 상태를 포함한 stale 후보. 원격이 없으면 후보만 비운다.
   */
  async inspect(signal?: AbortSignal): Promise<StaleBranchInspection> {
    checkCancelled(signal);
    const before = await this.remoteConfiguration(signal);
    const inspection: StaleBranchInspection = { repoRoot: this.repoRoot, ...before, localBranches: [], branches: [] };
    const remoteNames = new Map<string, string[]>();
    // 원격 수가 많아도 Git/SSH 프로세스는 한 번에 최대 네 개만 만든다.
    for (let index = 0; index < before.remotes.length; index += 4) {
      const results = await Promise.allSettled(before.remotes.slice(index, index + 4).map(async remote => {
        const output = await this.readRemote(remote, signal);
        for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
          if (!line) continue;
          const match = /^([a-f\d]{40}|[a-f\d]{64})\trefs\/heads\/(.+)$/.exec(line);
          if (!match) throw new StaleBranchRemoteError(remote, new Error("Invalid remote branch response."));
          const matches = remoteNames.get(match[2]) ?? [];
          matches.push(remote);
          remoteNames.set(match[2], matches);
        }
      }));
      checkCancelled(signal);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    const [local, worktrees, after] = await Promise.all([
      this.git(["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)%00%(HEAD)%00%(subject)", "refs/heads/"], this.repoRoot, { signal }),
      this.git(["worktree", "list", "--porcelain"], this.repoRoot, { signal }),
      this.remoteConfiguration(signal),
    ]);
    checkCancelled(signal);
    if (before.remoteConfigHash !== after.remoteConfigHash) throw new Error("Remote settings changed. Run stale branch cleanup again.");
    const worktreeList = parseWorktreePorcelain(worktrees);
    const localBranches: InspectedLocalBranch[] = local.split("\n").flatMap(line => {
      if (!line) return [];
      const [ref, hash, symref, head, ...subject] = line.split("\0");
      if (!ref.startsWith("refs/heads/") || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(hash)) throw new Error("Invalid local branch response.");
      const name = ref.slice("refs/heads/".length);
      if (symref) return [];
      const matchingRemotes = [...new Set(remoteNames.get(name))].sort();
      const worktreePaths = worktreeList.filter(worktree => worktree.branchRef === ref).map(worktree => worktree.path);
      return [{ name, hash, subject: subject.join("\0"), inUse: head === "*" || worktreePaths.length > 0,
        current: head === "*", merged: false, matchingRemotes, worktreePaths,
        remoteState: !before.remotes.length ? "unconfigured" as const
          : matchingRemotes.length ? "present" as const : "absent" as const }];
    });
    if (localBranches.length) {
      // HEAD가 없거나 손상됐으면 잘못된 병합 판정으로 후보를 내보내지 않고 Git 오류를 전달한다.
      const merged = new Set((await this.git(["for-each-ref", "--merged=HEAD", "--format=%(refname)", "refs/heads/"], this.repoRoot, { signal })).trim().split("\n"));
      for (const branch of localBranches) branch.merged = merged.has(`refs/heads/${branch.name}`);
    }
    return { ...inspection, localBranches, branches: localBranches.filter(branch => branch.remoteState === "absent") };
  }

  /**
   * 표시했던 선택 행을 다시 조회한 원격·worktree·tip과 비교한 뒤 삭제한다.
   * @param inspection 확인 화면에서 승인한 저장소와 후보 목록
   * @param names 선택한 로컬 브랜치 이름만 담은 배열
   * @param force 미병합 커밋 손실에 대한 추가 확인을 받은 경우만 true
   * @returns 삭제 완료·추가 확인 필요·상태 변경이나 실패로 보존한 브랜치의 내역
   */
  async cleanup(inspection: StaleBranchInspection, names: readonly string[], force = false): Promise<StaleBranchCleanupResult> {
    if (inspection.repoRoot !== this.repoRoot) throw new Error("The selected repository changed. Run stale branch cleanup again.");
    const selected = [...new Set(names)].map(name => {
      const branch = inspection.branches.find(candidate => candidate.name === name && !candidate.inUse);
      if (!branch) throw new Error("The branch selection changed. Run stale branch cleanup again.");
      return branch;
    });
    const result: StaleBranchCleanupResult = { deleted: [], unmerged: [], skipped: [] };
    if (!selected.length) return result;
    const fresh = await this.inspect();
    if (inspection.remoteConfigHash !== fresh.remoteConfigHash || !fresh.remotes.length) {
      throw new Error("Remote settings changed. Run stale branch cleanup again.");
    }
    const byName = new Map(fresh.branches.map(branch => [branch.name, branch]));
    try {
      for (const branch of selected) {
        const current = byName.get(branch.name);
        if (!current) { result.skipped.push({ branch, reason: "notStale" }); continue; }
        if (current.inUse) { result.skipped.push({ branch, reason: "inUse" }); continue; }
        if (current.hash !== branch.hash) { result.skipped.push({ branch, reason: "changed" }); continue; }
        try {
          // 앞선 브랜치 처리 중 외부 프로세스가 tip을 바꿨다면 선택 당시의 승인으로 삭제하지 않는다.
          const hash = (await this.git(["rev-parse", "--verify", `refs/heads/${branch.name}`], this.repoRoot)).trim();
          if (hash !== branch.hash) { result.skipped.push({ branch, reason: "changed" }); continue; }
          if (!force && !(await this.mergedIntoHead(branch.hash))) {
            result.unmerged.push(branch);
            continue;
          }
          // Git 자체에 checkout/rebase 중 worktree 보호와 branch 설정·reflog 정리를 맡긴다.
          await this.git(["branch", force ? "-D" : "-d", "--", branch.name], this.repoRoot, {
            env: { LC_ALL: "C", LANG: "C" }, retryOnLock: false,
          });
          result.deleted.push(branch);
        } catch (error) {
          if (!force && error instanceof GitError && /not fully merged/i.test(error.stderr)) result.unmerged.push(branch);
          else result.skipped.push({ branch, reason: "failed", message: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      if (result.deleted.length) invalidateGitBranchListCaches(this.repoRoot);
    }
    return result;
  }

  /**
   * 오래된 tracking ref를 신뢰하지 않고 현재 HEAD에 tip이 통합됐는지 Git으로 검사한다.
   * @param hash 선택 시 고정한 커밋 OID
   * @returns HEAD의 조상이면 true, 통합되지 않았으면 false
   */
  private async mergedIntoHead(hash: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", hash, "HEAD"], this.repoRoot);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.code === 1) return false;
      throw error;
    }
  }

  /**
   * 원격 이름과 전체 remote 설정의 해시를 읽어 목록 표시 중 접속 대상 변경을 검출한다.
   * @param signal 읽기 취소 신호
   * @returns 접속 정보를 노출하지 않는 설정 스냅샷
   */
  private async remoteConfiguration(signal?: AbortSignal): Promise<Pick<StaleBranchInspection, "remotes" | "remoteConfigHash">> {
    const remotes = (await this.git(["remote"], this.repoRoot, { signal })).trim().split("\n").filter(Boolean).sort();
    const configuration = remotes.length
      ? await this.git(["config", "--null", "--get-regexp", "^remote\\."], this.repoRoot, { signal }) : "";
    return { remotes, remoteConfigHash: createHash("sha256").update(configuration).digest("hex") };
  }

  /**
   * 원격 하나의 heads를 최대 30초 동안 읽고 실패를 빈 브랜치 집합으로 바꾸지 않는다.
   * @param remote 등록된 원격 이름
   * @param signal 사용자 취소 신호
   * @returns 검증할 ls-remote 표준 출력
   */
  private async readRemote(remote: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await this.git(["ls-remote", "--heads", "--", remote], this.repoRoot, {
        signal: controller.signal, env: { GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      checkCancelled(signal);
      throw new StaleBranchRemoteError(remote, error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

/** 취소된 요청이 후보 표시나 다음 Git 처리로 진행하지 않게 중단한다. */
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StaleBranchCleanupCancelledError();
}
