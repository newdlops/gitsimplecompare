import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { GitHubRepositoryScopes } from "../src/git/githubRepositoryScope";
import { gitHubRepositoryScopes } from "../src/git/githubRepositoryScope";
import { createGitHubReadSession, completeGitHubReadSession, gitHubReadSessionState } from "../src/git/githubReadSession";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("credential leases honor gh precedence and distinguish actual replacements", async () => {
  let calls = 0, saved = "stored-one";
  const provider = new GitHubCredentialProvider(async () => { calls++; return saved; });
  const first = await provider.acquire("/repo", { GH_TOKEN: "first", GITHUB_TOKEN: "second" });
  assert.equal(first.authorization(), "Bearer first"); assert.equal(calls, 0);
  assert(!JSON.stringify(first).includes("first"));
  const old = await provider.acquire("/repo", {});
  saved = "stored-two";
  const fresh = await provider.acquire("/repo", {});
  assert.notEqual(old.key, fresh.key); assert.equal(calls, 2);
  assert.equal(old.authorization(), "Bearer stored-one");
  await provider.dispose();
});

test("only in-flight credential lookups coalesce and consumer abort is isolated", async () => {
  let release!: (s: string) => void, calls = 0;
  const provider = new GitHubCredentialProvider(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const cancelled = new AbortController();
  const first = provider.acquire("/repo", {}, cancelled.signal);
  const second = provider.acquire("/repo", {});
  await new Promise(resolve => setImmediate(resolve));
  cancelled.abort();
  await assert.rejects(first, { name: "AbortError" });
  release("shared-token");
  assert.equal((await second).authorization(), "Bearer shared-token"); assert.equal(calls, 1);
  await provider.dispose();
});

test("credential lookup errors and cancellation never expose stdout, stderr or cause", async () => {
  const provider = new GitHubCredentialProvider(async () => { throw Object.assign(new Error("secret-token"), { stdout: "secret-token", stderr: "secret-token" }); });
  await assert.rejects(provider.acquire("/repo", {}), error => {
    assert(!String(error).includes("secret-token")); assert(!JSON.stringify(error).includes("secret-token"));
    assert.equal("cause" in (error as Error), false); return true;
  });
  await assert.rejects(provider.acquire("/repo", { GH_HOST: "enterprise.example" }));
  await provider.dispose();
});

test("canonical scopes require matching URL/name and observable context", () => {
  const scopes = new GitHubRepositoryScopes();
  assert.equal(scopes.get("/r", "ctx"), undefined);
  assert.equal(scopes.learn("/r", "ctx", { nameWithOwner: "owner/repo", url: "https://github.com/owner/other" }), false);
  assert.equal(scopes.learn("/r", undefined, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }), false);
  assert.equal(scopes.learn("/r", "ctx", { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }), true);
  assert.equal(scopes.get("/r", "ctx")?.name, "owner/repo");
  assert.equal(scopes.get("/r", "new-account"), undefined);
  assert.equal(scopes.learn("/r", "ctx", { nameWithOwner: "owner/repo", url: "https://ghe.example/owner/repo" }), true);
  assert.equal(scopes.get("/r", "ctx")?.host, "ghe.example");
  scopes.clear(); assert.equal(scopes.get("/r", "ctx"), undefined);
});

test("bootstrap scope is unpublished until the full logical query succeeds", async t => {
  const root = await mkdtemp(join(tmpdir(), "gsc-http-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => gitHubRepositoryScopes.clear());
  const session = createGitHubReadSession(root, async () => JSON.stringify({ data: { repository: {
    nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" } } }));
  await session(["api", "graphql"], root, { operation: "scope-test" });
  const state = gitHubReadSessionState(session)!;
  assert.equal(gitHubRepositoryScopes.get(root, state.context), undefined);
  await completeGitHubReadSession(session);
  assert.equal(gitHubRepositoryScopes.get(root, state.context)?.name, "owner/repo");
});
