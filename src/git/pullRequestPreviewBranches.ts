// PR preview 에서 base/target branch 선택에 사용할 후보 목록을 만든다.
// - GitHub PR 의 base branch 선택처럼 로컬/원격 branch 를 한 목록으로 제공한다.
import { runGit } from "./gitExec";

/**
 * PR preview target branch 후보를 반환한다.
 * @param repoRoot git 저장소 루트
 * @param selected 현재 선택된 target branch
 * @param currentBranch 현재 작업 브랜치
 * @returns selected 를 맨 앞에 둔 branch 후보 목록
 */
export async function previewTargetBranches(
  repoRoot: string,
  selected: string,
  currentBranch: string
): Promise<string[]> {
  const out = await runGit([
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], repoRoot).catch(() => "");
  const values = out
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && !name.endsWith("/HEAD") && name !== currentBranch)
    .map((name) => name.replace(/^origin\//, "origin/"));
  return orderedUnique([selected, "main", "master", "origin/main", "origin/master", ...values]);
}

/** 중복과 빈 값을 제거하고 원래 순서를 유지한다. */
function orderedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}
