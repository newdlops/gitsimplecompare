import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPullRequestSuggestedChangesets, parsePullRequestSuggestedChangesets } from "../src/git/pullRequestSuggestedChangesets";
import { GitHubWebTransport } from "../src/git/githubWebTransport";
import { decodeSuggestedChangeRows } from "../src/utils/suggestedChangeFormat";

/** OAuth 경로가 같은 실제 token을 사용할 때 files/permalink 전송을 공유하고 인증 순서는 유지한다. */
test("suggestion fallback shares repeated files and permalink HTML for identical OAuth credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "gsc-suggestions-read-")), gh = join(root, "gh");
  const previous = process.env.GITHUB_CLI_PATH, cookie = process.env.GIT_SIMPLE_COMPARE_GITHUB_COOKIE;
  await writeFile(gh, '#!/bin/sh\nif [ "$1" = "auth" ]; then echo fixture-token; else echo fixture-private-stderr >&2; exit 1; fi\n');
  await chmod(gh, 0o755); process.env.GITHUB_CLI_PATH = gh; delete process.env.GIT_SIMPLE_COMPARE_GITHUB_COOKIE;
  t.after(async () => {
    if (previous === undefined) delete process.env.GITHUB_CLI_PATH; else process.env.GITHUB_CLI_PATH = previous;
    if (cookie !== undefined) process.env.GIT_SIMPLE_COMPARE_GITHUB_COOKIE = cookie;
    await rm(root, { recursive: true, force: true });
  });
  const calls: string[] = [];
  t.mock.method(GitHubWebTransport.prototype, "read", async url => {
    calls.push(url); return { ok: false, reason: "status 403" };
  });
  const result = await readPullRequestSuggestedChangesets(root, "owner", "repo", 7, { webAccessToken: "fixture-token" },
    [{ id: "1", url: "https://github.com/owner/repo/pull/7#discussion_r1" },
      { id: "2", url: "https://github.com/owner/repo/pull/7#discussion_r2" }]);
  assert.deepEqual(calls, ["https://github.com/owner/repo/pull/7/files", "https://github.com/owner/repo/pull/7"]);
  assert.equal(result.byCommentId.size, 0);
  assert(!JSON.stringify(result.status).includes("fixture-private-stderr"));
  assert(!JSON.stringify(result.status).includes("fixture-token"));
});

test("split HTML parser preserves comment IDs, code text and suggestion deduplication", () => {
  const blob = '<div class="js-suggested-changes-blob"><table><tr><td class="blob-code-addition">const answer = &quot;한글&quot;;</td></tr></table></div>';
  const result = parsePullRequestSuggestedChangesets('<div id="discussion_r42">' + blob + blob + '</div>');
  assert.equal(result.size, 1); assert.equal(result.get("42")?.length, 1);
  assert.deepEqual(decodeSuggestedChangeRows(result.get("42")![0])?.map(row => row.text), ['const answer = "한글";']);
});
