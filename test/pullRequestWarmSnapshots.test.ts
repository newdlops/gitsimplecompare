import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPullRequestListPage, type PullRequestListPage } from "../src/git/pullRequestListService";
import { searchPullRequests } from "../src/git/pullRequestSearchService";
import { GitHubPullRequestSnapshots } from "../src/git/githubPullRequestSnapshots";
import type { GhExecute } from "../src/git/ghRunner";

/** 얕은 identity와 가변 metadata 응답을 분리해 실제 query 비용 경계를 검증한다. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gsc-pr-warm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots = new GitHubPullRequestSnapshots();
  const data = { mutableReads: 0, stableReads: 0, comments: 2, race: false, repeatedRace: false, auth: "one",
    firstQuery: "", delay: undefined as Promise<void> | undefined };
  const node = (stable = true, head = "head"): any => ({ id: "PR_7", number: 7, title: "Fixture", state: "OPEN",
    url: "https://github.com/owner/repo/pull/7", headRefName: "topic", baseRefName: "main", headRefOid: head, baseRefOid: "base",
    isDraft: false, comments: { totalCount: 1 }, reviewThreads: { nodes: [{ comments: { totalCount: data.comments } }], pageInfo: { hasNextPage: false } },
    labels: { nodes: [{ name: `label-${data.comments}`, color: "ffffff" }] }, reviewDecision: "APPROVED",
    ...(stable ? { files: { totalCount: 1 }, commits: { nodes: [{ commit: { oid: head, messageHeadline: "Current title" } }], pageInfo: { hasNextPage: false } } } : {}) });
  const runner: GhExecute = async (args, _root, options) => {
    Object.assign(options.readSession!, { scope: { host: "github.com", name: "owner/repo", owner: "owner", repository: "repo" },
      snapshots, credentialKey: data.auth });
    const query = options.request?.kind === "graphql" ? options.request.query : args.find(value => value.startsWith("query="))?.slice(6) ?? "";
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    const stable = query.includes("commits(first:");
    if (options.operation === "graph-pr-list-page") {
      data.firstQuery = query;
      const summary = node(false); delete summary.comments; delete summary.reviewThreads; delete summary.labels;
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo",
        pullRequests: { nodes: [summary], pageInfo: { hasNextPage: false } } } } });
    }
    if (stable) data.stableReads++; else data.mutableReads++;
    if (data.delay) await data.delay;
    const head = data.race ? stable && data.repeatedRace ? "third-head" : "second-head" : "head";
    const value = node(stable, head);
    if (options.operation === "pr-search") return JSON.stringify({ data: { search: { issueCount: 1, nodes: [value], pageInfo: { hasNextPage: false } } } });
    if (options.operation.startsWith("pr-search-number")) return JSON.stringify({ data: { repository: { p7: value } } });
    return JSON.stringify({ data: { nodes: [value] } });
  };
  return { root, snapshots, data, runner, read: (previous?: PullRequestListPage, onProgress?: (page: PullRequestListPage) => void) =>
    fetchPullRequestListPage(root, undefined, undefined, runner, { previous, onProgress }) };
}

test("warm lists publish a shallow identity before fresh mutable batches, reusing complete commits", async t => {
  const f = await fixture(t), first = await f.read();
  let release!: () => void; f.data.delay = new Promise(resolve => { release = resolve; });
  let shown!: (page: PullRequestListPage) => void;
  const visible = new Promise<PullRequestListPage>(resolve => { shown = resolve; });
  f.data.stableReads = 0; f.data.comments = 5;
  const pending = f.read(first, shown);
  const progress = await visible;
  const identityQuery = f.data.firstQuery;
  release(); const complete = await pending;
  assert(!identityQuery.includes("reviewThreads("));
  assert(!identityQuery.includes("commits("));
  assert.equal(progress.pullRequests[0].commitHashesComplete, true);
  assert.equal(f.data.stableReads, 0); assert.equal(complete.pullRequests[0].commentCount, 6);
  assert.equal(complete.pullRequests[0].labels?.[0].name, "label-5");
  assert.equal(first.pullRequests[0].commentCount, 3);
});

test("a changed identity is fully repaired once and a second change fails explicitly", async t => {
  const f = await fixture(t), first = await f.read();
  f.data.stableReads = 0; f.data.race = true;
  const repaired = await f.read(first);
  assert.equal(f.data.stableReads, 1); assert.equal(repaired.pullRequests[0].headHash, "second-head");
  f.data.repeatedRace = true;
  await assert.rejects(f.read(first), /changed/);
});

test("search shares authorized immutable commits while comments stay fresh", async t => {
  const f = await fixture(t); await f.read(); f.data.stableReads = 0; f.data.comments = 8;
  const search = await searchPullRequests(f.root, "#7", undefined, undefined, f.runner);
  assert.equal(f.data.stableReads, 0); assert.equal(search.pullRequests[0].commentCount, 9);
  assert.deepEqual(search.pullRequests[0].commitSummaries?.map(item => item.title), ["Current title"]);
  f.data.auth = "two"; f.data.stableReads = 0;
  await searchPullRequests(f.root, "#7", undefined, undefined, f.runner);
  assert(f.data.stableReads > 0, "a new account must load its own complete stable data");
});
