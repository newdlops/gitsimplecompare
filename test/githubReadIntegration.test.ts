import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildPullRequestConversation } from "../src/git/pullRequestPreviewConversation";
import { PullRequestReviewCommentService } from "../src/git/pullRequestReviewComments";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
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
import { readGitHubRepositoryName } from "../src/git/githubRepositoryName";
import { fetchPullRequestRefs } from "../src/git/pullRequestRefLookup";
import { lookupPullRequestDependencies, lookupPullRequestDependencyDetails } from "../src/git/pullRequestDependencyLookup";
import { fetchPullRequestChangedFiles } from "../src/git/pullRequestPreviewFiles";
import { fetchRemotePreviewCommit } from "../src/git/pullRequestPreviewRemote";
import { PullRequestPublishService } from "../src/git/pullRequestPublishService";

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

test("changed-files read binds one credential session and uses HTTP after scope discovery", async t => {
  const f = await fixture(t);
  const executable = join(f.root, "gh-empty");
  await writeFile(executable, `#!${process.execPath}\nconsole.log('[]');\n`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  let http = 0, cli = 0, credentials = 0;
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
    cli: async () => { cli++; return "[]"; },
    http: { read: async request => {
      http++; assert.equal(request.kind, "rest");
      if (request.kind === "rest") assert.equal(request.path, "/repos/owner/repo/pulls/7/files?per_page=100&page=1");
      return encodeRestPage(JSON.stringify([{ filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 2, deletions: 1 }]), restPageMetadata(200, {}));
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const result = await fetchPullRequestChangedFiles(f.root, "{owner}/{repo}", 7,
    (args, root, options) => cache.read(args, root, options));
  assert.deepEqual({ http, cli, credentials }, { http: 1, cli: 0, credentials: 1 });
  assert.equal(result.files[0].oldPath, "old.ts"); assert.equal(result.truncated, false);
});

test("selected commit file object stops at a known final full page", async t => {
  const f = await fixture(t), count = join(f.root, "count"), executable = join(f.root, "gh-commit");
  const hash = "a".repeat(40);
  await writeFile(count, "0");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),c=${JSON.stringify(count)};const n=Number(fs.readFileSync(c));fs.writeFileSync(c,String(n+1));if(a.includes('--include'))console.log('HTTP/2 200 OK\\ncontent-type: application/json\\n');console.log(JSON.stringify({sha:${JSON.stringify(hash)},files:n?[]:Array.from({length:100},(_,i)=>({filename:'file-'+i,status:'modified'}))}));\n`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const reset = setGitHubReadPolicyResolver(async () => ({ transport: "cli", systemProxy: "none" }));
  const stop = beginGitHubReadLifetime(); t.after(async () => { await stop(); reset(); });
  const result = await fetchRemotePreviewCommit(f.root, "owner/repo", hash);
  assert.equal(result.files.length, 100); assert.equal(result.files.at(-1)?.path, "file-99");
  assert.equal(Number(await readFile(count, "utf8")), 1);
});

test("known-final file metadata cannot certify completeness at the 3000-file API cap", async t => {
  const f = await fixture(t);
  const files = await fetchPullRequestChangedFiles(f.root, "owner/repo", 7, async (_args, _root, options) => {
    if (options.request?.kind !== "rest") throw new Error("REST required");
    const url = new URL(options.request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
    const next = new URL(url); next.searchParams.set("page", String(page + 1));
    return encodeRestPage(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ filename: `${page}-${index}`, status: "modified" }))),
      restPageMetadata(200, page < 30 ? { link: `<${next}>; rel="next"` } : {}));
  });
  assert.equal(files.files.length, 3000); assert.equal(files.truncated, true);
});

test("selected commit retains its API-cap error even with known-final Link metadata", async t => {
  const f = await fixture(t), count = join(f.root, "count"), executable = join(f.root, "gh-commit-cap");
  const hash = "b".repeat(40); await writeFile(count, "0");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),c=${JSON.stringify(count)},n=Number(fs.readFileSync(c))+1;fs.writeFileSync(c,String(n));if(a.includes('--include'))console.log('HTTP/2 200 OK\\n'+(n<30?'link: <https://api.github.com/repos/owner/repo/commits/${hash}?per_page=100&page='+(n+1)+'>; rel="next"\\n':'')+'content-type: application/json\\n');console.log(JSON.stringify({sha:${JSON.stringify(hash)},files:Array.from({length:100},(_,i)=>({filename:n+'-'+i,status:'modified'}))}));\n`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const reset = setGitHubReadPolicyResolver(async () => ({ transport: "cli", systemProxy: "none" }));
  const stop = beginGitHubReadLifetime(); t.after(async () => { await stop(); reset(); });
  await assert.rejects(fetchRemotePreviewCommit(f.root, "owner/repo", hash), /file limit/i);
  assert.equal(Number(await readFile(count, "utf8")), 30);
});

test("publish reads use independent HTTP sessions and the created PR identity", async t => {
  const f = await fixture(t), executable = join(f.root, "gh-publish-read");
  await writeFile(executable, `#!${process.execPath}\nconsole.log(process.argv[3]==='list'?'[]':JSON.stringify({number:7,title:'legacy'}));\n`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  let http = 0, credentials = 0, duplicate = false;
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
    cli: async () => { throw new Error("unexpected CLI"); },
    http: { read: async request => {
      http++; assert.equal(request.kind, "graphql");
      if (request.kind !== "graphql") throw new Error("graphql required");
      if (request.variables.head !== undefined) {
        assert.equal(request.variables.head, "fork-topic");
        return JSON.stringify({ data: { repository: { pullRequests: { nodes: duplicate ? [{ number: 7, url: "https://github.com/owner/repo/pull/7" }] : [] } } } });
      }
      assert.equal(request.variables.number, 7);
      return JSON.stringify({ data: { repository: { pullRequest: { number: 7, title: "fresh created PR", state: "OPEN", url: "https://github.com/owner/repo/pull/7", headRefName: "fork-topic", headRefOid: "head", baseRefName: "main", author: { login: "creator" } } } } });
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const service = new PullRequestPublishService(f.root, (args, root, options) => cache.read(args, root, options));
  // 실제 게시 파이프라인이 호출하는 검증/보완 단계를 쓰기 없이 실행한다.
  await (service as any).assertNoOpenPullRequest("fork-topic");
  const value = await (service as any).readPublishedPullRequest("fork-topic", "https://github.com/owner/repo/pull/7", "fallback", "main", "head", false);
  assert.equal(value.title, "fresh created PR"); assert.equal(value.author, "creator");
  duplicate = true;
  await assert.rejects((service as any).assertNoOpenPullRequest("fork-topic"), /already exists/);
  assert.deepEqual({ http, credentials }, { http: 3, credentials: 3 });
});

test("preview reuses 201 complete commit summaries only after a fresh matching authorized anchor", async t => {
  const f = await fixture(t);
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  let http = 0, token = "account-one", base = "base", head = "head", incomplete = false;
  const hashes = Array.from({ length: 200 }, (_, i) => `commit-${i}`).concat("head");
  const selected = { ...pr(), headHash: "head", baseHash: "base", fileCount: 3, fileCountComplete: true, commitHashes: hashes };
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => token),
    cli: async () => { throw new Error("unexpected CLI"); },
    http: { read: async request => {
      http++; if (request.kind !== "graphql") throw new Error("GraphQL required");
      const start = Number(request.variables.cursor ?? 0), values = hashes.slice(start, start + 100);
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
        title: `Fresh title ${http}`, body: "fresh body", headRefOid: head, baseRefOid: base, baseRefName: "main",
        commits: { nodes: values.map(oid => ({ commit: { oid, messageHeadline: incomplete && oid === "commit-0" ? undefined : `Title ${oid}`, committedDate: "2026-11-01T00:00:00Z", author: { name: "Author" } } })),
          pageInfo: { hasNextPage: start + 100 < hashes.length, endCursor: String(start + 100) } },
      } } } });
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
  const load = async () => {
    const initial = await fetchPreviewBootstrap(f.root, selected, runner);
    const commits = await fetchPreviewCommitSummaries(f.root, selected, runner, initial.firstPage);
    assert.equal(commits.length, 201); assert.equal(commits[200].title, "Title head");
    assert.equal(commits[0].author, "Author"); return initial;
  };
  await load(); assert.equal(http, 3);
  const warm = await load(); assert.equal(http, 4); assert.equal(warm.title, "Fresh title 4");
  token = "account-two";
  await load(); assert.equal(http, 7, "a new credential cannot consume another account's summaries");
  base = "new-base";
  await load(); assert.equal(http, 10, "a changed base cannot reuse the old commit connection");
  base = "base"; token = "account-three"; incomplete = true;
  await load(); assert.equal(http, 13);
  await load(); assert.equal(http, 16, "fallback SHA titles are not complete reusable summaries");
  head = "new-head";
  await assert.rejects(load(), /head changed/i); assert.equal(http, 17);
});

for (const operation of ["refs", "prerequisites", "prerequisite-details"] as const) {
  test(`production ${operation} uses typed HTTP after scope discovery with one actual credential lease`, async t => {
    const f = await fixture(t);
    const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
    gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    let http = 0, cli = 0, credentials = 0;
    const value = JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo",
      pullRequest: pr(), current: { headRefOid: "head", body: "" }, parents: { nodes: [] }, p7: pr() } } });
    const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
      credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
      cli: async () => { cli++; return value; },
      http: { read: async request => {
        http++; assert.equal(request.kind, "graphql");
        if (request.kind === "graphql") {
          assert.equal(request.variables.owner, "owner"); assert.equal(request.variables.name, "repo");
        }
        return value;
      }, dispose: async () => {} } });
    const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
    t.after(async () => { await cache.dispose(); await runtime.dispose(); });
    const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
    if (operation === "refs") assert.equal((await fetchPullRequestRefs(f.root, 7, runner))?.headHash, "head");
    else if (operation === "prerequisites") await lookupPullRequestDependencies(f.root, pr(), [], undefined, runner);
    else assert.equal((await lookupPullRequestDependencyDetails(f.root, [7], undefined, runner))[0].number, 7);
    assert.deepEqual({ http, cli, credentials }, { http: 1, cli: 0, credentials: 1 });
  });
}

