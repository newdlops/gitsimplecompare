import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPullRequestDetail } from "../src/git/pullRequestDetail";
import { GitHubPullRequestSnapshots } from "../src/git/githubPullRequestSnapshots";
import type { GhExecute } from "../src/git/ghRunner";
import { GitHubApiError } from "../src/git/githubApiError";

/** 실제 세션 문맥 검사와 독립된 raw snapshot 저장소를 함께 쓰는 공개 형태의 PR fixture다. */
async function fixture(t: test.TestContext, initialCount = 738) {
  const root = await mkdtemp(join(tmpdir(), "gsc-pr-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots = new GitHubPullRequestSnapshots();
  const data = { head: "head", base: "base", count: initialCount, comments: 2, auth: "account-one", failThreads: false,
    threadTail: false, calls: 0, fileReads: 0, duplicate: false, cancel: undefined as (() => void) | undefined,
    failCombined: false, missingThreads: false, combinedError: undefined as Error | undefined };
  const runner: GhExecute = async (args, _cwd, options) => {
    data.calls++;
    Object.assign(options.readSession!, { scope: { host: "github.com", name: "owner/repo", owner: "owner", repository: "repo" },
      credentialKey: data.auth, snapshots });
    const query = options.request?.kind === "graphql" ? options.request.query : args.find(value => value.startsWith("query="))!.slice(6);
    const cursor = args.find(value => value.startsWith("cursor="))?.slice(7);
    const files = query.includes("nodes { path additions");
    const threads = query.includes("reviewThreads(");
    if (data.failCombined && threads) throw data.combinedError ?? new Error("fixture review failure");
    const pr: any = { number: 7, headRefOid: data.head, baseRefOid: data.base, comments: { totalCount: 1 } };
    if (query.includes("files")) {
      pr.files = { totalCount: data.count };
      if (files) {
        data.fileReads++;
        const offset = cursor ? Number(cursor) : 0;
        pr.files.nodes = Array.from({ length: Math.min(100, data.count - offset) }, (_, index) => ({
          path: `${data.duplicate ? 0 : offset + index}.ts`, additions: 1, deletions: 0, changeType: "ADDED" }));
        pr.files.pageInfo = { hasNextPage: offset + 100 < data.count, endCursor: String(offset + 100) };
      }
    }
    if (threads) {
      if (data.failThreads) throw new Error("fixture review failure");
      pr.reviewThreads = { nodes: [{ path: "0.ts", comments: { totalCount: data.comments } }],
        pageInfo: { hasNextPage: data.threadTail && !cursor, endCursor: "threads-next" } };
    }
    if (data.missingThreads) delete pr.reviewThreads;
    data.cancel?.();
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: pr } } });
  };
  const read = (onProgress?: (value: any) => void, signal?: AbortSignal) => fetchPullRequestDetail(root, "owner/repo", 7, signal, runner, onProgress);
  return { data, snapshots, read };
}

test("738 immutable files reopen with one fresh anchor/thread API and fresh comment decoration", async t => {
  const f = await fixture(t);
  const first = await f.read(() => {}); assert.equal(f.data.calls, 9); assert.equal(first.files.length, 738);
  f.data.calls = 0; f.data.fileReads = 0; f.data.comments = 5;
  const second = await f.read(() => {});
  assert.equal(f.data.calls, 1); assert.equal(f.data.fileReads, 0);
  assert.equal(second.files[0].commentCount, 5); assert.equal(second.commentCount, 6);
  assert.equal(first.files[0].commentCount, 2);
  f.data.comments = 0;
  assert.equal((await f.read()).files[0].commentCount, 0);
});

test("changed head, base, count or actual authentication forbids file reuse", async t => {
  const f = await fixture(t, 101); await f.read();
  for (const change of [() => { f.data.head = "new-head"; }, () => { f.data.base = "new-base"; },
    () => { f.data.count = 102; }, () => { f.data.auth = "account-two"; }]) {
    change(); f.data.fileReads = 0;
    const value = await f.read(); assert.equal(f.data.fileReads, 2); assert.equal(value.files.length, f.data.count);
  }
});

