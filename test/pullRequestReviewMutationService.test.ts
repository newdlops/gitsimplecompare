import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, type GhExecute } from "../src/git/ghRunner";
import { PullRequestReviewMutationService } from "../src/git/pullRequestReviewMutationService";
import { PullRequestReviewDraftService, type PullRequestReviewDraftStorage } from "../src/git/pullRequestReviewDraftService";
import { normalizePullRequestReviewLocation } from "../src/git/pullRequestReviewLocation";

const target = { repository: "acme/demo", number: 7, pullRequestId: "PR_example", headOid: "abc123" };

test("review location은 file/single/multi-line anchor와 unsafe range를 구분한다", () => {
  assert.deepEqual(normalizePullRequestReviewLocation({ path: "src/a.ts", subjectType: "FILE" }), { path: "src/a.ts", subjectType: "FILE" });
  assert.deepEqual(normalizePullRequestReviewLocation({ path: "src/a.ts", subjectType: "LINE", side: "RIGHT", line: 8 }), { path: "src/a.ts", subjectType: "LINE", side: "RIGHT", line: 8 });
  assert.deepEqual(
    normalizePullRequestReviewLocation({ path: "src/a.ts", subjectType: "LINE", side: "RIGHT", line: 8, startSide: "RIGHT", startLine: 4 }),
    { path: "src/a.ts", subjectType: "LINE", side: "RIGHT", line: 8, startSide: "RIGHT", startLine: 4 }
  );
  assert.throws(() => normalizePullRequestReviewLocation({ path: "../secret", subjectType: "FILE" }));
  assert.throws(() => normalizePullRequestReviewLocation({ path: "src/a.ts", subjectType: "LINE", side: "LEFT", line: 8, startSide: "RIGHT", startLine: 4 }));
});

test("새 thread는 pending review를 만들거나 재사용한 뒤 GitHub location input으로 전송한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.draft.pending.read") return JSON.stringify(noPending());
    if (options.operation === "review.draft.pending.create") return JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id: "review-1", state: "PENDING", body: "summary", commit: { oid: "abc123" } } } } });
    return JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "thread-1" } } } });
  };
  const runner = new DefaultGhRunner(execute);
  const drafts = new PullRequestReviewDraftService("/fixture/repo", memoryStorage(), runner);
  const service = new PullRequestReviewMutationService("/fixture/repo", drafts, runner);

  const added = await service.addThread(target, {
    body: "Please adjust this.", reviewBody: "summary",
    location: { path: "src/a.ts", subjectType: "LINE", side: "RIGHT", line: 12, startSide: "RIGHT", startLine: 10 },
  });

  assert.equal(added.id, "thread-1");
  const thread = calls.find((call) => call.operation === "review.thread.add");
  assert.ok(thread?.args.includes("pullRequestId=PR_example"));
  assert.ok(thread?.args.includes("reviewId=review-1"));
  assert.ok(thread?.args.includes("line=12"));
  assert.ok(thread?.args.includes("startLine=10"));
  assert.ok(thread?.args.some((arg) => arg.includes("subjectType: LINE") && arg.includes("startSide: RIGHT")));
});

test("file-level thread는 line 변수 없이 기존 pending review에 추가한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.draft.pending.read") {
      return JSON.stringify({ data: { viewer: { login: "viewer" }, repository: { pullRequest: { reviews: { nodes: [
        { id: "review-existing", state: "PENDING", body: "", author: { login: "viewer" }, commit: { oid: "abc123" } },
      ] } } } } });
    }
    return JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "thread-file" } } } });
  };
  const runner = new DefaultGhRunner(execute);
  const service = new PullRequestReviewMutationService("/fixture/repo", new PullRequestReviewDraftService("/fixture/repo", memoryStorage(), runner), runner);

  const added = await service.addThread(target, {
    body: "This file needs a follow-up.", reviewBody: "", location: { path: "src/a.ts", subjectType: "FILE" },
  });

  assert.equal(added.reviewId, "review-existing");
  assert.equal(calls.filter((call) => call.operation === "review.draft.pending.create").length, 0);
  const thread = calls.find((call) => call.operation === "review.thread.add");
  assert.ok(thread?.args.some((arg) => arg.includes("subjectType: FILE")));
  assert.equal(thread?.args.some((arg) => arg.startsWith("line=")), false);
});

test("기존 thread 답글은 새 review를 만들지 않고 같은 pending review에 추가한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.draft.pending.read") {
      return JSON.stringify({ data: { viewer: { login: "viewer" }, repository: { pullRequest: { reviews: { nodes: [
        { id: "review-existing", state: "PENDING", body: "summary", author: { login: "viewer" }, commit: { oid: "abc123" } },
      ] } } } } });
    }
    return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "reply-1" } } } });
  };
  const runner = new DefaultGhRunner(execute);
  const service = new PullRequestReviewMutationService("/fixture/repo", new PullRequestReviewDraftService("/fixture/repo", memoryStorage(), runner), runner);

  const added = await service.addReply(target, "thread-1", "Please address this.", "summary");

  assert.deepEqual(added, { id: "reply-1", reviewId: "review-existing" });
  assert.equal(calls.filter((call) => call.operation === "review.draft.pending.create").length, 0);
  const reply = calls.find((call) => call.operation === "review.thread.reply");
  assert.ok(reply?.args.includes("threadId=thread-1"));
  assert.ok(reply?.args.includes("reviewId=review-existing"));
  assert.ok(reply?.args.some((arg) => arg.includes("addPullRequestReviewThreadReply")));
});

test("본인 review comment 수정은 GraphQL input과 GitHub 반환 id를 모두 검증한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: "comment-1" } } } });
  };
  const runner = new DefaultGhRunner(execute);
  const service = new PullRequestReviewMutationService("/fixture/repo", new PullRequestReviewDraftService("/fixture/repo", memoryStorage(), runner), runner);

  await service.updateComment("comment-1", "Updated feedback");

  const mutation = calls.find((call) => call.operation === "review.comment.update");
  assert.ok(mutation?.args.includes("commentId=comment-1"));
  assert.ok(mutation?.args.includes("body=Updated feedback"));
  assert.ok(mutation?.args.some((arg) => arg.includes("updatePullRequestReviewComment") && arg.includes("pullRequestReviewCommentId")));
});

test("본인 review comment 삭제는 GitHub가 삭제한 동일 id를 반환해야 성공한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id: "comment-1" } } } });
  };
  const runner = new DefaultGhRunner(execute);
  const service = new PullRequestReviewMutationService("/fixture/repo", new PullRequestReviewDraftService("/fixture/repo", memoryStorage(), runner), runner);

  await service.deleteComment("comment-1");

  const mutation = calls.find((call) => call.operation === "review.comment.delete");
  assert.ok(mutation?.args.includes("commentId=comment-1"));
  assert.ok(mutation?.args.some((arg) => arg.includes("deletePullRequestReviewComment") && arg.includes("input: { id: $commentId }")));
});

/** draft service가 테스트에서 local write를 시도해도 외부 상태를 만들지 않는 storage. */
function memoryStorage(): PullRequestReviewDraftStorage {
  return { read: async () => undefined, write: async () => undefined, remove: async () => undefined };
}

/** viewer에게 연결된 pending review가 없는 GraphQL fixture. */
function noPending(): unknown {
  return { data: { viewer: { login: "viewer" }, repository: { pullRequest: { reviews: { nodes: [] } } } } };
}
