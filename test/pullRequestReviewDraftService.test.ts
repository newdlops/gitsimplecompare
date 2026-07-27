import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, type GhExecute } from "../src/git/ghRunner";
import {
  PullRequestReviewDraftService,
  type LocalPullRequestReviewDraft,
  type PullRequestReviewDraftStorage,
} from "../src/git/pullRequestReviewDraftService";

const target = { repository: "acme/demo", number: 7, pullRequestId: "PR_example", headOid: "abc123" };

class MemoryDraftStorage implements PullRequestReviewDraftStorage {
  public readonly values = new Map<string, unknown>();

  public async read(key: string): Promise<unknown> { return this.values.get(key); }
  public async write(key: string, value: LocalPullRequestReviewDraft): Promise<void> { this.values.set(key, value); }
  public async remove(key: string): Promise<void> { this.values.delete(key); }
}

test("pending review reconcile은 local/server 조합과 head 변경을 lossless하게 구분한다", async () => {
  const storage = new MemoryDraftStorage();
  const responses = [
    pendingResponse(undefined),
    pendingResponse({ id: "review-1", body: "server", updatedAt: "2026-07-26T01:00:00Z", headOid: "abc123" }),
    pendingResponse({ id: "review-2", body: "other pending", updatedAt: "2026-07-26T01:00:00Z", headOid: "abc123" }),
  ];
  const execute: GhExecute = async () => JSON.stringify(responses.shift() || pendingResponse(undefined));
  const service = new PullRequestReviewDraftService("/fixture/repo", storage, new DefaultGhRunner(execute));

  assert.deepEqual(await service.reconcile(target), { kind: "none" });
  assert.deepEqual(await service.reconcile(target), {
    kind: "serverOnly",
    server: { id: "review-1", body: "server", updatedAt: "2026-07-26T01:00:00Z", headOid: "abc123" },
  });

  await service.saveLocal(target, { body: "local", event: "COMMENT", reviewId: "review-1" });
  const linked = await service.reconcile(target);
  assert.equal(linked.kind, "conflict", "old local and unrelated server record must not overwrite either draft");

  const localOnlyStorage = new MemoryDraftStorage();
  const localOnly = new PullRequestReviewDraftService("/fixture/repo", localOnlyStorage, new DefaultGhRunner(async () => JSON.stringify(pendingResponse(undefined))));
  await localOnly.saveLocal(target, { body: "kept locally", event: "COMMENT" });
  assert.equal((await localOnly.reconcile(target)).kind, "localOnly");
  const changed = await localOnly.reconcile({ ...target, headOid: "def456" });
  assert.equal(changed.kind, "headChanged");
  assert.equal(changed.local?.body, "kept locally");

  const linkedStorage = new MemoryDraftStorage();
  const linkedService = new PullRequestReviewDraftService(
    "/fixture/repo",
    linkedStorage,
    new DefaultGhRunner(async () => JSON.stringify(pendingResponse({ id: "review-linked", body: "same", updatedAt: "2099-01-01T00:00:00Z", headOid: "abc123" })))
  );
  await linkedService.saveLocal(target, { body: "same", event: "COMMENT", reviewId: "review-linked" });
  const linkedSame = await linkedService.reconcile(target);
  assert.equal(linkedSame.kind, "linked");
  assert.equal(linkedSame.bodySource, "same");
});

test("existing viewer pending review는 새 create 없이 재사용한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify(pendingResponse({ id: "review-existing", body: "", headOid: "abc123" }));
  };
  const service = new PullRequestReviewDraftService("/fixture/repo", new MemoryDraftStorage(), new DefaultGhRunner(execute));

  const pending = await service.ensurePending(target, "draft summary");

  assert.equal(pending.id, "review-existing");
  assert.deepEqual(calls.map((call) => call.operation), ["review.draft.pending.read"]);
});

test("새 head에 연결된 pending review는 comment write 전에 재로딩을 요구한다", async () => {
  const calls: string[] = [];
  const service = new PullRequestReviewDraftService(
    "/fixture/repo",
    new MemoryDraftStorage(),
    new DefaultGhRunner(async (_args, _cwd, options) => {
      calls.push(options.operation);
      return JSON.stringify(pendingResponse({ id: "review-old-head", body: "", headOid: "old-head" }));
    })
  );

  await assert.rejects(() => service.ensurePending(target, "draft summary"), /New commits changed/);

  assert.deepEqual(calls, ["review.draft.pending.read"]);
});

