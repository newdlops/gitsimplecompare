// PR preview 의 기본 본문을 만드는 순수 helper.
// - PullRequestService 가 데이터 조립에 집중하도록 markdown 본문 생성을 분리한다.
import type { PullRequestPreviewFile } from "./pullRequestPreviewFiles";

/**
 * staged PR preview 의 기본 markdown 본문을 만든다.
 * @param files target branch 기준으로 변경된 파일 목록
 * @param commits target branch 보다 앞선 commit 표시 목록
 * @param stat 파일/라인 변경 요약 문자열
 * @returns PR preview conversation 에 표시할 markdown 본문
 */
export function previewBody(
  files: PullRequestPreviewFile[],
  commits: string[],
  stat: string
): string {
  const lines = [
    "## Summary",
    files.length ? `- ${files.length} staged files included.` : "- No staged files yet.",
    commits.length ? `- ${commits.length} local commits are ahead of the target branch.` : "- No local commits detected against the target branch.",
    "",
    "## Staged files",
    ...files.slice(0, 20).map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`),
  ];
  if (files.length > 20) {
    lines.push(`- ...and ${files.length - 20} more files`);
  }
  if (stat.trim()) {
    lines.push("", "## Diff stat", "```", stat.trim(), "```");
  }
  return lines.join("\n");
}
