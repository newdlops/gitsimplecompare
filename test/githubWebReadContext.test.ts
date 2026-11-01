import assert from "node:assert/strict";
import test from "node:test";
import { GitHubWebReadContext } from "../src/git/githubWebReadContext";
import { readGitHubWebHtmlWithFragments } from "../src/git/githubWebHtml";

const base = "https://github.com/owner/repo/pull/7";

/** 요청 경계만 대체하여 실제 context 공유·예약·취소와 HTML 순회를 검증한다. */
function fixture(handler: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<any>, deadline?: number) {
  const reads: string[] = [];
  let active = 0, maximum = 0, closed = false;
  const context = new GitHubWebReadContext({ deadline, transport: {
    async read(url, headers, signal) {
      reads.push(url); maximum = Math.max(maximum, ++active);
      try { return await handler(url, headers, signal); } finally { active--; }
    },
    async dispose() { assert.equal(active, 0); closed = true; },
  } });
  return { context, reads, maximum: () => maximum, closed: () => closed };
}

/** 고정 시간의 응답 차이를 주어 완료 순서와 결과 순서를 의도적으로 다르게 만든다. */
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("HTML memoization shares successes and failures by normalized URL, actual credential and Accept", async () => {
  const f = fixture(async (url, headers) => ({ ok: headers.authorization !== "Bearer rejected", html: "<p>ok</p>", finalUrl: url, reason: "status 403" }));
  try {
    const a = { Authorization: "Bearer same", Accept: "text/html" };
    const first = f.context.read(base + "/files", a);
    assert.deepEqual(await first, await f.context.read(base + "/files#comment", { accept: "text/html", authorization: "Bearer same" }));
    await Promise.all([f.context.read(base, a), f.context.read(base, { ...a, Authorization: "Bearer other" })]);
    await f.context.read(base, { ...a, Accept: "other" });
    assert(!(await f.context.read(base, { Authorization: "Bearer rejected" })).ok);
    assert(!(await f.context.read(base + "#retry", { Authorization: "Bearer rejected" })).ok);
    assert.equal(f.reads.length, 5);
    assert(!JSON.stringify(f.context.metrics()).includes("Bearer"));
  } finally { await f.context.dispose(); }
  assert(f.closed());
});

test("two HTML readers retain breadth-first order and reserve duplicate descendants once", async () => {
  const f = fixture(async url => {
    const tail = new URL(url).pathname.split("/").at(-1);
    if (tail === "files") return { ok: true, finalUrl: url, html: '<html>GitHub<include-fragment src="fragment/a"></include-fragment><include-fragment src="fragment/b"></include-fragment></html>' };
    await wait(tail === "a" ? 25 : 1);
    return { ok: true, finalUrl: url, html: `<div>${tail}${tail === "a" || tail === "b" ? '<include-fragment src="fragment/c"></include-fragment>' : ''}</div>` };
  });
  try {
    const result = await readGitHubWebHtmlWithFragments(base + "/files", {}, undefined, f.context);
    assert(result.ok);
    assert.deepEqual(result.html.match(/<div>([abc])/g), ["<div>a", "<div>b", "<div>c"]);
    assert.equal(f.reads.length, 4); assert.equal(f.maximum(), 2);
  } finally { await f.context.dispose(); }
});

test("fragment traversal keeps 120 URL and depth-two limits and rejects neighboring PR paths", async () => {
  const f = fixture(async url => ({ ok: true, finalUrl: url, html: url.endsWith("/files")
    ? '<html>GitHub' + Array.from({ length: 125 }, (_, i) => `<include-fragment src="${base}/fragment/${i}"></include-fragment>`).join("")
      + `<include-fragment src="${base}0/fragment/no"></include-fragment></html>`
    : `<div><include-fragment src="${base}/fragment/deeper"></include-fragment></div>` }));
  try {
    assert((await readGitHubWebHtmlWithFragments(base + "/files", {}, undefined, f.context)).ok);
    assert.equal(f.reads.length, 121); assert.equal(f.maximum(), 2);
    assert(!f.reads.some(url => url.includes("/70/")));
  } finally { await f.context.dispose(); }
});

test("whole-context deadline aborts active reads and removes queued reads before disposal", async () => {
  const f = fixture(async (_url, _headers, signal) => {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { ok: false, reason: "request cancelled" };
  }, Date.now() + 30);
  const values = await Promise.all([0, 1, 2, 3].map(index => f.context.read(`${base}/fragment/${index}`, {})));
  assert(values.every(value => !value.ok)); assert.equal(f.reads.length, 2);
  await f.context.dispose(); assert(f.closed());
});

test("disposing a context cancels active readers and waits for their actual closure", async () => {
  let finish!: () => void;
  const f = fixture(async (_url, _headers, signal) => {
    await new Promise<void>(resolve => { finish = resolve; signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }); });
    return { ok: false, reason: "request cancelled" };
  });
  const pending = f.context.read(base, {}); await wait(0);
  await f.context.dispose(); await pending; finish(); assert(f.closed());
});
