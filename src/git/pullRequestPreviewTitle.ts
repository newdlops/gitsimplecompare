// PR preview 제목 생성을 담당하는 순수 helper 모듈.
// - PullRequestService 는 데이터 조회에 집중하고, 표시용 초안 문자열 규칙은 이 파일에 둔다.
import { CommitFileChange } from "../graph/graphTypes";

/**
 * staged preview 의 제목을 실제 커밋/파일 정보에서 만든다.
 * @param currentBranch 현재 브랜치 이름
 * @param targetBranch  PR 대상 브랜치 이름
 * @param commits       target 이후 로컬 커밋 목록
 * @param files         staged changed files 또는 기존 PR changed files
 * @returns PR title 초안
 */
export function previewTitle(
  currentBranch: string,
  targetBranch: string,
  commits: string[],
  files: CommitFileChange[]
): string {
  const subject = commitSubject(commits[0]);
  if (subject) {
    return subject;
  }
  if (files.length === 1) {
    return `Update ${files[0].path}`;
  }
  if (files.length > 1) {
    return `Update ${files.length} changed files`;
  }
  return `${currentBranch} -> ${targetBranch}`;
}

/** `git log --oneline` 출력에서 해시를 제거한 커밋 제목을 반환한다. */
function commitSubject(line: string | undefined): string {
  return (line || "").replace(/^[0-9a-f]{7,40}\s+/i, "").trim();
}
