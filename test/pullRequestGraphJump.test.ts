import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGit } from "../src/git/gitExec";
import { gitCommandPolicy } from "../src/git/gitCommandPolicy";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { PULL_REQUEST_GRAPH_FETCH_OPTIONS } from "../src/git/pullRequestGraphFetch";
import { fetchPullRequestGraphObjects } from "../src/git/pullRequestGraphTarget";
import type { PullRequestInfo } from "../src/git/pullRequestInfo";
import { loadFilteredGraphCommitWindow } from "../src/webview/graphCommitWindowLoading";
import { ensureGraphCommitVisible } from "../src/webview/graphCommitFocus";
import { resolveBranchFilter } from "../src/webview/graphBranchFilter";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { safetyFixture, addOrigin, git } from "./helpers/gitSafetyFixture";
import { GitLogService } from "../src/git/gitLogService";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";

const all = () => resolveBranchFilter({ mode: "all", selected: [], compact: true }, []);

/** 실제 gh 요청 경계를 임시 실행 파일로 대체하고 단건 ref 조회만 허용한다. */
async function refsFixture(t: TestContext, directory: string, head: string, merged?: string) {
  const executable = join(directory, "gh-fixture"), calls = join(directory, "gh-calls.jsonl");
  const node = { number: 42, title: "Remote PR", state: merged ? "MERGED" : "OPEN", headRefOid: head,
    headRefName: "feature", baseRefName: "main", url: "https://fixture.invalid/owner/repo/pull/42",
    ...(merged ? { mergeCommit: { oid: merged } } : {}) };
  await writeFile(join(directory, "refs.json"), JSON.stringify({ data: { repository: { pullRequest: node } } }));
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=__dirname;
if(args[0]==='repo' && args[1]==='view'){process.stdout.write(JSON.stringify({nameWithOwner:'owner/repo'}));process.exit(0);}
if(args.some(arg=>arg.startsWith('searchQuery='))){
  const node=JSON.parse(fs.readFileSync(path.join(dir,'refs.json'))).data.repository.pullRequest;
  node.commits={nodes:[{commit:{oid:node.headRefOid}}],pageInfo:{hasNextPage:false}};
  process.stdout.write(JSON.stringify({data:{search:{nodes:[node],issueCount:1,pageInfo:{hasNextPage:false}}}}));process.exit(0);
}
if (!args.includes('number=42') || !args.some(arg=>arg.startsWith('query=') && arg.includes('headRefOid') && !arg.includes('commits('))) process.exit(2);
fs.appendFileSync(path.join(dir,'gh-calls.jsonl'),JSON.stringify(args)+'\\n');
process.stdout.write(fs.readFileSync(path.join(dir,'refs.json')));
`, { mode: 0o755 });
  const previous = process.env.GITHUB_CLI_PATH;
  process.env.GITHUB_CLI_PATH = executable;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_CLI_PATH; else process.env.GITHUB_CLI_PATH = previous; });
  const pr = { number: 42, state: node.state, title: node.title, url: node.url,
    headRefName: "feature", baseRefName: "main", headHash: head, mergeHash: merged, commitHashes: [head],
    commitHashesComplete: true } as PullRequestInfo;
  return { pr, calls, count: async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length };
}

/** ref・index・configと既存FETCH_HEADを原文のまま比較し、許可されたobject追加と区別する。 */
async function protectedState(root: string) {
  const file = async (name: string) => readFile(join(root, ".git", name));
  return { head: await git(root, "rev-parse", "HEAD"), refs: await git(root, "show-ref"),
    index: await file("index"), config: await file("config"), fetchHead: await file("FETCH_HEAD"),
    tracked: await readFile(join(root, "tracked.txt")) };
}

/** PR commitを原本には書かずbare originだけに作り、Git URL書換えでネットワークを完全に隔離する。 */
async function remoteFixture(t: TestContext) {
  const f = await safetyFixture(t, "pr-graph-jump"), remote = await addOrigin(f.root, f.directory);
  const tree = await git(remote, "rev-parse", `${f.head}^{tree}`);
  const head = await git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit-tree", tree, "-p", f.head, "-m", "Unfetched pull request");
  await git(remote, "update-ref", "refs/pull/42/head", head);
  await git(f.root, "config", "remote.origin.url", "https://fixture.invalid/owner/repo");
  await git(f.root, "config", `url.${remote}.insteadOf`, "https://fixture.invalid/owner/repo");
  await git(f.root, "config", "remote.origin.fetch", "+refs/pull/*:refs/remotes/origin/pull/*");
  await git(f.root, "config", "fetch.prune", "true");
  await git(f.root, "config", "fetch.writeCommitGraph", "true");
  await writeFile(join(f.root, ".git", "FETCH_HEAD"), "existing fetch head must survive\n");
  return { ...f, remote, head };
}

test("a lightweight first PR list resolves one PR without waiting for list metadata", async t => {
  const f = await safetyFixture(t, "pr-graph-summary"), r = await refsFixture(t, f.directory, f.head);
  const summary = { ...r.pr, headHash: undefined, mergeHash: undefined, commitHashes: [], commitHashesComplete: false };
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const window = await loadFilteredGraphCommitWindow(f.root, [], all(), 20, undefined, summary);
  assert.equal(window?.hash, f.head); assert.equal(await r.count(), 1);
  assert.equal(commands.includes("fetch"), false);
  assert.deepEqual(window?.commits.map(commit => commit.hash), [f.head]);
});

test("known local PR hashes navigate without GitHub or fetch", async t => {
  const f = await safetyFixture(t, "pr-graph-local"), r = await refsFixture(t, f.directory, f.head);
  const window = await loadFilteredGraphCommitWindow(f.root, [f.head], all(), 20, undefined, r.pr);
  assert.equal(window?.hash, f.head); assert.equal(await r.count(), 0);
});

test("a missing old head can resolve a refreshed head already present locally without fetching", async t => {
  const f = await safetyFixture(t, "pr-graph-updated-head"), r = await refsFixture(t, f.directory, f.head);
  const old = "a".repeat(40), commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const window = await loadFilteredGraphCommitWindow(f.root, [old], all(), 20, undefined,
    { ...r.pr, headHash: old, commitHashes: [old] });
  assert.equal(window?.hash, f.head); assert.equal(await r.count(), 1);
  assert.equal(commands.includes("fetch"), false);
});

test("an unfetched PR downloads only its objects and preserves refs, FETCH_HEAD, index, config and edits", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  await writeFile(join(f.root, "tracked.txt"), "user's local edits\n");
  const before = await protectedState(f.root), commands: string[] = [];
  let mutations = 0;
  const stop = setGitExecutionObserver(row => commands.push(row.command)), unsubscribe = gitProcesses.onDidFinishWrite(() => mutations++);
  t.after(stop); t.after(unsubscribe);
  const window = await loadFilteredGraphCommitWindow(f.root, [], all(), 20, undefined,
    { ...r.pr, headHash: undefined, commitHashes: [], commitHashesComplete: false });
  assert.equal(window?.hash, f.head); assert.deepEqual(window?.commits.map(commit => commit.hash), [f.head, before.head]);
  assert.equal(await r.count(), 1, "resolving a summary must not immediately repeat the same API request");
  assert.equal(commands.filter(command => command === "fetch").length, 1);
  assert.equal(commands.filter(command => command === "cat-file").length, 2, "check the same OIDs only before and after fetching");
  assert.equal(mutations, 0, "object preparation must not trigger a graph reload that cancels its own navigation");
  assert.deepEqual(await protectedState(f.root), before);
});

test("All branches can fetch the clicked PR while the remote branch catalog is still pending", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  const filter = resolveBranchFilter({ mode: "all", selected: [], compact: true },
    [{ name: "main", kind: "local" }], "pending");
  const before = await protectedState(f.root), commands: string[] = [];
  const stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const window = await loadFilteredGraphCommitWindow(f.root, [], filter, 20, undefined,
    { ...r.pr, headHash: undefined, commitHashes: [], commitHashesComplete: false });
  assert.equal(window?.hash, f.head);
  assert.deepEqual(window?.commits.map(commit => commit.hash), [f.head, before.head]);
  assert.equal(commands.filter(command => command === "fetch").length, 1);
  assert.equal(await r.count(), 1);
  assert.deepEqual(await protectedState(f.root), before);
});

test("a merged PR downloads its actual squash result before considering its original head", async t => {
  const f = await remoteFixture(t), tree = await git(f.remote, "rev-parse", `${f.head}^{tree}`);
  const merged = await git(f.remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit-tree", tree, "-m", "Squash merge result");
  const r = await refsFixture(t, f.directory, f.head, merged), before = await protectedState(f.root);
  const window = await loadFilteredGraphCommitWindow(f.root, [merged, f.head], all(), 20, undefined, r.pr);
  assert.equal(window?.hash, merged); assert.deepEqual(await protectedState(f.root), before);
});

test("an exact older PR commit fetches its head and keeps newer PR commits in the whole timeline", async t => {
  const f = await remoteFixture(t), tree = await git(f.remote, "rev-parse", `${f.head}^{tree}`);
  const latest = await git(f.remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit-tree", tree, "-p", f.head, "-m", "Newer PR commit");
  await git(f.remote, "update-ref", "refs/pull/42/head", latest);
  const r = await refsFixture(t, f.directory, latest), before = await protectedState(f.root);
  const window = await loadFilteredGraphCommitWindow(f.root, [f.head], all(), 20, undefined, r.pr, { exactHash: f.head });
  assert.equal(window?.hash, f.head, "an exact commit must not be replaced by the current PR head");
  assert.ok(window?.scope?.roots.includes(latest), "later PR commits must stay reachable by newer pagination");
  const native = (await git(f.root, "rev-list", "--date-order", "--branches", "--remotes", "--tags", latest)).split("\n");
  assert.deepEqual(window?.commits.map(commit => commit.hash), native);
  assert.ok(window?.commits.some(commit => commit.hash === latest));
  assert.deepEqual(await protectedState(f.root), before);
});

test("custom and empty branch filters never fetch or silently widen their selected range", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  const filter = resolveBranchFilter({ mode: "custom", selected: ["main"], compact: true }, [{ name: "main", kind: "local" }]);
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  assert.equal(await loadFilteredGraphCommitWindow(f.root, [f.head], filter, 20, undefined, r.pr), undefined);
  assert.equal(await loadFilteredGraphCommitWindow(f.root, [], resolveBranchFilter({ mode: "custom", selected: [], compact: true }, []),
    20, undefined, { ...r.pr, headHash: undefined }), undefined);
  assert.equal(commands.includes("fetch"), false); assert.equal(await r.count(), 0);
});

test("a mismatched fork origin is never used for a pull request object fetch", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  await git(f.root, "config", "remote.origin.url", "https://fixture.invalid/someone/fork");
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  await assert.rejects(fetchPullRequestGraphObjects(f.root, r.pr), /No Git remote matches/);
  assert.equal(commands.includes("fetch"), false);
  const url = "ssh://git@fixture.invalid/owner/repo.git";
  await git(f.root, "remote", "add", "upstream", url);
  await git(f.root, "config", "--add", `url.${f.remote}.insteadOf`, url);
  const before = await protectedState(f.root);
  await fetchPullRequestGraphObjects(f.root, r.pr);
  assert.equal(commands.filter(command => command === "fetch").length, 1, "fetch only the matching upstream");
  assert.deepEqual(await protectedState(f.root), before);
});

test("cancelled PR navigation runs neither Git nor GitHub and missing metadata completes its request", async t => {
  const f = await safetyFixture(t, "pr-graph-abort"), r = await refsFixture(t, f.directory, f.head);
  const controller = new AbortController(); controller.abort();
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  await assert.rejects(loadFilteredGraphCommitWindow(f.root, [], all(), 20, controller.signal, r.pr));
  assert.deepEqual(commands, []); assert.equal(await r.count(), 0);
  const posted: unknown[] = [];
  await ensureGraphCommitVisible({ repoRoot: f.root, requestId: "summary-error", hashes: [], pullRequest: r.pr,
    loadedHash: () => undefined, loadWindow: async () => { throw new Error("API unavailable"); }, post: message => posted.push(message) });
  assert.deepEqual(posted, [{ type: "commitVisibility", requestId: "summary-error", found: false }]);
});

test("only the complete object-only PR fetch shape receives cancellable read lifecycle policy", () => {
  const args = ["fetch", ...PULL_REQUEST_GRAPH_FETCH_OPTIONS, "origin", "refs/pull/42/head"];
  assert.equal(gitCommandPolicy(args).readOnly, true);
  assert.equal(gitCommandPolicy(["-c", "core.fsmonitor=false", ...args]).readOnly, true);
  for (const option of PULL_REQUEST_GRAPH_FETCH_OPTIONS) assert.equal(gitCommandPolicy(args.filter(arg => arg !== option)).readOnly, false);
  for (const source of ["refs/heads/main", "refs/pull/42/head:refs/heads/main", "--all", "refs/pull/0/head"])
    assert.equal(gitCommandPolicy([...args.slice(0, -1), source]).readOnly, false);
  assert.equal(gitCommandPolicy([...args, "another"]).readOnly, false);
  assert.equal(gitCommandPolicy(["fetch", "origin"]).readOnly, false);
});

test("the registered Graph message callback resolves a first-list PR and publishes its real native window", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  const summary = { ...r.pr, headHash: undefined, commitHashes: [], commitHashesComplete: false };
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo",
    defaultBranch: "main", hasMore: false, detailsLoading: true, pullRequests: [summary] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () =>
    ({ repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  const h = createOperationGraphPanel(t, new GitLogService(f.root)); t.after(() => h.panel.dispose());
  await h.receiveMessage({ type: "ready" });
  assert.ok(h.messages.some(message => message.type === "pullRequestOverview" && message.overview.pullRequests[0]?.number === 42));
  await h.receiveMessage({ type: "ensureCommitVisible", requestId: "first-list-real-route", hashes: [], pullRequestNumber: 42 });
  assert.deepEqual(h.messages.filter(message => message.type === "commitVisibility"),
    [{ type: "commitVisibility", requestId: "first-list-real-route", found: true, hash: f.head }]);
  const graph = h.messages.filter(message => message.type === "graph").at(-1);
  assert.equal(graph?.type, "graph");
  if (graph?.type === "graph") assert.equal(graph.data.rows[0].hash, f.head);
  assert.equal(await r.count(), 1);
});

test("the registered Graph jump still publishes a PR after a broken local ref restricts All branches", async t => {
  const f = await safetyFixture(t, "pr-graph-safe-ref-route");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const head = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "PR outside named refs");
  const r = await refsFixture(t, f.directory, head), broken = join(f.root, ".git/refs/heads/broken-local");
  const brokenContents = `${"1".repeat(40)}\n`;
  await writeFile(broken, brokenContents);
  const before = { index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")) };
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo",
    defaultBranch: "main", hasMore: false, pullRequests: [r.pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () =>
    ({ repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  const h = createOperationGraphPanel(t, new GitLogService(f.root)); t.after(() => h.panel.dispose());
  await h.receiveMessage({ type: "ready" });
  assert.ok(h.messages.some(message => message.type === "branchFilterOptions" && message.filter.mode === "all"));
  assert.equal(h.panel.invalidLocalRefs.length, 1, "the actual panel must retain the safe ref restriction");
  await h.receiveMessage({ type: "ensureCommitVisible", requestId: "safe-ref-route", hashes: [head], pullRequestNumber: 42 });
  assert.deepEqual(h.messages.filter(message => message.type === "commitVisibility"),
    [{ type: "commitVisibility", requestId: "safe-ref-route", found: true, hash: head }]);
  assert.equal(h.panel.commits[0]?.hash, head);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  assert.equal(await readFile(broken, "utf8"), brokenContents);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), before.index);
  assert.deepEqual(await readFile(join(f.root, ".git/config")), before.config);
  assert.equal(await r.count(), 0, "the local PR must not need a GitHub refresh");
});

test("a PR kept in search results can jump after the refreshed overview omits it", async t => {
  const f = await remoteFixture(t), r = await refsFixture(t, f.directory, f.head);
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo",
    defaultBranch: "main", hasMore: false, pullRequests: [] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () =>
    ({ repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  const h = createOperationGraphPanel(t, new GitLogService(f.root)); t.after(() => h.panel.dispose());
  await h.receiveMessage({ type: "ready" });
  await h.receiveMessage({ type: "searchPullRequests", requestId: "search-before-refresh", query: "Remote PR" });
  assert.equal(h.panel.messages.pullRequests[0]?.number, 42);
  await h.receiveMessage({ type: "refreshPullRequests" });
  assert.equal(h.panel.messages.pullRequests.length, 0, "overview refresh replaces its accumulated entries");
  const before = await protectedState(f.root);
  await h.receiveMessage({ type: "ensureCommitVisible", requestId: "retained-search-pr", hashes: [], pullRequestNumber: 42 });
  assert.deepEqual(h.messages.filter(message => message.type === "commitVisibility"),
    [{ type: "commitVisibility", requestId: "retained-search-pr", found: true, hash: f.head }]);
  assert.equal(await r.count(), 1, "resolve only the clicked PR, independently of current overview membership");
  assert.deepEqual(await protectedState(f.root), before);
});
