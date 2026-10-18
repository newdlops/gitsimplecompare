// conflict worktree 경로가 저장소 밖으로 탈출하거나 symlink 부모를 통과하지 않게 검증한다.
// - Git 콘텐츠 로직과 filesystem 경로 정규화를 분리해 모든 mutation 경로에서 재사용한다.
import * as fs from "node:fs";
import * as path from "node:path";

/** 저장소 밖 경로와 실제 파일명에 쓸 수 없는 NUL을 거부해 stdin 경로 구분자 주입도 막는다. */
export function assertConflictRelativePath(repoRoot: string, rel: string): void {
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, rel);
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))) {
    throw new Error("Conflict path must stay inside the repository.");
  }
}

/**
 * 저장소 루트 자체의 symlink는 허용하되 하위 부모 symlink를 거부한 절대 leaf 경로를 만든다.
 * @param repoRoot 대상 저장소 루트
 * @param rel 검증할 저장소 상대 경로
 * @returns lexical repo 경로 아래의 절대 worktree leaf
 */
export async function resolveSafeConflictWorkingPath(
  repoRoot: string,
  rel: string
): Promise<string> {
  assertConflictRelativePath(repoRoot, rel);
  const lexicalRoot = path.resolve(repoRoot);
  const absolute = path.resolve(lexicalRoot, rel);
  const lexicalParent = path.dirname(absolute);
  const [root, parent] = await Promise.all([
    fs.promises.realpath(repoRoot),
    fs.promises.realpath(lexicalParent),
  ]);
  const expectedParent = path.resolve(root, path.relative(lexicalRoot, lexicalParent));
  if (parent !== expectedParent) {
    throw new Error("Conflict path parent contains a symbolic link.");
  }
  return absolute;
}
