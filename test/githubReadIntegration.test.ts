import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequestService } from "../src/git/pullRequestService";
import { beginGitHubReadLifetime, GitHubReadCache } from "../src/git/githubReadCache";
import { setGitHubReadPolicyResolver, GitHubReadRuntime } from "../src/git/githubReadRuntime";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { createGitHubReadSession, captureGitHubRequestContext, completeGitHubReadSession } from "../src/git/githubReadSession";
import { gitHubRepositoryScopes } from "../src/git/githubRepositoryScope";
import { fetchPreviewBootstrap, fetchPreviewCommitSummaries } from "../src/git/pullRequestPreviewRemote";
import { GitHubApiError } from "../src/git/githubApiError";
import { searchPullRequests } from "../src/git/pullRequestSearchService";
import { __outputLines } from "./helpers/vscodeMock";
import type { GhExecute } from "../src/git/ghRunner";

/** 실제 세션의 파일 metadata 관찰을 쓰며 환경·GitHub 설정은 임시 fixture에 격리한다. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gsc-gh-integrated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  const config = join(root, ".git/config"), hosts = join(root, "gh/hosts.yml");
  await writeFile(config, '[remote "origin"]\nurl = https://github.com/owner/repo.git\n');
  await writeFile(hosts, "fixture: original\n");
  const values = { GH_CONFIG_DIR: join(root, "gh"), GH_REPO: "owner/repo", GH_HOST: "github.com", GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined, GITHUB_CLI_PATH: undefined };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.after(() => gitHubRepositoryScopes.clear());
  return { root, config, hosts };
}

/** 공통 metadata 원문은 테스트 메모리에서만 쓰며 출력하지 않는다. */
function pr(): any { return { number: 7, title: "Fixture", state: "OPEN", url: "https://github.com/owner/repo/pull/7",
  headRefName: "topic", baseRefName: "main", headRefOid: "head", baseRefOid: "base", headHash: "head", baseHash: "base", files: { totalCount: 1 }, comments: { totalCount: 0 },
  commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Fixture" } }], pageInfo: { hasNextPage: false } },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }; }

test("production drawer placeholder reopens 738 files with one authorized API", async t => {
  const f = await fixture(t), counter = join(f.root, "calls"), executable = join(f.root, "gh-fixture");
  await writeFile(counter, "0");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='auth'){console.log('fixture-token');process.exit(0);}const count=${JSON.stringify(counter)};fs.writeFileSync(count,String(Number(fs.readFileSync(count))+1));const q=a.find(x=>x.startsWith('query='))?.slice(6)||'';const cursor=Number(a.find(x=>x.startsWith('cursor='))?.slice(7)||0);const pr={number:7,headRefOid:'head',baseRefOid:'base',comments:{totalCount:0}};if(q.includes('files'))pr.files={totalCount:738,...(q.includes('nodes { path additions')?{nodes:Array.from({length:Math.min(100,738-cursor)},(_,i)=>({path:String(cursor+i)+'.ts',additions:1,deletions:0,changeType:'ADDED'})),pageInfo:{hasNextPage:cursor+100<738,endCursor:String(cursor+100)}}:{})};if(q.includes('reviewThreads('))pr.reviewThreads={nodes:[],pageInfo:{hasNextPage:false}};console.log(JSON.stringify({data:{repository:{nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',pullRequest:pr}}}));\n`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const reset = setGitHubReadPolicyResolver(async () => ({ transport: "cli", systemProxy: "none" }));
  const stop = beginGitHubReadLifetime(); t.after(async () => { await stop(); reset(); });
  const service = new PullRequestService(f.root);
  await service.getDetail(7, undefined, () => {}); // Canonical CLI bootstrap.
  await service.getDetail(7, undefined, () => {}); // Fresh credential identity populates raw files.
  await writeFile(counter, "0");
  const value = await service.getDetail(7, undefined, () => {});
  assert.equal(value.files.length, 738); assert.equal(Number(await readFile(counter, "utf8")), 1);
});

test("recoverable mixed alias errors cannot publish after the final response crosses auth context", async t => {
  const f = await fixture(t); let change = false;
  const runner: GhExecute = async (args, _root, options) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    if (options.operation === "pr-search") return JSON.stringify({ data: { search: { nodes: [], issueCount: 0, pageInfo: { hasNextPage: false } } } });
    if (options.operation === "pr-search-associated") return JSON.stringify([{ number: 7 }, { number: 8 }]);
    if (change) await writeFile(f.hosts, "fixture: changed-before-final-alias\n");
    throw new GitHubApiError("graphql", "fixture", 200, undefined,
      { data: { repository: { p7: pr(), p8: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p8"] }] });
  };
  await searchPullRequests(f.root, "abcdef0", undefined, undefined, runner);
  change = true;
  await assert.rejects(searchPullRequests(f.root, "abcdef0", undefined, undefined, runner), { name: "GitHubReadContextChangedError" });
});

test("session completion validates observable context even without a scope candidate", async t => {
  const f = await fixture(t), session = createGitHubReadSession(f.root, async () => "{}");
  await session(["api", "graphql"], f.root, { operation: "fixture" });
  await writeFile(f.hosts, "fixture: changed-at-completion\n");
  await assert.rejects(completeGitHubReadSession(session), { name: "GitHubReadContextChangedError" });
});

test("bootstrap-to-preview tail preserves the original lease across an unobservable account replacement", async t => {
  const f = await fixture(t); let saved = "account-a";
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const tokens: Array<string | undefined> = [];
  const runtime = new GitHubReadRuntime({ credentials: new GitHubCredentialProvider(async () => saved),
    policy: async () => ({ transport: "cli", systemProxy: "none" }), cli: async (_args, _root, options) => {
      tokens.push(options.env?.GH_TOKEN);
      const first = tokens.length === 1;
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
        headRefOid: "head", commits: { nodes: [{ commit: { oid: first ? "first" : "head", messageHeadline: "Fixture" } }],
          pageInfo: { hasNextPage: first, endCursor: first ? "tail" : undefined } } } } } });
    } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
  const initial = await fetchPreviewBootstrap(f.root, pr(), runner); saved = "account-b";
  await fetchPreviewCommitSummaries(f.root, pr(), runner, initial.firstPage);
  assert.deepEqual(tokens, ["account-a", "account-a"]);
});

test("observable repository changes between bootstrap and tail are rejected before continuation", async t => {
  const f = await fixture(t); let tails = 0;
  const runner: GhExecute = async (_args, _root, options) => {
    if (options.operation !== "pr-preview-bootstrap") tails++;
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", pullRequest: { headRefOid: "head",
      commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Fixture" } }], pageInfo: { hasNextPage: !tails, endCursor: "tail" } } } } } });
  };
  const initial = await fetchPreviewBootstrap(f.root, pr(), runner);
  await writeFile(f.config, '[remote "origin"]\nurl = https://github.com/owner/changed.git\n');
  await assert.rejects(fetchPreviewCommitSummaries(f.root, pr(), runner, initial.firstPage), { name: "GitHubReadContextChangedError" });
  assert.equal(tails, 0);
});

test("production preview assembly owns one session across bootstrap, REST files and commit tails", async t => {
  const f = await fixture(t), states = new Set<unknown>(); let graph = 0;
  const runner: GhExecute = async (args, _root, options) => {
    states.add(options.readSession);
    if (args[1] !== "graphql") return "[]";
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", pullRequest: { headRefOid: "head",
      commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Fixture" } }], pageInfo: { hasNextPage: ++graph === 1, endCursor: "tail" } } } } } });
  };
  await (new PullRequestService(f.root) as any).previewRemote(pr(), runner);
  assert.equal(states.size, 1); assert(!states.has(undefined));
});

test("queued requests report the actual slot wait rather than a constant zero", async t => {
  const f = await fixture(t), releases: Array<() => void> = [], seen: any[] = [];
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    seen.push(options); if (options.operation === "queued-metric") return "{}";
    await new Promise<void>(resolve => releases.push(resolve)); return "{}";
  });
  t.after(async () => { releases.forEach(release => release()); await cache.dispose(); });
  const blockers = Promise.allSettled(Array.from({ length: 4 }, (_, index) => cache.read([String(index)], f.root, { operation: "blocker" })));
  const waitFor = async (condition: () => boolean) => { const until = Date.now() + 2000; while (!condition()) {
    assert(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 2)); } };
  await waitFor(() => releases.length === 4);
  const queued = cache.read(["queued"], f.root, { operation: "queued-metric" });
  await waitFor(() => __outputLines.some(line => line.includes("GitHub read queued") && line.includes("queued-metric")));
  await new Promise(resolve => setTimeout(resolve, 20)); releases[0](); await queued;
  assert(seen.find(options => options.operation === "queued-metric").queueMs >= 20);
  releases.forEach(release => release()); await blockers;
});
