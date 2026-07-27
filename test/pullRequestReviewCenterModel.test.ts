import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReviewCenterSnapshot,
  normalizeReviewCenterFilesPage,
  normalizeReviewCenterThreadsPage,
  reviewCenterPreviewCommentsForFile,
} from "../src/git/pullRequestReviewCenterModel";

test("Review Center 모델은 파일 상태와 스레드 해결/오래됨 상태를 보존한다", () => {
  const snapshot = normalizeReviewCenterSnapshot("acme/demo", {
    number: 42,
    title: "Review me",
    url: "https://github.com/acme/demo/pull/42",
    author: { login: "alice" },
    assignees: { nodes: [{ login: "maintainer" }] },
    labels: { nodes: [{ name: "ready" }] },
    milestone: { number: 8, title: "Release" },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { login: "reviewer" } },
        { requestedReviewer: { slug: "platform", name: "Platform team" } },
      ],
    },
    viewerCanUpdate: true,
    files: {
      nodes: [{ path: "src/a.ts", additions: 4, deletions: 1, changeType: "RENAMED", previousFilename: "src/old.ts", viewerViewedState: "VIEWED" }],
      pageInfo: { hasNextPage: true },
    },
    reviewThreads: {
      nodes: [{
        id: "thread-1", path: "src/a.ts", line: 12, startLine: 10, isOutdated: true, isResolved: false,
        comments: { nodes: [{ id: "comment-1", body: "Please adjust", createdAt: "2026-07-20T00:00:00Z", author: { login: "bob" } }] },
      }],
      pageInfo: { hasNextPage: true },
    },
  }, 42, "2026-07-26T00:00:00Z");

  assert.deepEqual(snapshot.files, [{ path: "src/a.ts", oldPath: "src/old.ts", status: "R", additions: 4, deletions: 1, isViewed: true }]);
  assert.equal(snapshot.filesTruncated, true);
  assert.equal(snapshot.threadsTruncated, true);
  assert.deepEqual(snapshot.assignees, ["maintainer"]);
  assert.deepEqual(snapshot.labels, ["ready"]);
  assert.deepEqual(snapshot.milestone, { number: 8, title: "Release" });
  assert.deepEqual(snapshot.requestedReviewers, [
    { kind: "team", key: "platform", label: "Platform team" },
    { kind: "user", key: "reviewer", label: "reviewer" },
  ]);
  assert.equal(snapshot.viewerCanUpdate, true);
  assert.deepEqual(snapshot.threads[0], {
    id: "thread-1", path: "src/a.ts", line: 12, startLine: 10,
    isOutdated: true, isResolved: false,
    comments: [{ id: "comment-1", author: "bob", body: "Please adjust", createdAt: "2026-07-20T00:00:00Z", suggestions: [] }],
  });
  assert.deepEqual(reviewCenterPreviewCommentsForFile(snapshot, "src/a.ts"), []);
  snapshot.threads[0].isOutdated = false;
  assert.deepEqual(reviewCenterPreviewCommentsForFile(snapshot, "src/a.ts"), [{
    id: "comment-1", parentId: "thread-1", author: "bob", body: "Please adjust", diffHunk: "",
    line: 12, startLine: 10, side: "RIGHT", startSide: "RIGHT", createdAt: "2026-07-20T00:00:00Z",
  }]);
});

test("Review Center 페이지 모델은 실제 cursor가 있을 때만 다음 페이지를 허용한다", () => {
  const files = normalizeReviewCenterFilesPage({
    nodes: [{ path: "src/b.ts", additions: 2, deletions: 0, changeType: "ADDED" }],
    pageInfo: { hasNextPage: true, endCursor: "files-cursor" },
  });
  const threads = normalizeReviewCenterThreadsPage({
    nodes: [],
    pageInfo: { hasNextPage: true, endCursor: null },
  });

  assert.deepEqual(files, {
    files: [{ path: "src/b.ts", status: "A", additions: 2, deletions: 0, isViewed: false }],
    hasNextPage: true,
    endCursor: "files-cursor",
  });
  assert.deepEqual(threads, { threads: [], hasNextPage: false, endCursor: undefined });
});

test("Review Center 모델은 위치/URL이 손상된 항목을 안전하게 보정한다", () => {
  const snapshot = normalizeReviewCenterSnapshot("acme/demo", {
    number: 4, url: "https://github.com/acme/demo/pull/4",
    files: { nodes: [{ path: "", additions: -1 }, { path: "b.ts", changeType: "unknown" }] },
    reviewThreads: { nodes: [{ id: "", comments: { nodes: [] } }] },
  }, 4);

  assert.deepEqual(snapshot.files, [{ path: "b.ts", status: "M", additions: 0, deletions: 0, isViewed: false }]);
  assert.deepEqual(snapshot.threads, []);
});
