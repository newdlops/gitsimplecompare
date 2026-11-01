import assert from "node:assert/strict";
import test from "node:test";
import { buildPullRequestConversation } from "../src/git/pullRequestPreviewConversation";
import { GitHubApiError } from "../src/git/githubApiError";
import { encodeRestPage, restPageMetadata, revalidateRestPageMetadata } from "../src/git/githubRestPages";
import type { GhExecute } from "../src/git/ghRunner";

/** DTO 정규화와 stream 병합은 실제로 실행하고 REST 경계만 고정한다. */
function item(id: number) { return { id, event: "commented", body: `body ${id}`, body_text: `text ${id}`, body_html: `<p>${id}</p>`,
  created_at: new Date(id * 1000).toISOString(), html_url: `https://github.com/owner/repo/issues/7#issuecomment-${id}`, user: { login: "author" } }; }
const run = (execute: GhExecute, signal?: AbortSignal) => buildPullRequestConversation("/repo", "owner/repo", { number: 7, author: "opener" }, "opening", "fallback", execute, signal);

for (const count of [0, 99, 100, 101, 200, 1000, 1001]) {
  test(`Conversation retains all ${count} timeline items or reports the real remaining-tail limit`, async () => {
    const calls: string[] = [];
    const execute: GhExecute = async (_args, _root, options) => {
      const request = options.request; assert.equal(request?.kind, "rest");
      if (request?.kind !== "rest") throw new Error("typed REST required");
      assert.equal(request.responseMode, "page"); calls.push(request.path);
      const url = new URL(request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
      const timeline = url.pathname.endsWith("/timeline");
      const values = timeline ? Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, i) => item((page - 1) * 100 + i + 1)) : [];
      const next = new URL(url); next.searchParams.set("page", String(page + 1));
      return encodeRestPage(JSON.stringify(values), restPageMetadata(200, timeline && page * 100 < count ? { link: `<${next}>; rel="next"` } : {}));
    };
    const promise = run(execute);
    if (count > 1000) await assert.rejects(promise, /limit|complete/i);
    else { const result = await promise; assert.equal(result.length, count + 1); assert.equal(result[0].body, "opening"); assert.equal(result.at(-1)?.body, count ? `body ${count}` : "opening"); }
    assert.equal(calls.length, Math.min(10, Math.max(1, Math.ceil(count / 100))) + 2);
  });
}

test("timeline fallback retains full-media issue/review/comment bodies and chronological DTO order", async () => {
  const execute: GhExecute = async (_args, _root, options) => {
    assert.equal(options.request?.kind, "rest"); if (options.request?.kind !== "rest") throw new Error("typed REST required");
    const { path, accept } = options.request;
    if (path.includes("/timeline?")) throw new GitHubApiError("http", "fixture", 404);
    if (path.includes("/reviews?")) { assert.equal(accept, "application/vnd.github.full+json"); return JSON.stringify([{ ...item(3), submitted_at: item(3).created_at, state: "APPROVED" }]); }
    if (path.includes("/pulls/")) { assert.equal(accept, "application/vnd.github-commitcomment.full+json"); return JSON.stringify([{ ...item(2), path: "file.ts", original_line: 4, side: "LEFT", diff_hunk: "@@ -4 +4 @@" }]); }
    assert.equal(accept, "application/vnd.github.full+json"); return JSON.stringify([item(1)]);
  };
  const result = await run(execute);
  assert.deepEqual(result.map(value => value.kind), ["body", "comment", "review_comment", "review"]);
  assert.equal(result[1].bodyHtml, "<p>1</p>"); assert.equal(result[2].line, 4); assert.equal(result[2].side, "LEFT"); assert.equal(result[3].state, "APPROVED");
});

for (const kind of ["auth", "permission", "rate-limit"] as const) {
  test(`timeline ${kind} failure never becomes a successful fallback conversation`, async () => {
    let fallback = 0;
    await assert.rejects(run(async (args, _root, options) => {
      const path = options.request?.kind === "rest" ? options.request.path : args.at(-1)!;
      if (path.includes("/timeline?")) throw new GitHubApiError(kind, "fixture");
      if (path.includes("/issues/") && path.includes("/comments?")) fallback++;
      return "[]";
    }), error => (error as { kind?: string }).kind === kind);
    assert.equal(fallback, 0);
  });
}

test("malformed pagination fails instead of falling back to an incomplete issue-comment stream", async () => {
  let fallback = 0;
  await assert.rejects(run(async (args, _root, options) => {
    const path = options.request?.kind === "rest" ? options.request.path : args.at(-1)!;
    if (path.includes("/timeline?")) return encodeRestPage(JSON.stringify([item(1)]), restPageMetadata(200, { link: '<https://other.example/steal?page=2>; rel="next"' }));
    if (path.includes("/issues/") && path.includes("/comments?")) fallback++;
    return "[]";
  }), /complete/i);
  assert.equal(fallback, 0);
});

test("304 page metadata retains a full terminal page and pre-cancelled conversations never execute", async () => {
  let calls = 0;
  const execute: GhExecute = async (_args, _root, options) => {
    calls++; assert.equal(options.request?.kind, "rest"); if (options.request?.kind !== "rest") throw new Error("typed REST required");
    return encodeRestPage(JSON.stringify(options.request.path.includes("/timeline?") ? Array.from({ length: 100 }, (_, index) => item(index + 1)) : []),
      revalidateRestPageMetadata(restPageMetadata(200, {}), { link: `<https://api.github.com${options.request.path}>; rel="last"` }));
  };
  assert.equal((await run(execute)).length, 101); assert.equal(calls, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(execute, controller.signal), { name: "AbortError" }); assert.equal(calls, 3);
});


test("a failed second review-comment page cannot publish only the first page", async () => {
  let calls = 0;
  await assert.rejects(run(async (_args, _root, options) => {
    if (options.request?.kind !== "rest") throw new Error("typed REST required");
    const url = new URL(options.request.path, "https://api.github.com");
    if (!url.pathname.includes("/pulls/7/comments")) return "[]";
    calls++;
    if (url.searchParams.get("page") === "2") throw new GitHubApiError("network", "fixture");
    url.searchParams.set("page", "2");
    return encodeRestPage(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...item(index + 1), path: "file.ts" }))),
      restPageMetadata(200, { link: `<${url}>; rel="next"` }));
  }), error => (error as { kind?: string }).kind === "network");
  assert.equal(calls, 2);
});
