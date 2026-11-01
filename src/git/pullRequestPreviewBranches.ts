// PR preview 에서 base/target branch 선택에 사용할 후보 목록을 만든다.
// - GitHub PR 의 base branch 선택처럼 로컬/원격 branch 를 한 목록으로 제공한다.
import { runGit } from "./gitExec";

/**
 * PR preview target branch 후보를 반환한다.
 * @param repoRoot git 저장소 루트
 * @param selected 현재 선택된 target branch
 * @param excludedBranch 후보에서 제외할 반대쪽 브랜치
 * @returns selected 를 맨 앞에 둔 branch 후보 목록
 */
export async function previewTargetBranches(
  repoRoot: string,
  selected: string,
  excludedBranch: string
): Promise<string[]> {
  return previewBranchChoices(await readPreviewBranchNames(repoRoot), selected, excludedBranch);
}

/**
 * 미리보기 한 번에서 source/target 선택지가 공유할 브랜치 목록을 한 번만 읽는다.
 * @param repoRoot 저장소 루트, signal 현재 미리보기의 취소 신호
 * @returns 기존 Git 정렬 순서의 short ref 목록. 파일/설정 오류는 빈 후보로 숨기지 않는다.
 */
export async function readPreviewBranchNames(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit([
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], repoRoot, { signal });
  return out.split("\n").map(name => name.trim()).filter(Boolean);
}

/** 같은 branch snapshot에서 기존 선택·기본 후보 순서를 유지하며 한쪽 선택지를 만든다. */
export function previewBranchChoices(branches: readonly string[], selected: string, excludedBranch: string): string[] {
  const values = branches
    .filter((name) => name && !name.endsWith("/HEAD") && name !== excludedBranch)
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
