import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { GitHubReadCache } from "../src/git/githubReadCache";
import { createGitHubReadSession, GitHubReadContextChangedError } from "../src/git/githubReadSession";
import { clearGitHubRemoteContextCache } from "../src/git/githubRemoteContext";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git include로만 원격 설정을 제공하고 자격 증명 경로도 fixture 안으로 격리한다. */
async function fixture(t: TestContext) {
  const value = await safetyFixture(t, "gh-read-includes");
  clearGitHubRemoteContextCache(); t.after(clearGitHubRemoteContextCache);
  const include = join(value.directory, "remote.inc"), config = join(value.directory, "gh");
  await mkdir(config); await writeFile(include, '[remote "origin"]\nurl = https://github.com/fixture/original.git\n');
  await git(value.root, "config", "include.path", include);
  return { ...value, include, env: { GH_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } };
}

test("changing an included remote configuration invalidates completed GitHub responses", async t => {
  const f = await fixture(t); let calls = 0;
  const cache = new GitHubReadCache(async () => String(++calls)); t.after(() => cache.dispose());
  const args = ["api", "repos/{owner}/{repo}/pulls"], options = { operation: "include-cache", env: f.env, ttlMs: 60_000 };
  assert.equal(await cache.read(args, f.root, options), "1");
  assert.equal(await cache.read(args, f.root, options), "1");
  await writeFile(f.include, '[remote "origin"]\nurl = https://github.com/fixture/replacement.git\n');
  assert.equal(await cache.read(args, f.root, options), "2");
  assert.equal(await cache.read(args, f.root, options), "2");
  assert.equal(calls, 2);
});

test("a session rejects an included remote changing while a page is in flight", async t => {
  const f = await fixture(t), before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = f.env.GIT_CONFIG_GLOBAL;
  t.after(() => { if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before; });
  let finish!: (value: string) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const read = createGitHubReadSession(f.root, async () => {
    started(); return new Promise<string>(resolve => { finish = resolve; });
  });
  const result = read(["api", "repos/{owner}/{repo}/pulls"], f.root, { operation: "include-session" });
  const observed = assert.rejects(result, GitHubReadContextChangedError);
  await ready;
  await writeFile(f.include, '[remote "origin"]\nurl = https://github.com/fixture/switched.git\n');
  finish("old-page"); await observed;
});

test("unchanged included settings let warm concurrent GitHub reads avoid extra Git config processes", async t => {
  const f = await fixture(t); let configs = 0, requests = 0;
  const release = setGitExecutionObserver(row => { if (row.repoRoot === f.root && row.command === "config") configs++; }); t.after(release);
  const cache = new GitHubReadCache(async () => String(++requests)); t.after(() => cache.dispose());
  const args = ["api", "repos/{owner}/{repo}/pulls"], options = { operation: "include-warm", env: f.env, ttlMs: 60_000 };
  assert.equal(await cache.read(args, f.root, options), "1");
  const coldConfigs = configs;
  assert.ok(coldConfigs > 0, "the actual Git include sources must be discovered");
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => cache.read(args, f.root, options))), Array(12).fill("1"));
  assert.equal(configs, coldConfigs); assert.equal(requests, 1);
});

test("config discovery cannot inherit a new GIT_DIR that the captured GitHub request never received", async t => {
  const previous = process.env.GIT_DIR; delete process.env.GIT_DIR;
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  const f = await fixture(t), other = await safetyFixture(t, "gh-context-other-repo");
  await git(other.root, "remote", "add", "origin", "https://github.com/fixture/unrelated.git");
  let calls = 0;
  const read = createGitHubReadSession(f.root, async (_args, cwd, options) => {
    calls++;
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, env: options.env, encoding: "utf8" }).trim();
    assert.equal(remote, "https://github.com/fixture/original.git");
    await writeFile(f.include, '[remote "origin"]\nurl = https://github.com/fixture/switched.git\n');
    return remote;
  });
  process.env.GIT_DIR = join(other.root, ".git");
  await assert.rejects(read(["api", "repos/{owner}/{repo}/pulls"], f.root, { operation: "config-snapshot" }), GitHubReadContextChangedError);
  assert.equal(calls, 1);
});
