// paused edit의 수정 범위를 검증한 뒤 의도한 파일만 stage하고 amend한다.
import { runGit, runGitLiteralPaths } from "./gitExec";
import { parsePorcelainGroups } from "./diffParse";
import { applyRebaseEditTempFiles, cleanupRebaseEditTempFiles } from "./rebaseEditSession";
import type { RebasePausedState } from "./rebaseService";

/**
 * 다른 파일의 staged 변경은 그대로 둔 채 실패하고, edit 대상 변경만 amend한다.
 * @param repoRoot 진행 중인 rebase worktree
 * @param state 현재 edit 커밋과 원래 변경 파일 목록
 * @returns 실제 amend를 했으면 true, 대상 수정이 없으면 false
 */
export async function amendRebaseEdit(repoRoot: string, state: RebasePausedState): Promise<boolean> {
  const candidates = new Set(state.files.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]));
  await assertStagedScope(repoRoot, candidates);
  const temporary = await applyRebaseEditTempFiles(repoRoot, state);
  const paths = temporary.length ? temporary : await changedEditPaths(repoRoot, candidates);
  if (!paths.length) return false;
  if (!temporary.length) await runGitLiteralPaths(["add", "-A", "--", ...paths], repoRoot, { retryOnLock: false });
  await assertStagedScope(repoRoot, candidates);
  const staged = await runGit(["diff", "--cached", "--name-only", "-z"], repoRoot);
  if (!staged) return false;
  // --only로 Git 자체도 파일 범위를 고정해 마지막 검사 뒤 다른 파일이 stage되어도 섞지 않는다.
  await runGitLiteralPaths(["commit", "--amend", "--only", "--no-edit", "--allow-empty", "--no-verify", "--", ...paths], repoRoot,
    { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }, retryOnLock: false });
  await cleanupRebaseEditTempFiles(repoRoot, state);
  return true;
}

/** amend가 index 전체를 소비하기 전에 edit 범위 밖의 staged 파일을 거부한다. */
async function assertStagedScope(repoRoot: string, candidates: Set<string>): Promise<void> {
  const staged = (await runGit(["diff", "--cached", "--name-only", "--no-renames", "-z"], repoRoot)).split("\0").filter(Boolean);
  const unrelated = staged.filter(file => !candidates.has(file));
  if (unrelated.length) throw new Error(`Unrelated staged changes were kept: ${unrelated.join(", ")}. Unstage them before amending this rebase edit commit.`);
}

/** 원래 edit 커밋의 파일 중 실제로 바뀐 경로만 반환한다. rename의 양쪽 경로도 보존한다. */
async function changedEditPaths(repoRoot: string, candidates: Set<string>): Promise<string[]> {
  const raw = await runGit(["status", "--porcelain", "-z", "--untracked-files=all"], repoRoot);
  const { staged, unstaged } = parsePorcelainGroups(raw);
  return [...new Set([...staged, ...unstaged].flatMap(change =>
    [change.path, ...(change.oldPath ? [change.oldPath] : [])].filter(file => candidates.has(file))))];
}
