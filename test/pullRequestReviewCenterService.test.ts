import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, type GhExecute } from "../src/git/ghRunner";
import { PullRequestReviewCenterService } from "../src/git/pullRequestReviewCenterService";

test("Review Center 서비스는 하나의 PR에 필요한 파일과 thread를 GraphQL로 요청한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.center.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    return JSON.stringify({ data: { viewer: { login: "reviewer" }, repository: { nameWithOwner: "acme/demo", pullRequest: {
      number: 7, title: "Center", url: "https://github.com/acme/demo/pull/7", files: { nodes: [] }, reviewThreads: { nodes: [] },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot(7);

  assert.equal(snapshot.number, 7);
  assert.equal(snapshot.viewer, "reviewer");
  assert.deepEqual(calls.map((call) => call.operation), ["review.center.repository", "review.center.snapshot"]);
  assert.ok(calls[1]?.args.includes("number=7"));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("reviewThreads(first: $limit)")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("endCursor")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("viewerCanUpdate")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("reviewRequests(first: 100)") && arg.includes("requestedReviewer")));
  assert.equal(calls[1]?.args.some((arg) => arg.includes("requestedReviewers")), false);
  assert.ok(calls[1]?.args.some((arg) => arg.includes("milestone { number title }")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("viewer { login }")));
});

test("Review Center 서비스는 명시된 cross-repository를 읽고 현재 workspace repository 조회를 건너뛴다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { repository: { nameWithOwner: "acme/other", pullRequest: {
      number: 11, title: "Cross repository", url: "https://github.com/acme/other/pull/11", files: { nodes: [] }, reviewThreads: { nodes: [] },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot(11, { repository: "acme/other" });

  assert.equal(snapshot.repository, "acme/other");
  assert.deepEqual(calls.map((call) => call.operation), ["review.center.snapshot"]);
  assert.ok(calls[0]?.args.includes("owner=acme"));
  assert.ok(calls[0]?.args.includes("name=other"));
});

test("Review Center 서비스는 files와 thread의 후속 GraphQL page를 cursor별로 읽는다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.center.files.page") {
      return JSON.stringify({ data: { repository: { pullRequest: {
        files: { nodes: [{ path: "src/later.ts", additions: 1, deletions: 2, changeType: "MODIFIED" }], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } });
    }
    return JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ id: "thread-later", path: "src/later.ts", line: 5, comments: { nodes: [] } }], pageInfo: { hasNextPage: true, endCursor: "next-threads" } },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const [files, threads] = await Promise.all([
    service.getFilesPage("acme/demo", 7, "files-cursor"),
    service.getThreadsPage("acme/demo", 7, "threads-cursor"),
  ]);

  assert.equal(files.files[0]?.path, "src/later.ts");
  assert.equal(files.hasNextPage, false);
  assert.equal(threads.threads[0]?.id, "thread-later");
  assert.equal(threads.endCursor, "next-threads");
  assert.ok(calls.some((call) => call.operation === "review.center.files.page" && call.args.includes("cursor=files-cursor")));
  assert.ok(calls.some((call) => call.operation === "review.center.threads.page" && call.args.includes("cursor=threads-cursor")));
});

test("Review Center 서비스는 Commits 탭을 열 때만 commit 첫 페이지를 읽고 100개 cap 상태를 보존한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { repository: { pullRequest: {
      commits: { nodes: [
        { commit: { oid: "a".repeat(40), messageHeadline: "Add review commits", authoredDate: "2026-01-02T03:04:05Z", author: { user: { login: "octo" } } } },
      ], pageInfo: { hasNextPage: true, endCursor: "more" } },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const page = await service.getCommitsPage("acme/demo", 7);

  assert.deepEqual(page.commits, [{ oid: "a".repeat(40), message: "Add review commits", author: "octo", authoredAt: "2026-01-02T03:04:05Z" }]);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, "more");
  assert.equal(calls[0]?.operation, "review.center.commits.page");
  assert.ok(calls[0]?.args.includes("limit=100"));
  assert.ok(calls[0]?.args.some((arg) => arg.includes("messageHeadline") && arg.includes("author { name user { login } }")));
});

