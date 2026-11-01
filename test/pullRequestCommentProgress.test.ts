import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestCommentCache } from "../src/providers/pullRequestCommentCache";
import { PullRequestCommentController } from "../src/providers/pullRequestCommentController";
import { PullRequestReviewCommentService } from "../src/git/pullRequestReviewComments";
import { GitHubWebTransport } from "../src/git/githubWebTransport";
import * as vscodeMock from "./helpers/vscodeMock";

/** HTML 준비와 최종 완료를 별도로 제어하는 외부 경계다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const data = () => ({ number: 7, title: "한글 PR", headRefName: "topic", comments: [{ id: "42", author: "reviewer", body: "API comment", path: "file.ts", line: 1 }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** 캐시 바깥 API는 대체하고 production 공유/구독/세대 관리는 그대로 실행한다. */
function cacheFixture(t: test.TestContext) {
  const started = deferred<void>(), finish = deferred<any>();
  let options: any, calls = 0;
  t.mock.method(PullRequestReviewCommentService.prototype, "getCurrentBranch", async () => "topic");
  t.mock.method(PullRequestReviewCommentService.prototype, "getActiveBranchReviewComments", async function (this: any) {
    calls++; options = this.options; started.resolve(); return finish.promise;
  });
  const cache: any = new PullRequestCommentCache({ get: async () => undefined } as any);
  t.after(() => { finish.resolve(data()); cache.dispose(); });
  return { cache, started: started.promise, finish, publish: () => options.onApiReady?.(data()), signal: () => options.signal as AbortSignal, calls: () => calls };
}

test("API-ready is delivered before HTML completion, replayed to late joiners and never stored as completed TTL data", async t => {
  const f = cacheFixture(t), first: any[] = [], late: any[] = [];
  const a = f.cache.load("/repo", undefined, (value: any) => first.push(value));
  await f.started; f.publish();
  assert.equal(first.length, 1); assert.equal(f.cache.cache.size, 0);
  const b = f.cache.load("/repo", undefined, (value: any) => late.push(value)); await tick();
  assert.equal(late.length, 1); assert.equal(f.calls(), 1);
  f.finish.resolve({ ...data(), comments: [{ ...data().comments[0], suggestedChangesets: ["new code"] }] });
  const [one, two] = await Promise.all([a, b]); assert.deepEqual(one, two);
  assert.equal(f.cache.cache.size, 1); assert.deepEqual(one.comments[0].suggestedChangesets, ["new code"]);
});

test("one subscriber cancellation and progress exception do not cancel another subscriber", async t => {
  const f = cacheFixture(t), cancel = new AbortController(), seen: any[] = [];
  const a = f.cache.load("/repo", cancel.signal, () => { throw new Error("subscriber fixture"); });
  const b = f.cache.load("/repo", undefined, (value: any) => seen.push(value));
  await f.started; await tick(); f.publish(); cancel.abort();
  // 취소 결과를 즉시 구독해 테스트가 처리하지 않은 비동기 rejection을 만들지 않는다.
  const rejected = assert.rejects(a, { name: "AbortError" });
  await tick(); assert.equal(f.signal().aborted, false); assert.equal(seen.length, 1);
  f.finish.resolve(data()); assert.equal((await b).number, 7); await rejected;
});

test("invalidation cancels actual work and suppresses all later provisional and completed snapshots", async t => {
  const f = cacheFixture(t), values: any[] = [];
  const loading = f.cache.load("/repo", undefined, (value: any) => values.push(value));
  const rejected = assert.rejects(loading, { name: "AbortError" });
  await f.started; f.cache.invalidate("authenticationChanged"); assert(f.signal().aborted);
  f.publish(); f.finish.resolve(data()); await rejected;
  assert.equal(values.length, 0); assert.equal(f.cache.cache.size, 0);
});

test("a last-consumer cancellation allows immediate retry while old cleanup is still pending", async t => {
  const f = cacheFixture(t), cancel = new AbortController();
  const a = f.cache.load("/repo", cancel.signal), rejected = assert.rejects(a, { name: "AbortError" });
  await f.started; cancel.abort(); await rejected;
  const b = f.cache.load("/repo"); void b.catch(() => undefined);
  for (let attempt = 0; attempt < 100 && f.calls() < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls(), 2);
  f.finish.resolve(data()); assert.equal((await b).number, 7);
});

test("disposed comment caches never start another branch or remote load", async t => {
  const f = cacheFixture(t); f.cache.dispose(); f.finish.resolve(data());
  await assert.rejects(f.cache.load("/repo"), { name: "AbortError" }); assert.equal(f.calls(), 0);
});

