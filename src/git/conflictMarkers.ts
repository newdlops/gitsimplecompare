// conflict marker 텍스트를 감지하는 공통 유틸.
// - Git index 충돌이 사라져도 파일 본문에 marker 가 남으면 resolved 로 처리하면 안 된다.

const CONFLICT_MARKER_RE = /^(?:<<<<<<<(?: .*)?|=======$|>>>>>>>(?: .*)?)$/m;

/**
 * 파일 본문에 conflict marker 줄이 남아 있는지 확인한다.
 * - 코드에서 문자열로 `"<<<<<<<"` 를 검사하는 줄은 전체 marker 줄이 아니므로 false 로 둔다.
 * @param content 검사할 파일 본문
 */
export function containsConflictMarkers(content: string): boolean {
  return Boolean(content && !content.includes("\0") && CONFLICT_MARKER_RE.test(content));
}

/**
 * conflict marker 가 남은 내용을 resolved 로 표시하지 못하게 오류를 던진다.
 * @param content 검사할 파일 본문
 * @param rel     사용자에게 보여줄 저장소 상대 경로
 */
export function assertNoConflictMarkers(content: string, rel: string): void {
  if (!containsConflictMarkers(content)) {
    return;
  }
  throw new Error(
    `Conflict markers remain in '${rel}'. Remove <<<<<<<, =======, >>>>>>> blocks before marking it resolved.`
  );
}