test("ref response cannot publish across a repository-context change", async t => {
  const f = await fixture(t);
  const runner: GhExecute = async () => {
    await writeFile(f.config, '[remote "origin"]\nurl = https://github.com/owner/changed.git\n');
    return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
  };
  await assert.rejects(fetchPullRequestRefs(f.root, 7, runner), { name: "GitHubReadContextChangedError" });
});

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

test("verified canonical scope supplies repository name without an extra CLI bootstrap", async t => {
  const f = await fixture(t), bootstrap = createGitHubReadSession(f.root, async () => JSON.stringify({ data: { repository: {
    nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" } } }));
  await bootstrap(["api", "graphql"], f.root, { operation: "fixture-bootstrap" }); await completeGitHubReadSession(bootstrap);
  let calls = 0;
  const name = await readGitHubRepositoryName(f.root, async () => { calls++; return JSON.stringify({ nameWithOwner: "owner/repo" }); },
    { operation: "fixture-name" });
  assert.equal(name, "owner/repo"); assert.equal(calls, 0);
});

test("production search composition preserves verified HTTP routing and one actual credential lease", async t => {
  const f = await fixture(t), bootstrap = createGitHubReadSession(f.root, async () => JSON.stringify({ data: { repository: {
    nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" } } }));
  await bootstrap(["api", "graphql"], f.root, { operation: "fixture-bootstrap" }); await completeGitHubReadSession(bootstrap);
  let cli = 0, http = 0, credentials = 0;
  const output = (query: string) => query.includes("search(query:")
    ? JSON.stringify({ data: { search: { nodes: [], issueCount: 0, pageInfo: { hasNextPage: false } } } })
    : JSON.stringify({ data: { repository: { p7: pr() } } });
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
    cli: async (args) => { cli++; return args[0] === "repo" ? JSON.stringify({ nameWithOwner: "owner/repo" }) : output(args.find(arg => arg.startsWith("query=")) ?? ""); },
    http: { read: async request => { http++; assert.equal(request.kind, "graphql"); return output(request.kind === "graphql" ? request.query : ""); }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const result = await searchPullRequests(f.root, "#7", undefined, undefined, (args, root, options) => cache.read(args, root, options));
  assert.equal(result.pullRequests[0].number, 7);
  assert.deepEqual({ cli, http, credentials }, { cli: 0, http: 2, credentials: 1 });
});


test("editor comment bootstrap and REST pages use one typed HTTP session with a single credential lease", async t => {
  const f = await fixture(t);
  execFileSync("git", ["init", "-q", "-b", "topic", f.root]);
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  let http = 0, cli = 0, credentials = 0;
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
    cli: async args => { cli++; return args[0] === "pr" ? JSON.stringify(pr()) : "[]"; },
    http: { read: async request => {
      http++;
      if (request.kind === "graphql") return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo",
        defaultBranchRef: { name: "main" }, p0: { nodes: [{ ...pr(), isCrossRepository: false }] } } } });
      assert.equal(request.responseMode, "page"); assert.equal(request.accept, "application/vnd.github-commitcomment.full+json");
      return encodeRestPage("[]", restPageMetadata(200, {}));
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
  const service = new PullRequestReviewCommentService(f.root, {}, runner);
  const result = await service.getActiveBranchReviewComments("topic");
  assert.equal(result?.number, 7); assert.deepEqual(result?.comments, []);
  assert.deepEqual({ http, cli, credentials }, { http: 2, cli: 0, credentials: 1 });
});


for (const transport of ["auto", "cli", "unknown-scope"] as const) {
  test(`Conversation ${transport} keeps three REST streams in one fixed production session`, async t => {
    const f = await fixture(t);
    const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
    if (transport !== "unknown-scope") gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    let http = 0, cli = 0, credentials = 0;
    const value = encodeRestPage("[]", restPageMetadata(200, {}));
    const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: transport === "cli" ? "cli" : "auto", systemProxy: "none" }),
      credentials: new GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
      cli: async args => { cli++; assert(args.includes("--include")); return "[]"; },
      http: { read: async request => { http++; assert.equal(request.kind, "rest"); return value; }, dispose: async () => {} } });
    const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
    t.after(async () => { await cache.dispose(); await runtime.dispose(); });
    const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
    assert.equal((await buildPullRequestConversation(f.root, "owner/repo", { number: 7 }, "body", "author", runner)).length, 1);
    assert.deepEqual({ http, cli, credentials }, transport === "auto" ? { http: 3, cli: 0, credentials: 1 }
      : { http: 0, cli: 3, credentials: transport === "cli" ? 1 : 0 });
  });
}

test("Conversation rejects a changed auth context instead of publishing a successful empty timeline", async t => {
  const f = await fixture(t);
  const context = await captureGitHubRequestContext(f.root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(f.root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  let calls = 0;
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => "fixture-token"),
    http: { read: async () => {
      if (++calls === 3) await writeFile(f.hosts, "fixture: changed-during-conversation\n");
      return encodeRestPage("[]", restPageMetadata(200, {}));
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  t.after(async () => { await cache.dispose(); await runtime.dispose(); });
  const runner: GhExecute = (args, root, options) => cache.read(args, root, options);
  await assert.rejects(buildPullRequestConversation(f.root, "owner/repo", { number: 7 }, "body", "author", runner), { name: "GitHubReadContextChangedError" });
  assert.equal(calls, 3);
});