test("the service publishes normalized API comments before slow HTML and retains them after enrichment errors", async t => {
  const prototype = PullRequestReviewCommentService.prototype as any;
  t.mock.method(prototype, "getCurrentBranch", async () => "topic");
  t.mock.method(prototype, "readCurrentPullRequest", async () => ({ number: 7, title: "PR", headRefName: "topic" }));
  t.mock.method(prototype, "repositoryName", async () => "owner/repo");
  t.mock.method(prototype, "readReviewComments", async () => data().comments);
  const html = deferred<void>(), started = deferred<void>(), progress: any[] = [];
  t.mock.method(GitHubWebTransport.prototype, "read", async () => { started.resolve(); await html.promise; throw new Error("enrichment fixture"); });
  const service = new PullRequestReviewCommentService("/nonexistent-progress-fixture", {
    suggestedChangeset: { webAccessToken: "fixture-token" }, onApiReady: (value: any) => progress.push(value),
  } as any);
  const final = service.getActiveBranchReviewComments("topic");
  try { await started.promise; assert.equal(progress.length, 1); assert.equal(progress[0].comments[0].body, "API comment"); }
  finally { html.resolve(); }
  const result = await final; assert.equal(result?.comments[0].body, "API comment");
});

test("progress and final results reuse an expanded thread while stale file, focus and request callbacks are ignored", async t => {
  const windowApi = vscodeMock.window as any, workspaceApi = vscodeMock.workspace as any;
  const originalWindow = { ...windowApi }, configuration = workspaceApi.getConfiguration;
  const uri = { scheme: "file", fsPath: "/repo/file.ts", toString: () => "file:///repo/file.ts" };
  const editor = { document: { uri, lineCount: 3, lineAt: () => ({ range: new vscodeMock.Range(0, 0, 0, 1) }) }, setDecorations() {} };
  windowApi.state = { focused: true }; windowApi.activeTextEditor = editor; windowApi.visibleTextEditors = [editor];
  windowApi.createTextEditorDecorationType = () => ({ dispose() {} }); workspaceApi.getConfiguration = () => ({ get: () => true });
  const markdown = vscodeMock.MarkdownString.prototype as any;
  markdown.appendMarkdown = function (value: string) { this.value = String(this.value ?? "") + value; return this; };
  markdown.appendCodeblock = function (value: string) { this.value = String(this.value ?? "") + value; return this; };
  t.after(() => { delete markdown.appendMarkdown; delete markdown.appendCodeblock; });
  let created = 0;
  t.mock.method(vscodeMock.comments, "createCommentController", () => ({ dispose() {}, createCommentThread: (_uri: any, range: any, comments: any) => {
    created++; return { range, comments, collapsibleState: 1, dispose() {} };
  } }));
  t.after(() => { Object.assign(windowApi, originalWindow); workspaceApi.getConfiguration = configuration; });
  const controller: any = new PullRequestCommentController({ resolve: async () => ({ repoRoot: "/repo", toRepoRelative: () => "file.ts" }) } as any, { get: async () => undefined } as any);
  t.after(() => controller.dispose());
  const finish = deferred<any>(), entered = deferred<void>(); let publish: ((value: any) => void) | undefined;
  controller.commentCache.load = async (_root: string, signal: AbortSignal | undefined, progress: any) => {
    assert.equal(signal, undefined); publish = progress; entered.resolve(); return finish.promise;
  };
  controller.requestSeq = 1;
  const cancellation = new AbortController(), loading = controller.refreshActiveEditor("fixture", 1, cancellation.signal);
  await entered.promise;
  try {
    assert.equal(typeof publish, "function"); publish!(data());
    const thread = [...controller.activeThreads.values()][0] as any; assert(thread); thread.collapsibleState = 2;
    finish.resolve({ ...data(), comments: [{ ...data().comments[0], suggestedChangesets: ["suggestion"] }] });
    await loading; assert.equal([...controller.activeThreads.values()][0], thread); assert.equal(thread.collapsibleState, 2); assert.equal(created, 1);
    const prior = thread.comments;
    windowApi.state.focused = false; publish!({ ...data(), comments: [] }); assert.equal(thread.comments, prior);
    windowApi.state.focused = true; controller.requestSeq = 2; publish!({ ...data(), comments: [] }); assert.equal(thread.comments, prior);
    controller.requestSeq = 1; windowApi.activeTextEditor = { document: { uri: { ...uri, toString: () => "file:///repo/other.ts" } } };
    publish!({ ...data(), comments: [] }); assert.equal(thread.comments, prior);
  } finally { finish.resolve(data()); await loading; }
});
