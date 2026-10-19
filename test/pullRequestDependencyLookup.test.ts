import assert from "node:assert/strict";
import test from "node:test";
import { declaredPrerequisites, lookupPullRequestDependencies, lookupPullRequestDependencyDetails } from "../src/git/pullRequestDependencyLookup";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

test("only explicit same-repository prerequisite references are recognized", () => {
  const body = "Related #9\nDepends on #41, [#43](https://example.invalid/owner/repo/pull/43)\n선행 PR: #44\nRequires PR https://other.invalid/owner/repo/pull/45\nDepends on other/repo#46\nDepends on #42\n";
  assert.deepEqual(declaredPrerequisites(body, "https://example.invalid/owner/repo/pull/42", 42), [41, 43, 44]);
});

test("commit lookup is bounded and never inserts unvalidated object text into GraphQL", async () => {
  let args: readonly string[] = [];
  const head = "a".repeat(40);
  const commits = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(40, "0"));
  await lookupPullRequestDependencies("/repo", safetyPullRequest(head), [...commits, 'bad" query { secret }'], undefined,
    async value => { args = value; return JSON.stringify({ data: { repository: { current: { headRefOid: head }, parents: { nodes: [] } } } }); });
  const query = args.find(arg => arg.startsWith("query="))!;
  assert.equal((query.match(/associatedPullRequests/g) || []).length, 12);
  assert.doesNotMatch(query, /secret/);
});

test("partial GraphQL errors and a changed inspected PR are rejected instead of empty results", async () => {
  const pr = safetyPullRequest("a".repeat(40));
  await assert.rejects(lookupPullRequestDependencies("/repo", pr, [], undefined,
    async () => JSON.stringify({ errors: [{ message: "permission denied" }], data: { repository: {} } })), /Cannot read/);
  await assert.rejects(lookupPullRequestDependencies("/repo", pr, [], undefined,
    async () => JSON.stringify({ data: { repository: { current: { headRefOid: "b".repeat(40) } } } })), /changed/);
});

test("candidate details preserve incomplete commit pages and cap the PR batch", async () => {
  let query = "";
  const result = await lookupPullRequestDependencyDetails("/repo", [1,2,3,4,5,1,-1], undefined, async args => {
    query = args.find(arg => arg.startsWith("query="))!;
    return JSON.stringify({ data: { repository: { p1: { number: 1, headRefOid: "a".repeat(40),
      commits: { nodes: [{ commit: { oid: "a".repeat(40) } }], pageInfo: { hasNextPage: true } } } } } });
  });
  assert.equal((query.match(/:pullRequest/g) || []).length, 4);
  assert.equal(result[0].commitHashesComplete, false);
});
