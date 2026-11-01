import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequestRefs } from "../src/git/pullRequestRefLookup";

test("partial ref responses cannot become a usable head/base snapshot", async () => {
  await assert.rejects(fetchPullRequestRefs("/repo", 7, async () => JSON.stringify({
    data: { repository: { pullRequest: { number: 7, headRefOid: "head", baseRefOid: "base" } } },
    errors: [{ type: "FORBIDDEN" }],
  })));
});

test("a missing repository is not an explicit missing pull request", async () => {
  await assert.rejects(fetchPullRequestRefs("/repo", 7, async () => JSON.stringify({ data: { repository: null } })));
  assert.equal(await fetchPullRequestRefs("/repo", 7, async () => JSON.stringify({ data: { repository: { pullRequest: null } } })), undefined);
});
