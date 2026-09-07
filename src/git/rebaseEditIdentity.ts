// edit 정지 항목을 worktree·rebase 생성 세대·원본 todo 커밋·현재 HEAD에 고정한다.
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { readRebaseTodoProgress } from "./rebaseTodoProgress";
import type { RebasePausedState } from "./rebaseService";

/**
 * 미래 todo의 정상 편집은 허용하되 외부 Continue/Skip/재시작으로 다른 edit을 수정하지 못하게 한다.
 * @param repoRoot edit을 실행할 작업트리
 * @param paused 처음 읽은 edit 상태. 작업 식별자가 없는 옛 상태는 자동 채택하지 않는다.
 * @param amended 호출자가 방금 성공시킨 amend 이후 HEAD 변경만 허용할지 여부
 * @returns 검증한 현재 식별자. 이어지는 native Continue는 이 값을 다시 검증해야 한다.
 */
export async function assertRebaseEditIdentity(
  repoRoot: string, paused: RebasePausedState, amended = false
): Promise<GitOperationIdentity> {
  const current = await captureGitOperation(repoRoot);
  const expected = paused.operation;
  const progress = await readRebaseTodoProgress(repoRoot);
  const item = progress?.items.find(entry => entry.role === "current");
  const original = progress?.currentHash;
  if (!expected || current.operation !== "rebase" || current.gitDir !== expected.gitDir ||
      current.generation !== expected.generation || current.branch !== expected.branch ||
      (!amended && current.head !== paused.hash) || item?.action !== "edit" ||
      !original || !paused.originalHash ||
      !(paused.originalHash.startsWith(original) || original.startsWith(paused.originalHash))) {
    throw new Error("The paused rebase edit changed. Refresh the repository before continuing. Your edits and temporary files were kept.");
  }
  await assertGitOperation(repoRoot, current);
  return current;
}
