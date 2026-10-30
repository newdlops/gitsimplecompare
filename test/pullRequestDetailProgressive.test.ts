import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequestDetail, type PullRequestDetailInfo } from "../src/git/pullRequestDetail";

/** 응답 순서를 네트워크 시간 대신 명시적으로 제어하는 완료 신호다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** 같은 PR 앵커와 검증 가능한 GraphQL 연결을 만든다. */
function response(value: Record<string, unknown>, headRefOid = "head") {
  return JSON.stringify({ data: { repository: { pullRequest: { number: 7, headRefOid, baseRefOid: "base", ...value } } } });
}
/** 끝 또는 다음 커서가 있는 실제 connection 구조를 만든다. */
function page(nodes: unknown[], cursor?: string, totalCount?: number) {
  return { nodes, totalCount, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor || null } };
}
/** 경로·상태·변경량을 갖춘 파일을 반환한다. */
function file(path: string) { return { path, additions: 2, deletions: 1, changeType: "MODIFIED" }; }

test("changed files become usable page by page before slow review comments finish", async () => {
  const fileGate = deferred(), threadGate = deferred(), first = deferred(), allFiles = deferred();
  const progress: PullRequestDetailInfo[] = [], queries: string[] = [];
  let finished = false;
  const pending = fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (args, _root, options) => {
    queries.push(args.find(arg => arg.startsWith("query="))!);
    if (options.operation === "pr-detail") return response({ comments: { totalCount: 3 }, files: page([file("a.ts")], "files-2", 2) });
    if (options.operation === "pr-detail-files") { await fileGate.promise; return response({ files: page([file("b.ts")]) }); }
    await threadGate.promise;
    return response({ reviewThreads: page([{ path: "a.ts", comments: { totalCount: 4 } }]) });
  }, value => {
    progress.push(value); first.resolve();
    if (!value.filesLoading && value.files.length === 2) allFiles.resolve();
  }).finally(() => { finished = true; });
  try {
    await first.promise;
    assert.deepEqual(progress[0].files.map(item => item.path), ["a.ts"]);
    assert.equal(progress[0].filesLoading, true); assert.equal(progress[0].reviewThreadsLoading, true);
    assert.equal(queries[0].includes("reviewThreads("), false, "the first file response must not carry the expensive review connection");
    fileGate.resolve(); await allFiles.promise;
    assert.equal(finished, false, "files must be usable while the exact comment query is still pending");
    assert.deepEqual(progress[0].files.map(item => item.path), ["a.ts"], "later pages must not mutate already published DTOs");
    threadGate.resolve();
    const result = await pending;
    assert.deepEqual(result.files.map(item => [item.path, item.commentCount]), [["a.ts", 4], ["b.ts", 0]]);
    assert.equal(result.commentCount, 7); assert.equal(result.filesTruncated, false);
  } finally { fileGate.resolve(); threadGate.resolve(); await pending; }
});

test("a failed comment read retains every changed file and reports comments as unavailable", async () => {
  let fileSignal!: AbortSignal;
  const result = await fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _root, options) => {
    if (options.operation === "pr-detail") return response({ comments: { totalCount: 3 }, files: page([file("a")], "next", 2) });
    if (options.operation === "pr-detail-files") {
      fileSignal = options.signal!; await new Promise(resolve => setImmediate(resolve));
      assert.equal(fileSignal.aborted, false); return response({ files: page([file("b")]) });
    }
    throw new Error("review API unavailable");
  }, () => {});
  assert.deepEqual(result.files.map(item => item.path), ["a", "b"]);
  assert.equal(result.reviewThreadsError, "review API unavailable");
  assert.equal(result.filesTruncated, false);
});

test("a changed file-page anchor never publishes files from two PR revisions", async () => {
  const progress: PullRequestDetailInfo[] = [];
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, undefined, async (_args, _root, options) => {
    if (options.operation === "pr-detail") return response({ comments: { totalCount: 0 }, files: page([file("old")], "next", 2) });
    if (options.operation === "pr-detail-files") return response({ files: page([file("new")]) }, "new-head");
    return response({ reviewThreads: page([]) });
  }, value => progress.push(value)), /head\/base changed/);
  assert.ok(progress.length > 0);
  assert.ok(progress.every(value => value.files.every(item => item.path === "old")));
});

test("cancelling from the first file publication starts no background review queries", async () => {
  const controller = new AbortController();
  let calls = 0, publications = 0;
  await assert.rejects(fetchPullRequestDetail("/repo", "owner/repo", 7, controller.signal, async () => {
    calls++; return response({ comments: { totalCount: 0 }, files: page([file("a")], "next", 2) });
  }, () => { publications++; controller.abort(); }), { name: "AbortError" });
  assert.equal(calls, 1); assert.equal(publications, 1);
});
