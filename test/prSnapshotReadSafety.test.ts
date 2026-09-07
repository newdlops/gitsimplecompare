import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { searchPullRequests } from "../src/git/pullRequestSearchService";
import { pullRequestInfoFromGraphQl, type GhPullRequestNode } from "../src/git/pullRequestInfo";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestService } from "../src/git/pullRequestService";
import { GraphPullRequestPager } from "../src/webview/graphPullRequests";
import type { GhExecute } from "../src/git/ghRunner";
import { safetyFixture, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

/** 실제 Git OID를 사용하는 GraphQL PR node를 만든다. */
function node(hashes: string[], repository = "fixture/repo"): GhPullRequestNode {
  return { number: 42, title: "Snapshot safety", state: "OPEN", headRefName: "source", baseRefName: "main",
    headRefOid: hashes.at(-1), url: `https://github.com/${repository}/pull/42`,
    commits: { nodes: hashes.map(oid => ({ commit: { oid } })), pageInfo: { hasNextPage: false } } };
}

/** 검색 첫 페이지와 commit 후속 페이지를 구분하는 결정적 GitHub 응답 실행기다. */
function searchRunner(first: GhPullRequestNode, rest: GhPullRequestNode, calls: string[] = []): GhExecute {
  return async (args, _root, options) => {
    calls.push(options.operation);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
    if (options.operation === "graph-pr-commit-page") return JSON.stringify({ data: { repository: { pullRequest: rest } } });
    return JSON.stringify({ data: { search: { nodes: [first], issueCount: 1, pageInfo: { hasNextPage: false } } } });
  };
}

test("search completes 105 original commits before real squash application", async t => {
  const { root } = await safetyFixture(t, "search-complete");
  await git(root, "switch", "-qc", "source");
  const hashes: string[] = [];
  for (let number = 1; number <= 105; number++) {
    await writeFile(join(root, `change-${number}.txt`), `${number}\n`);
    await git(root, "add", "."); await git(root, "commit", "-qm", `change ${number}`);
    hashes.push(await git(root, "rev-parse", "HEAD"));
  }
  await git(root, "switch", "main");
  const first = node(hashes);
  first.commits!.nodes = first.commits!.nodes!.slice(0, 100);
  first.commits!.pageInfo = { hasNextPage: true, endCursor: "next" };
  const result = await searchPullRequests(root, "snapshot", undefined, undefined, searchRunner(first, node(hashes.slice(100))));
  assert.deepEqual(result.pullRequests[0].commitHashes, hashes);
  assert.equal(result.pullRequests[0].commitHashesComplete, true);
  await new PullRequestOperationService(root).squashCherryPick(result.pullRequests[0]);
  const files = (await git(root, "ls-tree", "--name-only", "HEAD")).split("\n");
  for (let number = 1; number <= 105; number++) assert.ok(files.includes(`change-${number}.txt`));
});

for (const changed of [true, false]) {
  test(`search refuses ${changed ? "head changes" : "missing pages"} before publishing partial commit data`, async () => {
    const first = node(["first", "head"]);
    first.commits!.pageInfo = { hasNextPage: true, endCursor: "next" };
    const next = changed ? node(["other-head"]) : { headRefOid: "head" };
    await assert.rejects(searchPullRequests("/repo", "snapshot", undefined, undefined, searchRunner(first, next)), /head changed|incomplete/);
  });
}

test("an explicitly incomplete commit set cannot enter a Git write operation", async t => {
  const { root, pr, service } = await prSafetyFixture(t);
  const before = await git(root, "rev-parse", "HEAD");
  await assert.rejects(service.squashCherryPick({ ...pr, commitHashesComplete: false }), /incomplete/);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("a force-pushed PR replaces old commits instead of applying removed files", async t => {
  const { root, head: base } = await safetyFixture(t, "pr-rewritten");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "removed.txt"), "old\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "old");
  const old = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "rewritten", base);
  await writeFile(join(root, "current.txt"), "new\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "new");
  const next = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main"); await git(root, "branch", "-f", "source", next);
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, hasMore: false, pullRequests: [pullRequestInfoFromGraphQl(node([old]))] }));
  const fresh = pullRequestInfoFromGraphQl(node([next]));
  const pager = new GraphPullRequestPager(async () => ({ query: "new", pullRequests: [fresh], totalCount: 1, hasMore: false }));
  await pager.refresh(root, [], "initial", () => {});
  await pager.search(root, "new", "new", undefined, () => {});
  assert.deepEqual(pager.items[0].commitHashes, [next]);
  await new PullRequestOperationService(root).squashCherryPick(pager.items[0]);
  assert.equal((await git(root, "ls-tree", "--name-only", "HEAD")).includes("removed.txt"), false);
});

for (const failure of [false, true]) {
  test(`a late search ${failure ? "error" : "success"} cannot cross repository reset`, async t => {
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    const pending = new Promise<any>((accept, fail) => { resolve = accept; reject = fail; });
    let signal: AbortSignal | undefined;
    const pager = new GraphPullRequestPager(async (_root, _query, _cursor, token) => { signal = token; return pending; });
    const messages: any[] = [];
    const old = pager.search("/old", "old", "query", undefined, message => messages.push(message));
    pager.cancel("repositoryChanged"); pager.resetRepository();
    t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, hasMore: false,
      repository: "new/repo", pullRequests: [pullRequestInfoFromGraphQl(node(["new-head"], "new/repo"))] }));
    await pager.refresh("/new", [], "new", message => messages.push(message));
    if (failure) reject(new Error("late"));
    else resolve({ query: "old", pullRequests: [pullRequestInfoFromGraphQl(node(["old-head"], "old/repo"))], totalCount: 1, hasMore: false });
    await old;
    assert.equal(signal?.aborted, true);
    assert.equal(pager.items[0].headHash, "new-head");
    assert.equal(messages.filter(message => message.type.startsWith("pullRequestSearch")).length, 0);
  });
}
