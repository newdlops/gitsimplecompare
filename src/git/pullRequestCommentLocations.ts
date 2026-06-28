// GitHub PR review comment 답글이 부모 comment 의 코드 위치를 공유하도록 보정한다.

/** 부모 위치 상속에 필요한 PR review comment 필드 */
export interface PullRequestCommentLocationFields {
  /** GitHub review comment id */
  id?: number | string;
  /** 답글이 참조하는 부모 review comment id */
  parentId?: string;
  /** GitHub review comment 가 달린 diff hunk */
  diffHunk?: string;
  /** 현재 diff 오른쪽 라인 번호 */
  line?: number;
  /** 현재 diff 오른쪽 시작 라인 번호 */
  startLine?: number;
  /** 원본 diff 왼쪽 라인 번호 */
  originalLine?: number;
  /** 원본 diff 왼쪽 시작 라인 번호 */
  originalStartLine?: number;
  /** GitHub diff side 값 */
  side?: string;
  /** GitHub diff start_side 값 */
  startSide?: string;
}

/**
 * 답글 comment 에 빠진 코드 위치 정보를 부모 comment 에서 채운다.
 * - GitHub REST 응답에서 답글은 line/diff_hunk 일부가 비어 있을 수 있다.
 * - 원본 객체를 직접 바꾸지 않고, 필요한 답글만 얕은 복사해 반환한다.
 * @param comments 같은 PR/file 범위에서 읽은 review comment 목록
 * @returns 부모 위치가 보완된 comment 목록
 */
export function inheritReplyCommentLocations<T extends PullRequestCommentLocationFields>(
  comments: T[]
): T[] {
  const byId = new Map(
    comments
      .map((comment) => [commentId(comment), comment] as const)
      .filter((entry): entry is [string, T] => entry[0] !== undefined)
  );
  return comments.map((comment) => {
    if (!comment.parentId) {
      return comment;
    }
    const parent = findParentWithLocation(comment, byId);
    if (!parent) {
      return comment;
    }
    return {
      ...comment,
      diffHunk: comment.diffHunk || parent.diffHunk,
      line: comment.line ?? parent.line,
      startLine: comment.startLine ?? parent.startLine,
      originalLine: comment.originalLine ?? parent.originalLine,
      originalStartLine: comment.originalStartLine ?? parent.originalStartLine,
      side: comment.side || parent.side,
      startSide: comment.startSide || parent.startSide,
    };
  });
}

/**
 * 답글의 부모 체인에서 코드 위치가 있는 가장 가까운 comment 를 찾는다.
 * @param comment 시작 답글 comment
 * @param byId id -> comment 맵
 * @returns 위치를 상속할 부모 comment
 */
function findParentWithLocation<T extends PullRequestCommentLocationFields>(
  comment: T,
  byId: Map<string, T>
): T | undefined {
  let current: T | undefined = comment;
  for (let depth = 0; current?.parentId && depth < 10; depth++) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      return undefined;
    }
    if (hasLocation(parent)) {
      return parent;
    }
    current = parent;
  }
  return undefined;
}

/**
 * comment 가 코드 위치를 설명할 수 있는지 확인한다.
 * @param comment 검사할 review comment
 * @returns line 또는 diff hunk 가 있으면 true
 */
function hasLocation(comment: PullRequestCommentLocationFields): boolean {
  return Boolean(
    comment.line ||
      comment.originalLine ||
      comment.startLine ||
      comment.originalStartLine ||
      comment.diffHunk
  );
}

/** comment id 를 문자열 key 로 정규화한다. */
function commentId(comment: PullRequestCommentLocationFields): string | undefined {
  return comment.id === undefined ? undefined : String(comment.id);
}
