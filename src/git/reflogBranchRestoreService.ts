// reflog 복구 항목을 기존 로컬 브랜치에 적용하는 git 서비스.
// - UI 레이어가 직접 update-ref 를 조립하지 않도록 브랜치 복구 절차를 한 곳에 모은다.
import { runGit } from "./gitExec";

/** reflog 복구로 이동된 브랜치와 자동 백업 브랜치 정보 */
export interface ReflogBranchRestoreResult {
  branchName: string;
  backupName?: string;
  oldHash: string;
  targetHash: string;
}

/**
 * 로컬 브랜치를 reflog/object commit 으로 안전하게 되돌린다.
 * - 기존 tip 은 자동 백업 브랜치로 남기고, expected old hash 를 지정한 update-ref 로
 *   사용자가 확인하는 사이 브랜치가 바뀐 경우 복구를 중단한다.
 * - checkout 중인 브랜치는 작업트리와 index 상태가 함께 움직여야 하므로 여기서는 막는다.
 * @param repoRoot   저장소 루트
 * @param branchName 복구할 기존 로컬 브랜치 이름
 * @param targetRef  reflog 가 가리키는 복구 대상 commit hash/ref
 */
export async function restoreLocalBranchFromReflog(
  repoRoot: string,
  branchName: string,
  targetRef: string
): Promise<ReflogBranchRestoreResult> {
  const cleanBranch = branchName.trim();
  const cleanTarget = targetRef.trim();
  if (!cleanBranch) {
    throw new Error("Branch name is required.");
  }
  if (!cleanTarget) {
    throw new Error("Recovery commit is required.");
  }
  await assertValidBranchName(repoRoot, cleanBranch);
  await assertBranchIsNotCurrent(repoRoot, cleanBranch);

  const oldHash = await readCommit(repoRoot, `refs/heads/${cleanBranch}`);
  const targetHash = await readCommit(repoRoot, cleanTarget);
  if (oldHash === targetHash) {
    return { branchName: cleanBranch, oldHash, targetHash };
  }

  const backupName = await createBackupBranch(repoRoot, cleanBranch, oldHash);
  await runGit(
    [
      "update-ref",
      "-m",
      `restore ${cleanBranch} from reflog`,
      `refs/heads/${cleanBranch}`,
      targetHash,
      oldHash,
    ],
    repoRoot
  );
  return { branchName: cleanBranch, backupName, oldHash, targetHash };
}

/**
 * git 이 허용하는 로컬 브랜치 이름인지 확인한다.
 * @param repoRoot 저장소 루트
 * @param name     검사할 브랜치 이름
 */
async function assertValidBranchName(repoRoot: string, name: string): Promise<void> {
  await runGit(["check-ref-format", "--branch", name], repoRoot);
}

/**
 * 복구 대상 브랜치가 현재 checkout 된 브랜치가 아닌지 확인한다.
 * @param repoRoot 저장소 루트
 * @param name     이동하려는 로컬 브랜치 이름
 */
async function assertBranchIsNotCurrent(repoRoot: string, name: string): Promise<void> {
  const current = (await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot).catch(() => "")).trim();
  if (current === name) {
    throw new Error(
      `Cannot restore checked-out branch '${name}' from the reflog panel. ` +
        "Checkout another branch first, then retry the restore."
    );
  }
}

/**
 * ref/hash 를 commit object 로 정규화한다.
 * @param repoRoot 저장소 루트
 * @param ref      commit 으로 해석할 ref/hash
 */
async function readCommit(repoRoot: string, ref: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot)).trim();
}

/**
 * 현재 브랜치 tip 을 보존하는 백업 브랜치를 만든다.
 * @param repoRoot   저장소 루트
 * @param branchName 원래 브랜치 이름
 * @param oldHash    백업할 기존 tip
 */
async function createBackupBranch(
  repoRoot: string,
  branchName: string,
  oldHash: string
): Promise<string> {
  const baseName = `${branchName}-before-reflog-${shortHash(oldHash)}`;
  const backupName = await nextAvailableBranchName(repoRoot, baseName);
  await runGit(["branch", backupName, oldHash], repoRoot);
  return backupName;
}

/**
 * 이미 존재하지 않는 백업 브랜치 이름을 찾는다.
 * @param repoRoot 저장소 루트
 * @param baseName 기본 백업 브랜치 이름
 */
async function nextAvailableBranchName(repoRoot: string, baseName: string): Promise<string> {
  for (let index = 0; index < 100; index++) {
    const name = index === 0 ? baseName : `${baseName}-${index + 1}`;
    if (!(await branchExists(repoRoot, name))) {
      return name;
    }
  }
  throw new Error(`Unable to find an available backup branch name for '${baseName}'.`);
}

/**
 * 로컬 브랜치 ref 존재 여부를 확인한다.
 * @param repoRoot 저장소 루트
 * @param name     확인할 브랜치 이름
 */
async function branchExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * UI 메시지에 넣을 짧은 commit hash 를 만든다.
 * @param hash 전체 commit hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
