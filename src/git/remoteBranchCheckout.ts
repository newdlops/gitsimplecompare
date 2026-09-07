// 원격 checkout의 이름 충돌 처리와 실패 시 기존 브랜치 이름 복원을 담당한다.
// - 기존 ref/config/reflog는 Git의 branch rename으로 보존하고 새 브랜치가 원래 이름을 사용한다.
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { detectOperation } from "./conflictService";
import { GitError, runGit } from "./gitExec";
import { localNameFromRemoteRef } from "./gitRefNames";
import { logError, logInfo, logWarn } from "../ui/outputLog";

/** 확인창과 실행 단계가 공유하는 원격 checkout 이름 및 보존 대상이다. */
export interface RemoteBranchCheckoutPlan {
  /** origin/topic 형태의 원격 short ref. tracking 설정과 로그에 사용한다. */
  remoteBranch: string;
  /** 이름 변경 전후에 원격 대상이 바뀌지 않았는지 확인할 전체 OID다. */
  remoteHash: string;
  /** 새 tracking 브랜치에 부여할 원격 prefix 없는 이름이다. */
  localName: string;
  /** 이름이 겹치는 기존 브랜치의 보존 이름과 이동 전 전체 commit OID다. */
  staleBranch?: { name: string; hash: string };
}

/** detached/unborn HEAD도 구분하여 중간 브랜치 전환을 감지할 checkout 상태다. */
interface CheckoutState {
  branch: string;
  head: string;
}

// 같은 확장 호스트의 linked worktree들이 공유 ref를 동시에 rename하지 않게 직렬화한다.
const checkoutQueues = new Map<string, Promise<void>>();

/**
 * 새 브랜치의 원래 이름과 기존 브랜치의 stale 이름을 읽기 전용으로 계산한다.
 * 원격 OID는 현재 저장소의 remote-tracking ref를 사용하며 fetch 자체는 실행하지 않는다.
 * @param repoRoot 원격과 로컬 ref를 조회할 저장소
 * @param remoteBranch origin/feature 형태의 원격 short ref
 * @returns 원격 OID와 기존 로컬 OID에 묶인 이름 계획
 */
export async function getRemoteBranchCheckoutPlan(
  repoRoot: string,
  remoteBranch: string
): Promise<RemoteBranchCheckoutPlan> {
  const localName = localNameFromRemoteRef(remoteBranch);
  const [remoteHash, branches] = await Promise.all([
    readRemoteHead(repoRoot, remoteBranch),
    readLocalBranches(repoRoot),
    runGit(["check-ref-format", "--branch", localName], repoRoot),
  ]);
  const oldHash = branches.get(localName);
  if (!oldHash) {
    return { remoteBranch, remoteHash, localName };
  }

  const shortHash = (await runGit(["rev-parse", "--short=7", oldHash], repoRoot)).trim();
  const base = `${localName}-stale-${shortHash}`;
  let name = base;
  for (let index = 2; nameIsReserved(branches, name); index++) {
    name = `${base}-${index}`;
  }
  return { remoteBranch, remoteHash, localName, staleBranch: { name, hash: oldHash } };
}

/**
 * 기존 동명 브랜치를 stale 이름으로 옮기고 원래 이름으로 원격 tracking 브랜치를 checkout한다.
 * @param repoRoot checkout 대상 worktree
 * @param remoteBranch 원격 short ref
 * @param merge 작업 파일을 3-way merge하며 전환할지 여부
 * @returns 새로 checkout한 원래 로컬 브랜치 이름
 */
