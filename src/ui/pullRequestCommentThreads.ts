// PR review comment 를 VS Code CommentThread 로 표시하기 위한 순수 그룹화 유틸이다.

/** GitHub review comment thread 그룹화에 필요한 최소 필드 */
export interface PullRequestThreadComment {
  /** GitHub comment id */
  id?: number | string;
  /** 답글이 참조하는 부모 comment id */
  parentId?: string;
  /** 현재 diff 오른쪽 라인 번호 */
  line?: number;
  /** 원본 diff 왼쪽 라인 번호 */
  originalLine?: number;
  /** GitHub diff side 값 */
  side?: string;
  /** GitHub comment 생성 시각 */
  createdAt?: string;
}

/** VS Code 문서 한 줄에 표시할 PR review comment 묶음 */
export interface PullRequestThreadGroup<T extends PullRequestThreadComment> {
  /** VS Code 0-base line 번호 */
  line: number;
  /** 같은 line 에 표시할 comment 목록 */
  comments: T[];
}

/**
 * PR review comment 를 표시 line 별 thread 로 묶는다.
 * - GitHub 답글 comment 는 자체 line 이 없을 수 있으므로 부모 comment 의 line 을 따라간다.
 * - 같은 line 안에서는 GitHub 화면처럼 원댓글 뒤에 해당 답글이 이어지도록 정렬한다.
 * @param lineCount VS Code 문서 전체 라인 수
 * @param comments GitHub review comment 목록
 * @returns line 오름차순으로 정렬된 comment thread 그룹
 */
export function groupPullRequestThreadComments<T extends PullRequestThreadComment>(
  lineCount: number,
  comments: T[]
): Array<PullRequestThreadGroup<T>> {
  const byId = new Map(
    comments
      .map((comment) => [commentId(comment), comment] as const)
      .filter((entry): entry is [string, T] => entry[0] !== undefined)
  );
  const byLine = new Map<number, T[]>();
  for (const comment of comments) {
    const line = clampLine(lineCount, targetLineWithParent(comment, byId));
    if (line === undefined) {
      continue;
    }
    const list = byLine.get(line) || [];
    list.push(comment);
    byLine.set(line, list);
  }
  return Array.from(byLine.entries())
    .sort(([a], [b]) => a - b)
    .map(([line, list]) => ({
      line,
      comments: list.sort((a, b) => compareThreadOrder(a, b, byId)),
    }));
}

/**
 * 답글처럼 line 이 없는 comment 는 부모 comment 의 표시 라인을 사용한다.
 * @param comment 표시 라인을 찾을 comment
 * @param byId id -> comment 맵
 * @returns GitHub 1-base line 번호
 */
function targetLineWithParent<T extends PullRequestThreadComment>(
  comment: T,
  byId: Map<string, T>
): number | undefined {
  let current: T | undefined = comment;
  for (let depth = 0; current && depth < 10; depth++) {
    const line = targetLine(current);
    if (line !== undefined) {
      return line;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/**
 * 한 line 의 comments 를 GitHub thread 흐름처럼 정렬한다.
 * @param a 비교할 comment
 * @param b 비교할 comment
 * @param byId id -> comment 맵
 */
function compareThreadOrder<T extends PullRequestThreadComment>(
  a: T,
  b: T,
  byId: Map<string, T>
): number {
  const rootA = rootCommentId(a, byId);
  const rootB = rootCommentId(b, byId);
  if (rootA !== rootB) {
    return compareCreatedAt(byId.get(rootA) || a, byId.get(rootB) || b);
  }
  const idA = commentId(a);
  const idB = commentId(b);
  if (idA === rootA && idB !== rootB) {
    return -1;
  }
  if (idB === rootB && idA !== rootA) {
    return 1;
  }
  return compareCreatedAt(a, b);
}

/**
 * 답글 체인을 따라 thread root comment id 를 찾는다.
 * @param comment 시작 comment
 * @param byId id -> comment 맵
 * @returns root comment id. id 를 모르면 빈 문자열
 */
function rootCommentId<T extends PullRequestThreadComment>(
  comment: T,
  byId: Map<string, T>
): string {
  let current = comment;
  for (let depth = 0; current.parentId && depth < 10; depth++) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return commentId(current) || "";
}

/**
 * GitHub comment 의 side 정보를 고려해 표시할 대상 line 을 고른다.
 * @param comment GitHub inline review comment
 * @returns 1-base line 번호
 */
function targetLine(comment: PullRequestThreadComment): number | undefined {
  const side = (comment.side || "").toUpperCase();
  if (side === "LEFT") {
    return comment.originalLine || comment.line;
  }
  return comment.line || comment.originalLine;
}

/**
 * 1-base line 번호를 문서 범위 안의 0-base line 번호로 바꾼다.
 * @param lineCount 문서 전체 라인 수
 * @param oneBased GitHub 가 준 1-base line 번호
 * @returns VS Code 0-base line 번호. line 이 없으면 undefined
 */
function clampLine(lineCount: number, oneBased: number | undefined): number | undefined {
  if (!oneBased || lineCount <= 0) {
    return undefined;
  }
  return Math.min(Math.max(0, oneBased - 1), Math.max(0, lineCount - 1));
}

/** comment id 를 문자열 key 로 정규화한다. */
function commentId(comment: PullRequestThreadComment): string | undefined {
  return comment.id === undefined ? undefined : String(comment.id);
}

/** createdAt 기준으로 comment 를 정렬한다. */
function compareCreatedAt(
  a: PullRequestThreadComment | undefined,
  b: PullRequestThreadComment | undefined
): number {
  return dateMs(a?.createdAt) - dateMs(b?.createdAt);
}

/** ISO 날짜를 정렬용 timestamp 로 바꾼다. */
function dateMs(value: string | undefined): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}