test("a file snapshot still loads every review tail", async t => {
  const f = await fixture(t, 101); await f.read();
  f.data.calls = 0; f.data.fileReads = 0; f.data.threadTail = true;
  const value = await f.read(); assert.equal(f.data.calls, 2); assert.equal(f.data.fileReads, 0);
  assert.equal(value.fileCommentCount, 4);
});

test("failed or truncated reads never teach a reusable snapshot", async t => {
  const f = await fixture(t, 2100); await f.read();
  f.data.fileReads = 0;
  assert.equal((await f.read()).filesTruncated, true); assert.equal(f.data.fileReads, 20);
  const g = await fixture(t, 101); g.data.failThreads = true;
  assert((await g.read(() => {})).reviewThreadsError);
  g.data.failThreads = false; g.data.fileReads = 0;
  await g.read(); assert.equal(g.data.fileReads, 2);
});

test("duplicate file pages cannot become a completed immutable snapshot", async t => {
  const f = await fixture(t, 101); f.data.duplicate = true;
  await assert.rejects(f.read(), /file pagination is incomplete/);
});

test("cancelled details cannot teach a reusable raw snapshot", async t => {
  const f = await fixture(t, 101), controller = new AbortController();
  f.data.cancel = () => controller.abort();
  await assert.rejects(f.read(undefined, controller.signal), { name: "AbortError" });
  f.data.cancel = undefined; f.data.fileReads = 0;
  await f.read(); assert.equal(f.data.fileReads, 2);
});

test("raw cache enforces bounds and isolates consumers from mutation", () => {
  const snapshots = new GitHubPullRequestSnapshots({ maxEntries: 1, maxBytes: 1024, maxEntryBytes: 512 });
  const identity = { host: "github.com", repository: "owner/repo", credentialKey: "account" };
  const files = [{ path: "one.ts", additions: 1, deletions: 0, changeType: "ADDED" }];
  snapshots.putFiles(identity, 1, "head", "base", files);
  snapshots.getFiles(identity, 1, "head", "base", 1)![0].path = "mutated";
  assert.equal(snapshots.getFiles(identity, 1, "head", "base", 1)![0].path, "one.ts");
  snapshots.putFiles(identity, 2, "head", "base", files);
  assert.equal(snapshots.getFiles(identity, 1, "head", "base", 1), undefined);
  snapshots.putFiles(identity, 3, "head", "base", [{ ...files[0], path: "x".repeat(600) }]);
  assert.equal(snapshots.getFiles(identity, 3, "head", "base", 1), undefined);
});

for (const kind of ["failure", "missing"] as const) test(`warm progressive details retain files after initial review ${kind}`, async t => {
  const f = await fixture(t, 101); await f.read(() => {});
  f.data.calls = 0; f.data.fileReads = 0;
  if (kind === "failure") f.data.failCombined = true; else f.data.missingThreads = true;
  const progress: any[] = [];
  const value = await f.read(page => progress.push(page));
  assert.equal(value.files.length, 101); assert(value.reviewThreadsError);
  assert(progress.some(page => page.files.length === 101 && page.reviewThreadsError));
  assert.equal(value.reviewThreadsLoading, undefined);
});

test("warm recovery never retries authentication or network errors as a file-only read", async t => {
  const f = await fixture(t, 101); await f.read(() => {});
  for (const kind of ["auth", "network", "rate-limit"] as const) {
    f.data.calls = 0; f.data.failCombined = true; f.data.combinedError = new GitHubApiError(kind, "fixture");
    await assert.rejects(f.read(() => {}), { kind }); assert.equal(f.data.calls, 1);
  }
});

test("structured review-field GraphQL failure retains freshly authorized warm files", async t => {
  const f = await fixture(t, 101); await f.read(() => {});
  f.data.failCombined = true;
  f.data.combinedError = new GitHubApiError("graphql", "fixture", 200, undefined, { errors: [
    { type: "INTERNAL", path: ["repository", "pullRequest", "reviewThreads"] } ] });
  const value = await f.read(() => {}); assert.equal(value.files.length, 101); assert(value.reviewThreadsError);
});