test("새 pending review는 event 없이 현재 head와 client mutation id를 사용하고 응답을 검증한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  let reads = 0;
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.draft.pending.read") {
      reads += 1;
      return JSON.stringify(pendingResponse(undefined));
    }
    return JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id: "review-new", state: "PENDING", body: "summary", updatedAt: "2026-07-26T02:00:00Z", commit: { oid: "abc123" } } } } });
  };
  const service = new PullRequestReviewDraftService("/fixture/repo", new MemoryDraftStorage(), new DefaultGhRunner(execute));

  const pending = await service.ensurePending(target, "summary");

  assert.equal(reads, 1);
  assert.equal(pending.id, "review-new");
  const create = calls.find((call) => call.operation === "review.draft.pending.create");
  assert.ok(create?.args.includes("pullRequestId=PR_example"));
  assert.ok(create?.args.includes("commitOID=abc123"));
  assert.ok(create?.args.some((arg) => arg.includes("addPullRequestReview")));
  assert.ok(!create?.args.some((arg) => arg.includes("event:")));
});

test("pending create 응답이 실패해도 재조회로 하나를 찾으면 재전송하지 않고 복구한다", async () => {
  const calls: string[] = [];
  let reads = 0;
  const execute: GhExecute = async (_args, _cwd, options) => {
    calls.push(options.operation);
    if (options.operation === "review.draft.pending.read") {
      reads += 1;
      return JSON.stringify(reads === 1 ? pendingResponse(undefined) : pendingResponse({ id: "review-recovered", body: "", headOid: "abc123" }));
    }
    throw new Error("connection reset after GitHub accepted request");
  };
  const service = new PullRequestReviewDraftService("/fixture/repo", new MemoryDraftStorage(), new DefaultGhRunner(execute));

  const pending = await service.ensurePending(target, "summary");

  assert.equal(pending.id, "review-recovered");
  assert.deepEqual(calls, ["review.draft.pending.read", "review.draft.pending.create", "review.draft.pending.read"]);
});

test("discard는 server deletion 성공 뒤 local draft를 지운다", async () => {
  const storage = new MemoryDraftStorage();
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    return JSON.stringify({ data: { deletePullRequestReview: { clientMutationId: null } } });
  };
  const service = new PullRequestReviewDraftService("/fixture/repo", storage, new DefaultGhRunner(execute));
  await service.saveLocal(target, { reviewId: "review-delete", body: "keep until delete", event: "COMMENT" });

  await service.discard(target, "review-delete");

  assert.equal(calls[0]?.operation, "review.draft.pending.discard");
  assert.ok(calls[0]?.args.includes("reviewId=review-delete"));
  assert.equal(await service.loadLocal(target), undefined);
});

test("submit은 최신 pending review를 확인하고 성공 뒤에만 local draft를 지운다", async () => {
  const storage = new MemoryDraftStorage();
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.draft.pending.read") {
      return JSON.stringify(pendingResponse({ id: "review-submit", body: "old", headOid: "abc123" }));
    }
    return JSON.stringify({ data: { submitPullRequestReview: { pullRequestReview: { id: "review-submit", state: "APPROVED", submittedAt: "2026-07-26T03:00:00Z" } } } });
  };
  const service = new PullRequestReviewDraftService("/fixture/repo", storage, new DefaultGhRunner(execute));
  await service.saveLocal(target, { reviewId: "review-submit", body: "ship it", event: "APPROVE" });

  await service.submit(target, "review-submit", "APPROVE", "ship it");

  const submit = calls.find((call) => call.operation === "review.draft.pending.submit");
  assert.ok(submit?.args.includes("reviewId=review-submit"));
  assert.ok(submit?.args.includes("event=APPROVE"));
  assert.ok(submit?.args.some((arg) => arg.includes("submitPullRequestReview")));
  assert.equal(await service.loadLocal(target), undefined);
});

test("submit은 GitHub pending review가 바뀌면 write하지 않고 local draft를 보존한다", async () => {
  const storage = new MemoryDraftStorage();
  const calls: string[] = [];
  const service = new PullRequestReviewDraftService(
    "/fixture/repo",
    storage,
    new DefaultGhRunner(async (_args, _cwd, options) => {
      calls.push(options.operation);
      return JSON.stringify(pendingResponse({ id: "review-other", body: "", headOid: "abc123" }));
    })
  );
  await service.saveLocal(target, { reviewId: "review-submit", body: "keep me", event: "COMMENT" });

  await assert.rejects(() => service.submit(target, "review-submit", "COMMENT", "keep me"));

  assert.deepEqual(calls, ["review.draft.pending.read"]);
  assert.equal((await service.loadLocal(target))?.body, "keep me");
});

/** viewer 자신의 pending review만 보이는 GraphQL fixture 하나를 만든다. */
function pendingResponse(review?: { id: string; body: string; updatedAt?: string; headOid?: string }): unknown {
  return {
    data: {
      viewer: { login: "viewer" },
      repository: {
        pullRequest: {
          reviews: {
            nodes: review ? [{ id: review.id, state: "PENDING", body: review.body, updatedAt: review.updatedAt, author: { login: "viewer" }, commit: { oid: review.headOid } }] : [],
          },
        },
      },
    },
  };
}
