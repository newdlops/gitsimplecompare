import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubReadRuntime } from "../src/git/githubReadRuntime";
import { GitHubReadCache } from "../src/git/githubReadCache";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { captureGitHubRequestContext } from "../src/git/githubReadSession";
import { gitHubRepositoryScopes } from "../src/git/githubRepositoryScope";
import { fetchPullRequestDetail } from "../src/git/pullRequestDetail";
import { fetchPullRequestChangedFiles } from "../src/git/pullRequestPreviewFiles";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
import type { GitHubReadRequest } from "../src/git/githubReadRequest";
import type { GhExecute } from "../src/git/ghRunner";

/** 실제 상세 조회가 완전한 snapshot을 저장하게 하고 외부 HTTP만 통제한다. */
async function fixture(t: test.TestContext, changeType = "MODIFIED", initialCount = 1000) {
  const root = await mkdtemp(join(tmpdir(), "gsc-comparison-snapshot-"));
  await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  await writeFile(join(root, ".git/config"), '[remote "origin"]\nurl=https://github.com/owner/repo.git\n');
  await writeFile(join(root, "gh/hosts.yml"), "fixture: original\n");
  const before = { ...process.env };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_CLI_PATH"]) delete process.env[name];
  Object.assign(process.env, { GH_REPO: "owner/repo", GH_HOST: "github.com", GH_CONFIG_DIR: join(root, "gh") });
  const context = await captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  gitHubRepositoryScopes.learn(root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const state = { token: "first", head: "head", base: "base", count: initialCount, type: changeType };
  const calls: GitHubReadRequest[] = [];
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new GitHubCredentialProvider(async () => state.token), cli: async () => { throw new Error("unexpected CLI"); },
    http: { read: async request => {
      calls.push(request);
      if (request.kind === "graphql") {
        const start = Number(request.variables.cursor ?? 0), projected = request.query.includes("nodes { path");
        return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
          number: 7, headRefOid: state.head, baseRefOid: state.base, files: { totalCount: state.count, ...(projected ? {
            nodes: Array.from({ length: Math.max(0, Math.min(100, state.count - start)) }, (_, index) => ({ path: `file-${start + index}.ts`, additions: 2, deletions: 1, changeType: state.type })),
            pageInfo: { hasNextPage: start + 100 < state.count, endCursor: String(start + 100) },
          } : {}) }, comments: { totalCount: 0 }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } });
      }
      const url = new URL(request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
      const start = (page - 1) * 100;
      const values = Array.from({ length: Math.max(0, Math.min(100, state.count - start)) }, (_, index) => ({ filename: `file-${start + index}.ts`,
        status: state.type === "RENAMED" ? "renamed" : state.type === "COPIED" ? "copied" : "modified", previous_filename: ["RENAMED", "COPIED"].includes(state.type) ? `old-${start + index}.ts` : undefined, additions: 2, deletions: 1 }));
      const next = new URL(url); next.searchParams.set("page", String(page + 1));
      return encodeRestPage(JSON.stringify(values), restPageMetadata(200, start + 100 < state.count ? { link: `<${next}>; rel="next"` } : {}));
    }, dispose: async () => {} } });
  const cache = new GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  const execute: GhExecute = (args, cwd, options) => cache.read(args, cwd, options);
  t.after(async () => { await cache.dispose(); await runtime.dispose(); gitHubRepositoryScopes.clear();
    for (const name of ["GH_REPO", "GH_HOST", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_CLI_PATH"]) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  await fetchPullRequestDetail(root, "{owner}/{repo}", 7, undefined, execute); calls.length = 0;
  return { state, calls, load: () => fetchPullRequestChangedFiles(root, "{owner}/{repo}", 7, execute) };
}

test("Explorer reuses 1000 complete files after one freshly authorized anchor", async t => {
  const f = await fixture(t), result = await f.load();
  assert.equal(result.files.length, 1000); assert.equal(result.truncated, false);
  assert.deepEqual(result.files[999], { status: "M", path: "file-999.ts", oldPath: undefined, additions: 2, deletions: 1 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].kind, "graphql");
});

for (const type of ["RENAMED", "COPIED", "UNKNOWN", "TYPE_CHANGED"]) {
  test(`Explorer preserves REST semantics for ${type} snapshots`, async t => {
    const f = await fixture(t, type, 1), result = await f.load();
    assert.equal(f.calls.filter(r => r.kind === "rest").length, 1);
    assert.equal(result.files[0].oldPath, ["RENAMED", "COPIED"].includes(type) ? "old-0.ts" : undefined);
    assert.equal(result.files[0].status, type === "RENAMED" ? "R" : type === "COPIED" ? "C" : "M");
  });
}

for (const boundary of ["token", "head", "base", "count"] as const) {
  test(`Explorer does not reuse a file snapshot after ${boundary} changes`, async t => {
    const f = await fixture(t, "MODIFIED", 1);
    if (boundary === "count") f.state.count = 2; else f.state[boundary] = "changed";
    const result = await f.load();
    assert.equal(result.files.length, f.state.count); assert.equal(f.calls.filter(r => r.kind === "rest").length, 1);
  });
}

test("an exact 3000-file snapshot retains the conservative REST limit marker", async t => {
  const f = await fixture(t, "MODIFIED", 3000), result = await f.load();
  assert.equal(result.files.length, 3000); assert.equal(result.truncated, true);
});
