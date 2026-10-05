import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequestDetail } from "../src/git/pullRequestDetail";
import type { GhExecute } from "../src/git/ghRunner";

/** 테스트의 PR 앵커와 두 연결을 실제 GraphQL 응답 형태로 감싼다. */
function response(value: Record<string, unknown>): string {
  return JSON.stringify({ data: { repository: { pullRequest: { number: 7, headRefOid: "head", baseRefOid: "base", ...value } } } });
}
/** 마지막 페이지 또는 지정 커서가 있는 연결을 만든다. */
function page(nodes: unknown[], cursor?: string, totalCount?: number) {
  return { nodes, pageInfo: { hasNextPage: cursor !== undefined, endCursor: cursor ?? null }, totalCount };
}
/** 첫 상세 응답을 만들며 의도적으로 깨진 연결을 overrides로 주입한다. */
function root(overrides: Record<string, unknown> = {}): string {
  return response({ comments: { totalCount: 3 }, files: page([file("a")], undefined, 1), reviewThreads: page([]), ...overrides });
}
/** 변경량과 상태를 모두 가진 changed file fixture다. */
function file(path: string) { return { path, additions: 2, deletions: 1, changeType: "MODIFIED" }; }
/** 각 요청의 루트/파일/스레드 꼬리를 관찰용 작업 이름으로 판별한다. */
function runner(rootValue: string, files?: string, threads?: string): GhExecute {
  return async (_args, _cwd, options) => options.operation === "pr-detail" ? rootValue :
    options.operation === "pr-detail-files" ? files! : threads!;
}

test("detail retains every file and review comment while paginating both tails concurrently", async () => {
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const result = await fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _cwd, options) => {
    calls.push(options.operation!);
    if (options.operation === "pr-detail") return root({ files: page([file("a")], "f1", 2),
      reviewThreads: page([{ path: "a", comments: { totalCount: 2 } }], "t1") });
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return options.operation === "pr-detail-files" ? response({ files: page([file("b")]) }) :
      response({ reviewThreads: page([{ path: "a", comments: { totalCount: 4 } }, { path: "b", comments: { totalCount: 1 } }]) });
  });
  assert.equal(maximum, 2); assert.equal(calls.length, 3);
  assert.deepEqual(result, { number: 7, commentCount: 10, fileCommentCount: 7, fileCount: 2,
    files: [{ path: "a", status: "M", additions: 2, deletions: 1, commentCount: 6 },
      { path: "b", status: "M", additions: 2, deletions: 1, commentCount: 1 }], filesTruncated: false, reviewThreadsTruncated: false });
});

test("missing root connections, scalars and pagination metadata cannot become an empty successful detail", async () => {
  for (const overrides of [ { files: null }, { reviewThreads: null }, { comments: {} },
    { files: { nodes: [], totalCount: 0 } }, { files: page([{}], undefined, 1) },
    { reviewThreads: page([{ path: "a", comments: {} }]) }, { headRefOid: null },
    { files: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: true, endCursor: null } } } ]) {
    await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, runner(root(overrides))), /incomplete/i);
  }
});

test("a missing tail connection and a repeated cursor are rejected instead of being treated as complete", async () => {
  const first = root({ files: page([file("a")], "f1", 2) });
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, runner(first, response({}))), /files page is incomplete/i);
  let tails = 0;
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _cwd, options) => {
    if (options.operation === "pr-detail") return first;
    tails++; return response({ files: page([file("b")], "f1") });
  }), /cursor repeated/i);
  assert.equal(tails, 1);
});

test("HEAD or base changes during either tail reject a mixed detail snapshot", async () => {
  for (const kind of ["files", "reviewThreads"] as const) for (const oid of ["headRefOid", "baseRefOid"]) {
    const first = root({ [kind]: page(kind === "files" ? [file("a")] : [], "next", kind === "files" ? 2 : undefined) });
    const next = response({ [oid]: "changed", [kind]: page(kind === "files" ? [file("b")] : []) });
    await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, runner(first, next, next)), /head\/base changed/i);
  }
});

test("file counts and GraphQL partial errors cannot mark incomplete results as complete", async () => {
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, runner(root({ files: page([], undefined, 3) }))), /pagination is incomplete/i);
  const partial = JSON.stringify({ ...JSON.parse(root()), errors: [{ message: "partial" }] });
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, runner(partial)), /incomplete/i);
});

test("one failing tail cancels its peer and preserves the original failure", async () => {
  let peerCancelled = false;
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _cwd, options) => {
    if (options.operation === "pr-detail") return root({ files: page([file("a")], "f1", 2), reviewThreads: page([], "t1") });
    if (options.operation === "pr-detail-files") throw new Error("file page failed");
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      peerCancelled = true; reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  }), /file page failed/);
  assert.equal(peerCancelled, true);
});

test("caller cancellation suppresses a late root response and performs no tail queries", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, controller.signal, async () => {
    calls++; controller.abort(); return root({ files: page([file("a")], "next", 2) });
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("the existing page cap remains explicit and cannot silently drop a remaining page", async () => {
  let calls = 0;
  const result = await fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _cwd, options) => {
    calls++;
    return options.operation === "pr-detail" ? root({ files: page([file("1")], "1", 21) }) :
      response({ files: page([file(String(calls))], String(calls)) });
  });
  assert.equal(calls, 20); assert.equal(result.files.length, 20);
  assert.equal(result.fileCount, 21); assert.equal(result.filesTruncated, true);
});