test("Review Center 서비스는 Activity 탭을 열 때만 comment·review·commit 타임라인을 읽는다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { repository: { pullRequest: {
      comments: { nodes: [{ id: "comment-1", body: "Question", createdAt: "2026-01-01T00:00:00Z", author: { login: "alice" } }], pageInfo: { hasNextPage: false } },
      reviews: { nodes: [{ id: "review-1", body: "Approve", state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", author: { login: "bob" } }], pageInfo: { hasNextPage: false } },
      commits: { nodes: [{ commit: { oid: "a".repeat(40), messageHeadline: "Address feedback", committedDate: "2026-01-03T00:00:00Z", author: { user: { login: "carol" } } } }], pageInfo: { hasNextPage: true } },
      timelineItems: { nodes: [{ __typename: "LabeledEvent", id: "event-1", createdAt: "2026-01-04T00:00:00Z", actor: { login: "lead" }, label: { name: "blocked" } }], pageInfo: { hasPreviousPage: false } },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const page = await service.getActivityPage("acme/demo", 7);

  assert.deepEqual(page.items.map((item) => item.kind), ["event", "commit", "review", "comment"]);
  assert.equal(page.truncated, true);
  assert.equal(page.eventsAvailable, true);
  assert.equal(calls[0]?.operation, "review.center.activity.page");
  assert.ok(calls[0]?.args.includes("limit=100"));
  assert.ok(calls[0]?.args.some((arg) => arg.includes("comments(last: $limit)") && arg.includes("reviews(last: $limit)") && arg.includes("commits(last: $limit)") && arg.includes("timelineItems(last: $limit)") && arg.includes("HeadRefForcePushedEvent") && arg.includes("MilestonedEvent")));
});

test("Review Center Activity는 timeline event schema가 없으면 core activity를 보존해 다시 읽는다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.center.activity.page") throw new Error('Cannot query field "timelineItems" on type "PullRequest".');
    return JSON.stringify({ data: { repository: { pullRequest: {
      comments: { nodes: [{ id: "comment-1", body: "Still available", createdAt: "2026-01-01T00:00:00Z", author: { login: "alice" } }], pageInfo: { hasPreviousPage: false } },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } }, commits: { nodes: [], pageInfo: { hasPreviousPage: false } },
    } } } });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  const page = await service.getActivityPage("acme/demo", 7);

  assert.deepEqual(page.items.map((item) => item.body), ["Still available"]);
  assert.equal(page.eventsAvailable, false);
  assert.deepEqual(calls.map((call) => call.operation), ["review.center.activity.page", "review.center.activity.core"]);
  assert.equal(calls[1]?.args.some((arg) => arg.includes("timelineItems")), false);
});

test("Review Center 서비스는 GitHub Viewed mutation을 파일 경로와 PR node id로 보낸다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: {} });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  await service.setFileViewed("PR_kwDOExample", "src/review.ts", true);
  await service.setFileViewed("PR_kwDOExample", "src/review.ts", false);

  assert.deepEqual(calls.map((call) => call.operation), ["review.center.files.viewed", "review.center.files.unviewed"]);
  assert.ok(calls[0]?.args.includes("pullRequestId=PR_kwDOExample"));
  assert.ok(calls[0]?.args.includes("path=src/review.ts"));
  assert.ok(calls[0]?.args.some((arg) => arg.includes("markFileAsViewed")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("unmarkFileAsViewed")));
});

test("Review Center 서비스는 review thread를 resolve와 unresolve로 각각 변경한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: {} });
  };
  const service = new PullRequestReviewCenterService("/fixture/repo", new DefaultGhRunner(execute));

  await service.setThreadResolved("PRRT_kwDOExample", true);
  await service.setThreadResolved("PRRT_kwDOExample", false);

  assert.deepEqual(calls.map((call) => call.operation), ["review.center.threads.resolve", "review.center.threads.unresolve"]);
  assert.ok(calls[0]?.args.includes("threadId=PRRT_kwDOExample"));
  assert.ok(calls[0]?.args.some((arg) => arg.includes("resolveReviewThread")));
  assert.ok(calls[1]?.args.some((arg) => arg.includes("unresolveReviewThread")));
});
