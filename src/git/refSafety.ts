// 브랜치 ref 를 이동하기 전 현재 브랜치/HEAD/대상 커밋 관계를 검증하는 안전장치.
// - 오래 걸리는 PR/branch 작업 중 사용자가 브랜치를 바꾸거나 ref 가 외부에서 움직이면
//   reset/update-ref 가 다른 작업의 커밋을 덮지 않도록 명시적으로 중단한다.
import { runGit } from "./gitExec";

/**
 * 현재 checkout 된 브랜치가 기대 브랜치와 기대 HEAD 를 그대로 가리키는지 확인한다.
 * - 임시 worktree 에서 계산한 결과를 현재 브랜치로 가져오기 직전에 호출해,
 *   A -> B -> A 처럼 브랜치 이름만 같고 HEAD 가 달라진 상황을 차단한다.
 * @param repoRoot git 저장소 루트
 * @param branch 기대하는 checkout 브랜치 이름
 * @param expectedHead 작업 시작 시점에 기록한 기대 HEAD
 * @param reason 오류 메시지에 넣을 검증 목적
 */
export async function assertCurrentBranchHead(
  repoRoot: string,
  branch: string,
  expectedHead: string,
  reason: string
): Promise<void> {
  const currentBranch = await readCurrentBranch(repoRoot);
  const currentHead = await readCurrentHead(repoRoot);
  if (currentBranch !== branch || currentHead !== expectedHead) {
    throw new Error(
      "Ref safety check failed before " +
        `${reason}: expected '${branch}' at ${shortHash(expectedHead)}, ` +
        `but found '${currentBranch || "DETACHED"}' at ${shortHash(currentHead)}. ` +
        "The operation was stopped before moving the branch ref."
    );
  }
}

/**
 * 지정 브랜치 ref 가 기대 HEAD 를 그대로 가리키는지 확인한다.
 * - checkout 되지 않은 브랜치를 update-ref 로 이동하기 전, 사용자가 그 브랜치에
 *   새 커밋을 만든 경우를 덮지 않기 위해 사용한다.
 * @param repoRoot git 저장소 루트
 * @param branch 확인할 로컬 브랜치 이름
 * @param expectedHead 기대하는 브랜치 HEAD
 * @param reason 오류 메시지에 넣을 검증 목적
 */
export async function assertBranchRefHead(
  repoRoot: string,
  branch: string,
  expectedHead: string,
  reason: string
): Promise<void> {
  const actualHead = await readBranchHead(repoRoot, branch);
  if (actualHead !== expectedHead) {
    throw new Error(
      "Ref safety check failed before " +
        `${reason}: expected '${branch}' at ${shortHash(expectedHead)}, ` +
        `but the branch points at ${shortHash(actualHead)}. ` +
        "The operation was stopped before moving the branch ref."
    );
  }
}

/**
 * 적용하려는 target ref 가 시작 HEAD 의 후손인지 확인한다.
 * - PR/branch 결과 커밋은 항상 시작 HEAD 위에서 계산되어야 하므로,
 *   전혀 다른 브랜치의 HEAD 를 reset 대상으로 삼는 사고를 막는다.
 * @param repoRoot git 저장소 루트
 * @param baseHead 작업 시작 시점 HEAD
 * @param targetRef 적용하려는 결과 ref 또는 커밋
 * @param reason 오류 메시지에 넣을 검증 목적
 */
export async function assertTargetDescendsFrom(
  repoRoot: string,
  baseHead: string,
  targetRef: string,
  reason: string
): Promise<void> {
  if (await isAncestor(repoRoot, baseHead, targetRef)) {
    return;
  }
  const targetHead = await readCommit(repoRoot, targetRef).catch(() => targetRef);
  throw new Error(
    "Ref safety check failed before " +
      `${reason}: target ${shortHash(targetHead)} is not based on ` +
      `${shortHash(baseHead)}. The operation was stopped before moving the branch ref.`
  );
}

/**
 * 현재 checkout 된 로컬 브랜치 이름을 읽는다.
 * - detached HEAD 이면 빈 문자열을 반환해 호출자가 안전하게 오류 메시지를 만들 수 있게 한다.
 * @param repoRoot git 저장소 루트
 */
async function readCurrentBranch(repoRoot: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot).catch(() => "")).trim();
}

/**
 * 현재 HEAD commit hash 를 읽는다.
 * @param repoRoot git 저장소 루트
 */
async function readCurrentHead(repoRoot: string): Promise<string> {
  return readCommit(repoRoot, "HEAD");
}

/**
 * 로컬 브랜치 ref 가 가리키는 commit hash 를 읽는다.
 * @param repoRoot git 저장소 루트
 * @param branch 확인할 로컬 브랜치 이름
 */
async function readBranchHead(repoRoot: string, branch: string): Promise<string> {
  return readCommit(repoRoot, `refs/heads/${branch}`);
}

/**
 * 임의 ref 를 commit 으로 정규화해 전체 hash 를 반환한다.
 * @param repoRoot git 저장소 루트
 * @param ref commit 으로 해석할 ref 또는 hash
 */
async function readCommit(repoRoot: string, ref: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot)).trim();
}

/**
 * ancestor 가 target 의 조상인지 확인한다.
 * @param repoRoot git 저장소 루트
 * @param ancestor 조상이어야 하는 commit hash
 * @param target 기준 ref 또는 commit hash
 */
async function isAncestor(
  repoRoot: string,
  ancestor: string,
  target: string
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, target], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * 긴 commit hash 를 오류 메시지용으로 줄인다.
 * @param hash 전체 commit hash 또는 ref 문자열
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