export async function checkoutRemoteBranchAsLocal(
  repoRoot: string,
  remoteBranch: string,
  merge = false
): Promise<string> {
  const commonDir = (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  const key = await realpath(path.resolve(repoRoot, commonDir));
  const previous = checkoutQueues.get(key) ?? Promise.resolve();
  const result = previous.then(() => executeCheckout(repoRoot, remoteBranch, merge));
  const settled = result.then(() => undefined, () => undefined);
  checkoutQueues.set(key, settled);
  try {
    return await result;
  } finally {
    if (checkoutQueues.get(key) === settled) {
      checkoutQueues.delete(key);
    }
  }
}

/**
 * 큐에서 차례가 된 시점의 ref를 다시 읽고 rename/switch를 순서대로 실행한다.
 * @param repoRoot checkout 대상 worktree
 * @param remoteBranch 원격 short ref
 * @param merge Git의 로컬 변경 병합 전환 여부
 * @returns 실제 생성된 브랜치 이름
 */
async function executeCheckout(
  repoRoot: string,
  remoteBranch: string,
  merge: boolean
): Promise<string> {
  const operation = await detectOperation(repoRoot);
  if (operation !== "none") {
    throw new Error(`Cannot checkout a remote branch while ${operation} is in progress.`);
  }
  const plan = await getRemoteBranchCheckoutPlan(repoRoot, remoteBranch);
  const before = await readCheckoutState(repoRoot);
  let renameAttempted = false;
  logInfo("remote branch checkout started", { repoRoot, ...plan, merge });
  try {
    await assertPlanCurrent(repoRoot, plan, before, false);
    if (plan.staleBranch) {
      renameAttempted = true;
      // -m은 reflog/config와 다른 worktree의 symbolic HEAD를 함께 옮기며 기존 대상을 덮지 않는다.
      await runGit(["branch", "-m", "--", plan.localName, plan.staleBranch.name], repoRoot, {
        retryOnLock: false,
      });
      logInfo("existing local branch preserved", {
        repoRoot,
        branch: plan.localName,
        preservedBranch: plan.staleBranch.name,
        hash: plan.staleBranch.hash,
      });
    }
    await assertPlanCurrent(repoRoot, plan, before, Boolean(plan.staleBranch));
    await runGit(
      [
        "switch", ...(merge ? ["--merge"] : []),
        "-c", plan.localName, "--track", `refs/remotes/${remoteBranch}`,
      ],
      repoRoot,
      { retryOnLock: false }
    );
    logInfo("remote branch checkout finished", {
      repoRoot,
      remoteBranch,
      localBranch: plan.localName,
      preservedBranch: plan.staleBranch?.name,
      merge,
    });
    return plan.localName;
  } catch (error) {
    if (renameAttempted) {
      await restorePreviousName(repoRoot, plan);
    }
    logError("remote branch checkout failed", error, {
      repoRoot,
      remoteBranch,
      localBranch: plan.localName,
      preservedBranch: plan.staleBranch?.name,
    });
    // 원래 GitError를 유지해야 호출부가 로컬 변경 충돌을 판별하고 --merge 재시도를 제공할 수 있다.
    throw error;
  }
}

/**
 * rename 전후의 예상 ref와 checkout 상태를 확인해 외부 변경이 끼면 추가 변경을 중단한다.
 * @param repoRoot 확인할 worktree
 * @param plan 실행 직전에 확정한 ref/이름 계획
 * @param before rename 이전 checkout 상태
 * @param renamed 기존 브랜치를 이미 stale 이름으로 옮겼는지 여부
 */
async function assertPlanCurrent(
  repoRoot: string,
  plan: RemoteBranchCheckoutPlan,
  before: CheckoutState,
  renamed: boolean
): Promise<void> {
  const [branches, remoteHash, current] = await Promise.all([
    readLocalBranches(repoRoot),
    readRemoteHead(repoRoot, plan.remoteBranch),
    readCheckoutState(repoRoot),
  ]);
  const expectedBranch = renamed && before.branch === `refs/heads/${plan.localName}`
    ? `refs/heads/${plan.staleBranch!.name}` : before.branch;
  const localHash = renamed ? undefined : plan.staleBranch?.hash;
  const staleMatches = !plan.staleBranch || (renamed
    ? branches.get(plan.staleBranch.name) === plan.staleBranch.hash
    : !nameIsReserved(branches, plan.staleBranch.name));
  if (
    branches.get(plan.localName) !== localHash || !staleMatches ||
    remoteHash !== plan.remoteHash || current.branch !== expectedBranch || current.head !== before.head
  ) {
    throw new Error("Branches changed while preparing remote checkout. Refresh and try again.");
  }
}

/**
 * checkout이 새 브랜치를 만들기 전에 실패했다면 보존 ref의 원래 이름만 되돌린다.
 * - 이미 새 ref가 생겼거나 보존 ref가 이동했다면 외부 변경/완료된 checkout을 덮지 않는다.
 * - switch hook이 실패해도 새 ref가 있으면 완료된 HEAD/index를 reset하지 않는다.
 * @param repoRoot checkout을 시도한 worktree
 * @param plan 복원할 원래 이름과 보존 OID
 */
async function restorePreviousName(
  repoRoot: string,
  plan: RemoteBranchCheckoutPlan
): Promise<void> {
  if (!plan.staleBranch) {
    return;
  }
  const detail = {
    repoRoot,
    branch: plan.localName,
    preservedBranch: plan.staleBranch.name,
  };
  try {
    const branches = await readLocalBranches(repoRoot);
    if (branches.has(plan.localName)) {
      logInfo("remote checkout name rollback skipped", { ...detail, reason: "original-name-exists" });
      return;
    }
    if (branches.get(plan.staleBranch.name) !== plan.staleBranch.hash) {
      logWarn("remote checkout name rollback skipped", { ...detail, reason: "preserved-branch-changed" });
      return;
    }
    await runGit(["branch", "-m", "--", plan.staleBranch.name, plan.localName], repoRoot, {
      retryOnLock: false,
    });
    logInfo("remote checkout restored previous branch name", detail);
  } catch (error) {
    logError("remote checkout could not restore previous branch name", error, detail);
  }
}

/**
 * packed ref도 포함한 모든 로컬 브랜치 이름과 OID를 읽는다.
 * @param repoRoot 조회할 저장소
 * @returns short name을 key로 하는 commit OID map
 */
async function readLocalBranches(repoRoot: string): Promise<Map<string, string>> {
  const output = await runGit(
    ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)", "refs/heads"],
    repoRoot
  );
  const branches = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [name, hash] = line.split("\0");
    branches.set(name, hash);
  }
  return branches;
}

