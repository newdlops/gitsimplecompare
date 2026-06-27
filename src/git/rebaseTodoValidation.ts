// interactive rebase todo 가 실제 재작성 범위를 빠짐없이 덮는지 검증하는 순수 유틸.
// - Git 은 시퀀스 에디터가 남긴 줄만 replay 하므로, UI payload 누락은 커밋 유실로 이어질 수 있다.
import type { RebaseCommit, RebaseItem } from "./rebaseService";

/** rebase todo 범위 검증 결과 */
export interface RebaseTodoCoverageValidation {
  ok: boolean;
  expected: number;
  missing: string[];
  duplicate: string[];
  unknown: string[];
  message?: string;
}

/**
 * UI 가 보낸 todo 항목이 실제 rebase 대상 범위 전체를 빠짐없이 덮는지 검증한다.
 * - 커밋을 의도적으로 제거하려면 item 을 삭제하지 말고 action=drop 으로 남겨야 한다.
 * - missing 이 있으면 Git 에 넘기기 전에 막아 조용한 커밋 유실을 방지한다.
 * @param commits   실제 base..HEAD 또는 --root 범위의 커밋 목록
 * @param todoItems UI 가 확정해 보낸 todo 항목
 * @returns 누락/중복/범위 밖 항목이 있으면 ok=false 와 사용자 메시지
 */
export function validateRebaseTodoCoverage(
  commits: RebaseCommit[],
  todoItems: RebaseItem[]
): RebaseTodoCoverageValidation {
  const expectedByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  for (const item of todoItems) {
    const hash = item.hash;
    if (!expectedByHash.has(hash)) {
      unknown.push(hash);
      continue;
    }
    if (seen.has(hash)) {
      duplicate.push(hash);
      continue;
    }
    seen.add(hash);
  }
  const missing = commits
    .filter((commit) => !seen.has(commit.hash))
    .map((commit) => `${commit.hash.slice(0, 12)} ${commit.subject}`);
  if (missing.length === 0 && duplicate.length === 0 && unknown.length === 0) {
    return {
      ok: true,
      expected: commits.length,
      missing,
      duplicate,
      unknown,
    };
  }
  return {
    ok: false,
    expected: commits.length,
    missing,
    duplicate: duplicate.map(shortHash),
    unknown: unknown.map(shortHash),
    message: invalidTodoMessage(missing, duplicate, unknown),
  };
}

/**
 * rebase 시작을 막을 때 사용자에게 보여줄 구체적인 사유를 만든다.
 * @param missing   실제 rebase 범위에 있지만 UI todo 에 없는 커밋
 * @param duplicate UI todo 에 중복으로 들어온 커밋 해시
 * @param unknown   현재 rebase 범위에 속하지 않는 커밋 해시
 */
function invalidTodoMessage(
  missing: string[],
  duplicate: string[],
  unknown: string[]
): string {
  const parts = [
    "Rebase todo does not match the current branch range.",
    "Cancel and prepare the rebase plan again so every commit is included; use Drop for intentional removals.",
  ];
  if (missing.length > 0) {
    parts.push(`Missing: ${formatList(missing)}.`);
  }
  if (duplicate.length > 0) {
    parts.push(`Duplicate: ${formatList(duplicate.map(shortHash))}.`);
  }
  if (unknown.length > 0) {
    parts.push(`Out of range: ${formatList(unknown.map(shortHash))}.`);
  }
  return parts.join(" ");
}

/**
 * 오류 메시지가 지나치게 길어지지 않게 앞부분만 표시한다.
 * @param values 표시할 항목
 */
function formatList(values: string[]): string {
  return `${values.slice(0, 5).join("; ")}${values.length > 5 ? "; ..." : ""}`;
}

/** 커밋 해시를 오류 메시지에 표시하기 좋은 짧은 형태로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
