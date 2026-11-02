import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubReadRuntime } from "../src/git/githubReadRuntime";
import { GitHubReadCache, readGitHub } from "../src/git/githubReadCache";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { captureGitHubRequestContext, gitHubRootCommitSnapshotHint, inheritGitHubReadSession, gitHubReadSessionState } from "../src/git/githubReadSession";
import { gitHubRepositoryScopes } from "../src/git/githubRepositoryScope";
import { fetchPreviewBootstrap, fetchPreviewCommitSummaries, previewReadRunner } from "../src/git/pullRequestPreviewRemote";
import { PullRequestService } from "../src/git/pullRequestService";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
import type { PullRequestInfo } from "../src/git/pullRequestInfo";
import type { GhExecute } from "../src/git/ghRunner";

/** 실제 인증·세션·snapshot을 사용하고 HTTP 응답만 쿼리 투영에 맞춰 만든다. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gsc-preview-bootstrap-"));
  await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  await writeFile(join(root, ".git/config"), '[remote "origin"]\nurl=https://github.com/owner/repo.git\n');
  await writeFile(join(root, "gh/hosts.yml"), "fixture: original\n");
  const keys = ["GH_REPO", "GH_HOST", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_CLI_PATH"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { GH_REPO: "owner/repo", GH_HOST: "github.com", GH_CONFIG_DIR: join(root, "gh") });
  const context = await captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const state = { token: "one", head: "head", base: "base", title: "Fresh title", repairBase: "", error: false };
  const calls: Array<{ operation: string; projected: boolean; bytes: number }> = [];
  const hashes = Array.from({ length: 200 }, (_, i) => `commit-${i}`).concat("head");
  const selected = { number: 7, title: "Old title", url: "https://github.com/owner/repo/pull/7", state: "OPEN",
    headRefName: "topic", baseRefName: "main", headHash: "head", baseHash: "base", fileCount: 3,
    fileCountComplete: true, commitHashes: hashes, commitHashesComplete: true } as PullRequestInfo;
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => state.token), cli: async () => { throw new Error("unexpected CLI"); },
    http: { read: async (request, _lease, options) => {
      if (request.kind !== "graphql") return encodeRestPage("[]", restPageMetadata(200, {}));
      const start = Number(request.variables.cursor ?? 0), projected = /\bcommits\s*\(/.test(request.query);
      const body = JSON.stringify(state.error ? { errors: [{ message: "not authorized" }] } : { data: { repository: {
        nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
          title: state.title, body: "fresh body", headRefOid: state.head,
          baseRefOid: options.operation === "pr-preview-commit-summaries" && state.repairBase || state.base, baseRefName: "main",
          ...(projected ? { commits: { nodes: hashes.slice(start, start + 100).map(oid => ({ commit: { oid,
            messageHeadline: `Title ${oid}`, author: { name: "Author" }, committedDate: "2026-11-02T00:00:00Z" } })),
            pageInfo: { hasNextPage: start + 100 < hashes.length, endCursor: String(start + 100) } } } : {}),
        },
      } } });
      calls.push({ operation: options.operation, projected, bytes: Buffer.byteLength(body) }); return body;
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  const execute: GhExecute = (args, cwd, options) => cache.read(args, cwd, { ...options, ttlMs: 0 });
  /** panel마다 새 wrapper로 힌트를 전달하되 결과는 새 세션에서 다시 인가한다. */
  const wrapped = () => { const runner: GhExecute = (...args) => execute(...args); inheritGitHubReadSession(execute, runner); return runner; };
  const load = async () => { const runner = wrapped(), bootstrap = await fetchPreviewBootstrap(root, selected, runner);
    return { bootstrap, commits: await fetchPreviewCommitSummaries(root, selected, runner, bootstrap.firstPage) }; };
  t.after(async () => { await cache.dispose(); await runtime.dispose(); gitHubRepositoryScopes.clear();
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, state, calls, selected, execute, load };
}

test("warm preview omits commit bodies while cold preview combines bootstrap and first page", async t => {
  const f = await fixture(t), cold = await f.load();
  assert.equal(f.calls.length, 3); assert.equal(f.calls[0].projected, true);
  const firstBytes = f.calls[0].bytes; f.calls.length = 0; f.state.title = "Updated title";
  const warm = await f.load();
  assert.deepEqual(warm.commits, cold.commits); assert.equal(warm.bootstrap.title, "Updated title");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].projected, false);
  assert(f.calls[0].bytes < firstBytes / 10);
  console.info("P3 controlled response bytes", JSON.stringify({ coldFirst: firstBytes, warm: f.calls[0].bytes }));
});

for (const boundary of ["token", "base"] as const) {
  test(`a stale preview hint after ${boundary} change repairs every commit page`, async t => {
    const f = await fixture(t); await f.load(); f.calls.length = 0; f.state[boundary] = "changed";
    const result = await f.load();
    assert.equal(result.commits.length, 201); assert.equal(result.commits[200].title, "Title head");
    assert.deepEqual(f.calls.map(call => call.projected), [false, true, true, true]);
  });
}

test("a base change between thin bootstrap and cache-miss repair rejects mixed commits", async t => {
  const f = await fixture(t); await f.load(); f.state.token = "changed"; f.state.repairBase = "other-base";
  await assert.rejects(f.load(), /base changed/i);
});

test("warm preview rejects a changed head or failed authorization before consuming cached commits", async t => {
  const f = await fixture(t); await f.load(); f.calls.length = 0; f.state.head = "other-head";
  await assert.rejects(f.load(), /head changed/i); assert.equal(f.calls.length, 1);
  f.state.head = "head"; f.state.error = true; f.calls.length = 0;
  await assert.rejects(f.load(), /incomplete/i); assert.equal(f.calls.length, 1);
});

test("production preview assembly carries warm hints across a newly owned wrapper", async t => {
  const f = await fixture(t), service = new PullRequestService(f.root);
  const first = await (service as any).previewRemote(f.selected, f.execute); f.calls.length = 0;
  const second = await (service as any).previewRemote(f.selected, f.execute);
  assert.deepEqual(second.prPreviewCommits, first.prPreviewCommits);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].projected, false);
});

test("default preview runner forwards only hint metadata before a new authorization", async t => {
  const f = await fixture(t); await f.load(); inheritGitHubReadSession(f.execute, readGitHub);
  const runner = previewReadRunner(f.root, f.selected);
  assert.equal(gitHubRootCommitSnapshotHint(runner, f.root), true);
  assert.equal(gitHubReadSessionState(runner), undefined);
});