/**
 * 정확히 같은 이름뿐 아니라 foo와 foo/bar의 ref 디렉터리 충돌도 확인한다.
 * @param branches 현재 로컬 브랜치 목록
 * @param candidate 새 보존 브랜치 후보
 * @returns 후보를 생성할 수 없으면 true
 */
function nameIsReserved(branches: Map<string, string>, candidate: string): boolean {
  for (const name of branches.keys()) {
    if (name === candidate || name.startsWith(`${candidate}/`) || candidate.startsWith(`${name}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * 같은 이름의 tag에 영향을 받지 않도록 원격의 완전한 ref를 commit으로 검증한다.
 * @param repoRoot 원격 ref를 가진 저장소
 * @param remoteBranch 원격 short ref
 * @returns 전체 commit OID
 */
async function readRemoteHead(repoRoot: string, remoteBranch: string): Promise<string> {
  return (await runGit(
    ["rev-parse", "--verify", `refs/remotes/${remoteBranch}^{commit}`],
    repoRoot
  )).trim();
}

/**
 * 현재 symbolic HEAD와 commit을 읽으며 detached/unborn의 정상 부재만 허용한다.
 * @param repoRoot 확인할 worktree
 * @returns 브랜치 full ref와 HEAD OID. 정상 부재는 빈 문자열이다.
 */
async function readCheckoutState(repoRoot: string): Promise<CheckoutState> {
  const [branch, head] = await Promise.all([
    optionalHeadValue(repoRoot, ["symbolic-ref", "-q", "HEAD"]),
    optionalHeadValue(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]),
  ]);
  return { branch, head };
}

/**
 * HEAD 조회의 종료 코드 1만 부재로 바꾸고 실행/설정 오류는 호출부로 전달한다.
 * @param repoRoot Git 조회 위치
 * @param args 부재를 종료 코드 1로 보고하는 읽기 명령
 * @returns 공백을 정리한 결과 또는 정상 부재의 빈 문자열
 */
async function optionalHeadValue(repoRoot: string, args: string[]): Promise<string> {
  try {
    return (await runGit(args, repoRoot)).trim();
  } catch (error) {
    if (error instanceof GitError && error.code === 1) {
      return "";
    }
    throw error;
  }
}
