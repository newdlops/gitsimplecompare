// Reviews 큐의 page 병합 규칙을 VS Code webview 생명주기와 분리한다.
// - page 경계의 중복, 최신순 재정렬, 1,000건 상한을 한 곳에서 일관되게 처리한다.
import type { ReviewQueueLane, ReviewQueuePullRequest, ReviewQueueSnapshot } from "../git/pullRequestReviewModel";

/** 한 lane에 유지할 수 있는 최대 PR 수. GitHub search의 깊은 page 탐색을 의도적으로 제한한다. */
export const REVIEW_QUEUE_MAX_RESULTS = 1000;

/**
 * 새 page를 지정 lane에 중복 없이 병합하고 다음 cursor·부분 결과·상한 상태를 갱신한다.
 * @param snapshot 현재 화면이 표시 중인 immutable reviews snapshot
 * @param lane GitHub에서 추가 page를 받은 개인 또는 관리 큐 lane
 * @param nextItems 새 page에 포함된 PR 목록
 * @param nextCursor GitHub가 반환한 다음 page cursor. 없으면 해당 lane의 마지막 page다.
 * @returns 원본 snapshot을 바꾸지 않은 새 snapshot
 */
export function mergeReviewQueuePage(
  snapshot: ReviewQueueSnapshot,
  lane: ReviewQueueLane,
  nextItems: readonly ReviewQueuePullRequest[],
  nextCursor: string | undefined
): ReviewQueueSnapshot {
  const current = queueLaneItems(snapshot, lane);
  const merged = mergeQueueItems(snapshot.repository, current, nextItems).slice(0, REVIEW_QUEUE_MAX_RESULTS);
  const reachedCap = Boolean(nextCursor) && merged.length >= REVIEW_QUEUE_MAX_RESULTS;
  const nextCursors = { ...(snapshot.nextCursors || {}) };
  if (nextCursor && !reachedCap) nextCursors[lane] = nextCursor;
  else delete nextCursors[lane];
  const truncated = new Set(snapshot.truncatedLanes || []);
  if (nextCursor && !reachedCap) truncated.add(lane);
  else truncated.delete(lane);
  const personal = { ...snapshot.personal };
  let management = snapshot.management;
  if (lane === "management.open") management = { open: merged };
  else personal[lane.slice("personal.".length) as keyof typeof personal] = merged;
  const capped = new Set(snapshot.cappedLanes || []);
  if (reachedCap) capped.add(lane);
  else capped.delete(lane);
  return {
    ...snapshot,
    personal,
    management,
    ...(Object.keys(nextCursors).length ? { nextCursors } : { nextCursors: undefined }),
    ...(truncated.size ? { truncatedLanes: [...truncated] } : { truncatedLanes: undefined }),
    ...(capped.size ? { cappedLanes: [...capped] } : { cappedLanes: undefined }),
  };
}

/**
 * 요청한 lane이 현재 snapshot에서 가리키는 PR 목록을 반환한다.
 * @param snapshot 현재 Reviews 홈 읽기 모델
 * @param lane 읽을 personal 또는 management lane
 * @returns lane에 이미 표시된 PR 배열
 */
function queueLaneItems(snapshot: ReviewQueueSnapshot, lane: ReviewQueueLane): ReviewQueuePullRequest[] {
  if (lane === "management.open") return snapshot.management.open;
  return snapshot.personal[lane.slice("personal.".length) as keyof ReviewQueueSnapshot["personal"]];
}

/**
 * repository와 PR 번호를 키로 삼아 page 경계 중복을 제거하고 최신 갱신순으로 정렬한다.
 * @param defaultRepository 현재 workspace repository. PR에 repository가 없을 때 사용한다.
 * @param current 화면에 이미 있는 PR 목록
 * @param next 새 GitHub search page의 PR 목록
 * @returns 중복 없는 최신순 병합 결과
 */
function mergeQueueItems(defaultRepository: string, current: readonly ReviewQueuePullRequest[], next: readonly ReviewQueuePullRequest[]): ReviewQueuePullRequest[] {
  const merged = new Map<string, ReviewQueuePullRequest>();
  [...current, ...next].forEach((item) => merged.set(`${item.repository || defaultRepository}#${item.number}`, item));
  return [...merged.values()].sort((left, right) => (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0) || right.number - left.number);
}
