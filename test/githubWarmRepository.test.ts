import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearGitHubRepositoryNameCache, readGitHubRepositoryName } from "../src/git/githubRepositoryName";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import type { GhExecute } from "../src/git/ghRunner";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 격리한 설정·gh 인증 경로로 실제 remote cache를 사용하고 API 경계만 대체한다. */
async function fixture(t: Parameters<typeof safetyFixture>[0], name: string) {
  const value = await safetyFixture(t, name);
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const global = join(value.directory, "global.gitconfig"), config = join(value.directory, "gh");
  await writeFile(global, ""); await mkdir(config);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: config };
  let api = 0, configs = 0, response = "owner/one";
  const runner: GhExecute = async () => { api++; return JSON.stringify({ nameWithOwner: response }); };
  const release = setGitExecutionObserver(timing => { if (timing.command === "config") configs++; }); t.after(release);
  return { ...value, global, config, env, runner,
    read: (root = value.root) => readGitHubRepositoryName(root, runner, { operation: "test", env }),
    stats: () => ({ api, configs }), respond: (next: string) => { response = next; } };
}

test("warm repository reads and concurrent consumers spawn no extra git config or repo view", async t => {
  const f = await fixture(t, "warm-repository");
  assert.equal(await f.read(), "owner/one"); const initial = f.stats();
  assert.equal(initial.api, 1); assert.equal(initial.configs, 1);
  assert.deepEqual(await Promise.all(Array.from({ length: 24 }, () => f.read())), Array(24).fill("owner/one"));
  assert.deepEqual(f.stats(), initial);
  await writeFile(join(f.root, ".git", "index.lock"), "fixture");
  assert.equal(await f.read(), "owner/one"); assert.deepEqual(f.stats(), initial, "index activity does not invalidate remote names");
});

test("relative includes, global configuration and stored authentication invalidate warmed names", async t => {
  const f = await fixture(t, "warm-include");
  const include = join(f.directory, "remote.gitconfig");
  await writeFile(include, '[remote "origin"]\n url = https://github.com/owner/one.git\n');
  await writeFile(f.global, '[include]\n path = remote.gitconfig\n');
  assert.equal(await f.read(), "owner/one"); assert.equal(await f.read(), "owner/one");
  const first = f.stats(); f.respond("owner/two");
  await writeFile(include, '[remote "origin"]\n url = https://github.com/owner/two.git\n');
  assert.equal(await f.read(), "owner/two"); assert.equal(f.stats().api, first.api + 1);
  f.respond("owner/three"); await writeFile(join(f.config, "hosts.yml"), "fixture-account-change\n");
  assert.equal(await f.read(), "owner/three");
  const warm = f.stats(); assert.equal(await f.read(), "owner/three"); assert.deepEqual(f.stats(), warm);
});

test("creating a previously absent conditional include and changing HEAD invalidate warm probes", async t => {
  const f = await fixture(t, "warm-conditional");
  await writeFile(f.global, '[includeIf "onbranch:topic"]\n path = conditional.gitconfig\n');
  assert.equal(await f.read(), "owner/one"); const first = f.stats();
  await writeFile(join(f.directory, "conditional.gitconfig"), '[remote "origin"]\n url = https://github.com/owner/two.git\n');
  f.respond("owner/two"); assert.equal(await f.read(), "owner/two"); assert.ok(f.stats().configs > first.configs);
  const beforeHead = f.stats(); await git(f.root, "checkout", "-qb", "topic");
  f.respond("owner/topic"); assert.equal(await f.read(), "owner/topic"); assert.ok(f.stats().configs > beforeHead.configs);
  const warm = f.stats(); await f.read(); assert.deepEqual(f.stats(), warm);
});

test("linked worktree names follow shared config changes while each root stays warm", async t => {
  const f = await fixture(t, "warm-worktree"); const linked = join(f.directory, "linked");
  await git(f.root, "worktree", "add", "-qb", "linked", linked);
  assert.equal(await f.read(), "owner/one"); assert.equal(await f.read(linked), "owner/one");
  const warm = f.stats(); await f.read(); await f.read(linked); assert.deepEqual(f.stats(), warm);
  await git(f.root, "remote", "add", "origin", "https://github.com/owner/new.git"); f.respond("owner/new");
  assert.equal(await f.read(linked), "owner/new"); assert.equal(await f.read(), "owner/new");
  const next = f.stats(); await f.read(linked); await f.read(); assert.deepEqual(f.stats(), next);
});

test("failed repo lookup is retryable and captured authentication environments never share names", async t => {
  const f = await fixture(t, "warm-auth"); let calls = 0;
  const runner: GhExecute = async (_args, _root, options) => {
    if (++calls === 1) throw new Error("temporary failure");
    return JSON.stringify({ nameWithOwner: `owner/${options?.env?.GH_REPO ?? "default"}` });
  };
  const options = { operation: "test", env: { ...f.env, GH_REPO: "first" } };
  await assert.rejects(readGitHubRepositoryName(f.root, runner, options), /temporary failure/);
  assert.equal(await readGitHubRepositoryName(f.root, runner, options), "owner/first");
  options.env.GH_REPO = "second";
  assert.equal(await readGitHubRepositoryName(f.root, runner, options), "owner/second");
});
