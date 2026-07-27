import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewQueuePullRequest, ReviewQueueSnapshot } from "../src/git/pullRequestReviewModel";
import { REVIEW_QUEUE_MAX_RESULTS, mergeReviewQueuePage } from "../src/webview/reviewQueuePaginationModel";

/** 테스트용 PR을 일정한 최신순 시각으로 만든다. */
function pullRequest(number: number, repository = "acme/demo"): ReviewQueuePullRequest {
  return { repository, number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`, author: "alice", updatedAt: `2026-01-01T00:${String(number % 60).padStart(2, "0")}:00Z`, isDraft: false, requestedReviewers: [], assignees: [], labels: [] };
}

/** 각 테스트가 필요한 최소 Reviews 큐 snapshot을 만든다. */
function snapshot(): ReviewQueueSnapshot {
  return { repository: "acme/demo", viewer: "alice", personal: { requested: [], authored: [], assigned: [], mentioned: [], participated: [] }, management: { open: [] }, refreshedAt: "2026-01-01T00:00:00Z" };
}

test("queue page 병합은 page 경계 중복을 제거하고 다음 cursor 상태를 유지한다", () => {
  const current = snapshot();
  current.personal.requested = [pullRequest(1), pullRequest(2)];
  current.nextCursors = { "personal.requested": "old-cursor" };
  current.truncatedLanes = ["personal.requested"];

  const merged = mergeReviewQueuePage(current, "personal.requested", [pullRequest(2), pullRequest(3)], "next-cursor");

  assert.deepEqual(merged.personal.requested.map((item) => item.number).sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(merged.nextCursors?.["personal.requested"], "next-cursor");
  assert.deepEqual(merged.truncatedLanes, ["personal.requested"]);
  assert.equal(merged.cappedLanes, undefined);
  assert.equal(current.personal.requested.length, 2);
});

test("관리 queue는 1,000건 상한에서 cursor를 중단하고 capped 상태를 표시한다", () => {
  const current = snapshot();
  current.management.open = Array.from({ length: 990 }, (_, index) => pullRequest(index + 1));
  current.nextCursors = { "management.open": "old-cursor" };
  current.truncatedLanes = ["management.open"];

  const merged = mergeReviewQueuePage(current, "management.open", Array.from({ length: 30 }, (_, index) => pullRequest(index + 991)), "later-cursor");

  assert.equal(merged.management.open.length, REVIEW_QUEUE_MAX_RESULTS);
  assert.equal(merged.nextCursors?.["management.open"], undefined);
  assert.equal(merged.truncatedLanes, undefined);
  assert.deepEqual(merged.cappedLanes, ["management.open"]);
});
