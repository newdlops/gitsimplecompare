// PR preview 의 표시용 target branch 를 실제 git ref 로 해석한다.
// - GitHub base 이름(main 등)과 로컬 checkout ref(origin/main 등)가 다를 수 있어 diff 기준을 별도로 찾는다.
import { runGit } from "./gitExec";

/**
 * target branch 표시 이름을 git 명령에서 사용할 수 있는 ref 로 바꾼다.
 * @param repoRoot git 저장소 루트
 * @param targetBranch 사용자가 선택한 PR target branch 이름
 * @returns git rev-parse 로 확인된 ref. 찾지 못하면 원래 값을 반환해 호출부의 git fallback 이 동작하게 한다.
 */
export async function resolvePreviewTargetRef(
  repoRoot: string,
  targetBranch: string
): Promise<string> {
  const direct = await existingRef(repoRoot, targetBranch);
  if (direct) {
    return direct;
  }
  for (const candidate of await remoteCandidates(repoRoot, targetBranch)) {
    const resolved = await existingRef(repoRoot, candidate);
    if (resolved) {
      return resolved;
    }
  }
  return targetBranch;
}

/**
 * 기존 PR head 를 git diff 오른쪽 ref 로 사용할 수 있게 해석한다.
 * @param repoRoot git 저장소 루트
 * @param headBranch PR head branch 이름
 * @param headHash PR head commit hash
 * @returns 로컬에서 해석 가능한 head ref. 못 찾으면 headHash 를 반환해 빈 ref diff 로라도 실패를 드러낸다.
 */
export async function resolvePreviewHeadRef(
  repoRoot: string,
  headBranch: string | undefined,
  headHash: string | undefined
): Promise<string> {
  for (const candidate of [headHash, headBranch, ...await remoteCandidates(repoRoot, headBranch || "")]) {
    if (candidate && await existingRef(repoRoot, candidate)) {
      return candidate;
    }
  }
  return headHash || "HEAD";
}

/** 후보 ref 가 commit 으로 해석되는지 확인한다. */
async function existingRef(repoRoot: string, ref: string): Promise<string | undefined> {
  const out = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot).catch(() => "");
  return out.trim() ? ref : undefined;
}

/** remote 이름들을 붙인 fallback ref 후보를 만든다. */
async function remoteCandidates(repoRoot: string, branch: string): Promise<string[]> {
  if (branch.includes("/")) {
    return [];
  }
  const remotes = await runGit(["remote"], repoRoot).catch(() => "");
  return remotes.split("\n").map((remote) => remote.trim()).filter(Boolean).map((remote) => `${remote}/${branch}`);
}
