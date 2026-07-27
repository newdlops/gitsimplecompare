import assert from "node:assert/strict";
import test from "node:test";
import type { GhExecute } from "../src/git/ghRunner";
import { DefaultGhRunner } from "../src/git/ghRunner";
import { PullRequestReviewQueueService } from "../src/git/pullRequestReviewQueueService";
import { ReviewQueueFailure } from "../src/git/pullRequestReviewQueueFailure";

test("리뷰 큐 서비스는 personal과 management query를 동일 저장소에 대해 분리해 읽는다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.queue.repository") {
      return JSON.stringify({ nameWithOwner: "acme/demo" });
    }
    if (options.operation === "review.queue.identity") {
      return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    }
    const number = options.operation === "review.queue.management.open" ? 3 : 2;
    return JSON.stringify({
      data: { search: { nodes: [{ number, title: options.operation, url: `https://github.com/acme/demo/pull/${number}` }] } },
    });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.viewer, "alice");
  assert.equal(snapshot.personal.requested[0]?.number, 2);
  assert.equal(snapshot.personal.authored[0]?.number, 2);
  assert.equal(snapshot.personal.assigned[0]?.number, 2);
  assert.equal(snapshot.personal.mentioned[0]?.number, 2);
  assert.equal(snapshot.personal.participated[0]?.number, 2);
  assert.equal(snapshot.management.open[0]?.number, 3);
  assert.deepEqual(calls.map((call) => call.operation), [
    "review.queue.repository",
    "review.queue.identity",
    "review.queue.personal.requested",
    "review.queue.personal.authored",
    "review.queue.personal.assigned",
    "review.queue.personal.mentioned",
    "review.queue.personal.participated",
    "review.queue.management.open",
  ]);
  assert.ok(calls[2]?.args.some((arg) => arg.includes("review-requested:@me")));
  assert.ok(calls[2]?.args.some((arg) => arg.startsWith("searchQuery=repo:acme/demo")));
  assert.ok(calls[4]?.args.some((arg) => arg.includes("assignee:@me")));
  assert.ok(calls[5]?.args.some((arg) => arg.includes("mentions:@me")));
  assert.ok(calls[6]?.args.some((arg) => arg.includes("involves:@me -author:@me")));
  assert.ok(calls[7]?.args.some((arg) => arg.includes("repo:acme/demo is:pr is:open")));
});

test("선택한 saved queue query는 Management lane에만 추가하고 열린 PR 범위는 유지한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    return JSON.stringify({ data: { search: { nodes: [] } } });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  await service.getSnapshot({ managementQuery: "label:blocked review-requested:@me" });

  const management = calls.find((call) => call.operation === "review.queue.management.open");
  assert.ok(management?.args.some((arg) => arg.includes("repo:acme/demo is:pr is:open label:blocked review-requested:@me")));
  const personal = calls.find((call) => call.operation === "review.queue.personal.requested");
  assert.ok(personal?.args.some((arg) => !arg.includes("label:blocked")));
});

test("team scope는 repository 제한 없이 team-review-requested와 saved query를 Management lane에 결합한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    return JSON.stringify({ data: { search: { nodes: [] } } });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  await service.getSnapshot({ managementScope: { kind: "team", team: "acme/platform" }, managementQuery: "label:blocked" });

  const management = calls.find((call) => call.operation === "review.queue.management.open");
  assert.ok(management?.args.some((arg) => arg.includes("is:pr is:open team-review-requested:acme/platform label:blocked")));
  assert.equal(management?.args.some((arg) => arg.includes("repo:acme/demo")), false);
});

test("owner scope는 repository 제한 없이 owner qualifier와 saved query를 Management lane에 결합한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    return JSON.stringify({ data: { search: { nodes: [] } } });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  await service.getSnapshot({ managementScope: { kind: "owner", owner: "acme" }, managementQuery: "label:blocked" });

  const management = calls.find((call) => call.operation === "review.queue.management.open");
  assert.ok(management?.args.some((arg) => arg.includes("is:pr is:open user:acme label:blocked")));
  assert.equal(management?.args.some((arg) => arg.includes("repo:acme/demo")), false);
});

test("한 review lane이 실패해도 개인과 관리의 성공 lane을 유지하고 unavailable lane만 표시한다", async () => {
  const execute: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    if (options.operation === "review.queue.personal.mentioned") throw new Error("temporary GitHub failure");
    return JSON.stringify({ data: { search: { nodes: [{ number: 9, title: options.operation, url: "https://github.com/acme/demo/pull/9" }] } } });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.personal.requested[0]?.number, 9);
  assert.equal(snapshot.management.open[0]?.number, 9);
  assert.deepEqual(snapshot.personal.mentioned, []);
  assert.deepEqual(snapshot.unavailableLanes, ["personal.mentioned"]);
});

test("GitHub search에 다음 페이지가 있으면 해당 lane의 결과 일부 상태를 명시한다", async () => {
  const execute: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    return JSON.stringify({ data: { search: { nodes: [], pageInfo: { hasNextPage: options.operation === "review.queue.management.open" } } } });
  };
  const snapshot = await new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute)).getSnapshot();

  assert.deepEqual(snapshot.truncatedLanes, ["management.open"]);
});

test("queue 다음 page는 같은 Personal qualifier와 cursor로 읽고 새 cursor를 전달한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    if (options.operation === "review.queue.identity") return JSON.stringify({ data: { viewer: { login: "alice" }, repository: { nameWithOwner: "acme/demo" } } });
    return JSON.stringify({ data: { search: { nodes: [{ number: 22, title: "later", url: "https://github.com/acme/demo/pull/22" }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } } } });
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  const page = await service.getNextPage("acme/demo", "personal.requested", "cursor-1");

  assert.deepEqual(page.pullRequests.map((item) => item.number), [22]);
  assert.equal(page.nextCursor, "cursor-2");
  const call = calls.find((item) => item.operation === "review.queue.personal.requested");
  assert.ok(call?.args.includes("cursor=cursor-1"));
  assert.ok(call?.args.some((arg) => arg.includes("repo:acme/demo is:pr is:open review-requested:@me")));
});

test("identity 인증 실패는 provider가 shell을 고를 수 있는 typed auth failure로 전달한다", async () => {
  const execute: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "review.queue.repository") return JSON.stringify({ nameWithOwner: "acme/demo" });
    const error = new Error("HTTP 401: Bad credentials") as Error & { code?: unknown };
    error.code = 1;
    throw error;
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  await assert.rejects(
    service.getIdentity(),
    (error: unknown) => error instanceof ReviewQueueFailure && error.kind === "authRequired"
  );
});

test("다음 page 실패도 raw GitHub diagnostic 대신 typed rate-limit failure로 전달한다", async () => {
  const execute: GhExecute = async () => {
    throw new Error("HTTP 429: API rate limit exceeded");
  };
  const service = new PullRequestReviewQueueService("/fixture/repo", new DefaultGhRunner(execute));

  await assert.rejects(
    service.getNextPage("acme/demo", "management.open", "next-page"),
    (error: unknown) => error instanceof ReviewQueueFailure && error.kind === "rateLimited"
  );
});
