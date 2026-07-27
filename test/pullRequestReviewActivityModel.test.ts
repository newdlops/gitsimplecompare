import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewCenterActivityPage } from "../src/git/pullRequestReviewActivityModel";

test("PR activity는 comment·review·commit을 최신순 타임라인으로 합친다", () => {
  const page = normalizeReviewCenterActivityPage(
    { nodes: [{ id: "comment-1", body: "Question", createdAt: "2026-02-01T10:00:00Z", author: { login: "alice" } }] },
    { nodes: [{ id: "review-1", body: "Looks good", state: "APPROVED", submittedAt: "2026-02-02T10:00:00Z", author: { login: "bob" } }] },
    { nodes: [{ commit: { oid: "abc123def456", messageHeadline: "Fix review", committedDate: "2026-02-03T10:00:00Z", author: { user: { login: "carol" } } } }] }
  );

  assert.deepEqual(page.items.map((item) => [item.kind, item.author, item.body, item.state]), [
    ["commit", "carol", "Fix review", undefined],
    ["review", "bob", "Looks good", "APPROVED"],
    ["comment", "alice", "Question", undefined],
  ]);
  assert.equal(page.truncated, false);
});

test("activity는 원본 connection 중 하나라도 남았으면 truncated를 표시한다", () => {
  const page = normalizeReviewCenterActivityPage({ nodes: [], pageInfo: { hasNextPage: true } }, { nodes: [] }, { nodes: [] });
  assert.equal(page.truncated, true);
  assert.equal(page.eventsAvailable, true);
});

test("activity는 관리 이벤트와 force-push를 번역 가능한 event 모델로 정규화한다", () => {
  const page = normalizeReviewCenterActivityPage(
    { nodes: [] }, { nodes: [] }, { nodes: [] },
    { nodes: [
      { __typename: "ReviewRequestedEvent", id: "event-reviewer", createdAt: "2026-02-03T00:00:00Z", actor: { login: "lead" }, requestedReviewer: { name: "Platform" } },
      { __typename: "HeadRefForcePushedEvent", id: "event-force", createdAt: "2026-02-04T00:00:00Z", actor: { login: "author" }, beforeCommit: { oid: "a".repeat(40) }, afterCommit: { oid: "b".repeat(40) } },
    ], pageInfo: { hasPreviousPage: true } }
  );

  assert.deepEqual(page.items.map((item) => [item.kind, item.eventType, item.subject, item.author]), [
    ["event", "force-push", `${"a".repeat(12)} → ${"b".repeat(12)}`, "author"],
    ["event", "review-requested", "Platform", "lead"],
  ]);
  assert.equal(page.truncated, true);
});
