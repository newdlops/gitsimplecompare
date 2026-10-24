import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../src/git/gitExecutionDiagnostics";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { detectRepositoryIdentity } from "../src/git/repositoryDiscovery";
import { setGitExecutableResolver } from "../src/git/gitExec";

/** 실제 Native 실행만 관찰하고 검증/fixture 준비 명령은 수집 구간에서 제외한다. */
async function observed<T>(operation: () => Promise<T>) {
  const calls: GitExecutionTiming[] = [], stop = setGitExecutionObserver(timing => calls.push(timing));
  try { return { result: await operation(), calls }; } finally { stop(); }
}

/** 서로 다른 Explorer 폴더가 같은 실제 작업트리에 속하는 활성화 입력을 만든다. */
async function directories(root: string, count: number): Promise<string[]> {
  const values = Array.from({ length: count }, (_, index) => path.join(root, "packages", `module-${index}`, "src"));
  await Promise.all(values.map(value => mkdir(value, { recursive: true }))); return values;
}

test("34 different cold directories in one worktree need only one Native discovery", async t => {
  const f = await safetyFixture(t, "discovery-folder-burst"), root = await realpath(f.root), dirs = await directories(root, 34);
  const logs: Record<string, unknown>[] = [];
  const registry = new GitServiceRegistry(undefined, fields => { logs.push(fields); throw new Error("Output closed"); });
  const { result, calls } = await observed(() => Promise.all(dirs.map((directory, index) =>
    index % 3 ? registry.resolve(directory) : registry.resolveWithBranch(directory))));
  for (const item of result) {
    assert.ok(item); assert.equal("service" in item ? item.service.repoRoot : item.repoRoot, root);
    if ("branch" in item) assert.equal(item.branch, "main");
  }
  assert.equal(calls.length, 1, "A folder burst must not create one Git process per directory");
  assert.equal(calls[0].command, "rev-parse");
  assert.equal(logs.length, 1); assert.equal(logs[0].consumers, 34);
});

test("a validated sibling reuses the root while branch identity remains fresh after checkout", async t => {
  const f = await safetyFixture(t, "discovery-sibling-branch"), root = await realpath(f.root), dirs = await directories(root, 3);
  const registry = new GitServiceRegistry(); await registry.resolve(dirs[0]);
  const warm = await observed(() => registry.resolve(dirs[1]));
  assert.equal(warm.result?.repoRoot, root); assert.equal(warm.calls.length, 0);
  await git(root, "switch", "-qc", "next");
  const fresh = await registry.resolveWithBranch(dirs[2]);
  assert.equal(fresh?.service.repoRoot, root); assert.equal(fresh?.branch, "next");
});

/** Native 결과를 읽은 뒤의 경계 변경을 시간 의존 없이 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

test("different directories retain separate nested repositories and linked worktrees", async t => {
  const f = await safetyFixture(t, "discovery-nested-linked"), root = await realpath(f.root);
  const nested = path.join(root, "nested"), linked = path.join(f.directory, "linked"); await mkdir(nested);
  await git(nested, "init", "-q", "-b", "inner");
  await git(root, "worktree", "add", "-qb", "linked", linked);
  const roots = [root, nested, await realpath(linked)], inputs = await Promise.all(roots.map(value => directories(value, 6)));
  const registry = new GitServiceRegistry();
  const { result, calls } = await observed(() => Promise.all(inputs.flatMap((values, group) => values.map(async directory => {
    const found = await registry.resolve(directory); assert.equal(found?.repoRoot, roots[group]); return found;
  }))));
  assert.equal(result.length, 18); assert.equal(calls.length, 3);
  assert.equal((await registry.resolveWithBranch(inputs[1][0]))?.branch, "");
  assert.equal((await registry.resolveWithBranch(inputs[2][0]))?.branch, "linked");
});

test("a symlink crossing repositories follows the physical Native working directory", { skip: process.platform === "win32" }, async t => {
  const f = await safetyFixture(t, "discovery-symlink"), root = await realpath(f.root), other = path.join(f.directory, "other");
  await mkdir(other); await git(other, "init", "-q", "-b", "other");
  const target = (await directories(other, 1))[0], alias = path.join(root, "alias"); await symlink(target, alias, "dir");
  const registry = new GitServiceRegistry(); await registry.resolve(root);
  assert.equal((await registry.resolve(alias))?.repoRoot, await realpath(other));
  assert.equal((await registry.resolveWithBranch(alias))?.branch, "");
});

test("a bare repository nested inside a worktree is not grouped with the outside worktree", async t => {
  const f = await safetyFixture(t, "discovery-bare-boundary"), bare = path.join(f.root, "bare.git");
  await git(f.root, "init", "--bare", "-q", bare);
  const cwd = path.join(bare, "objects", "pack"), registry = new GitServiceRegistry(); await registry.resolve(f.root);
  assert.equal(await detectRepositoryIdentity(cwd), undefined);
  assert.equal(await registry.resolve(cwd), undefined);
});

test("explicit discovery ceilings retain the original Native lookup instead of inheriting an outside root", async t => {
  const f = await safetyFixture(t, "discovery-ceiling"), dirs = await directories(f.root, 2);
  const previous = process.env.GIT_CEILING_DIRECTORIES; process.env.GIT_CEILING_DIRECTORIES = path.join(f.root, "packages");
  try {
    const registry = new GitServiceRegistry(), { result, calls } = await observed(() => Promise.all(dirs.map(cwd => registry.resolve(cwd))));
    assert.deepEqual(result, [undefined, undefined]); assert.equal(calls.length, 2);
  } finally { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; }
});

test("a nested repository created while the leader is reading is rechecked before caching the alias", async t => {
  const f = await safetyFixture(t, "discovery-changing-boundary"), root = await realpath(f.root), cwd = (await directories(root, 1))[0];
  const started = deferred<void>(), release = deferred<void>(); let reads = 0;
  const registry = new GitServiceRegistry(async directory => {
    const result = await detectRepositoryIdentity(directory);
    if (++reads === 1) { started.resolve(); await release.promise; } return result;
  });
  const pending = registry.resolve(cwd); await started.promise;
  try { await git(cwd, "init", "-q", "-b", "inner"); } finally { release.resolve(); }
  assert.equal((await pending)?.repoRoot, cwd); assert.equal(reads, 2);
  assert.equal((await registry.resolve(cwd))?.repoRoot, cwd);
});

test("an explicitly configured executable keeps every lookup at its original cwd", async t => {
  const f = await safetyFixture(t, "discovery-custom-executable"), dirs = await directories(f.root, 2), root = await realpath(f.root);
  const stop = setGitExecutableResolver(() => "/usr/bin/git");
  try {
    const registry = new GitServiceRegistry(), { result, calls } = await observed(() => Promise.all(dirs.map(cwd => registry.resolve(cwd))));
    assert.ok(result.every(value => value?.repoRoot === root)); assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(value => value.repoRoot).sort(), dirs.map(value => path.resolve(value)).sort());
  } finally { stop(); }
});

test("relative global configuration is evaluated independently in each directory", async t => {
  const f = await safetyFixture(t, "discovery-relative-config"), root = await realpath(f.root), dirs = await directories(root, 2);
  const other = path.join(f.directory, "other-worktree"); await mkdir(other);
  for (const [index, directory] of dirs.entries()) await writeFile(path.join(directory, "discovery-config"),
    `[core]\n worktree = ${JSON.stringify(index ? other : root)}\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = "discovery-config";
  try {
    const expected = await Promise.all(dirs.map(directory => detectRepositoryIdentity(directory)));
    const registry = new GitServiceRegistry(), { result, calls } = await observed(() => Promise.all(dirs.map(directory => registry.resolve(directory))));
    assert.deepEqual(result.map(value => value?.repoRoot), expected.map(value => value?.root)); assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(value => value.repoRoot).sort(), dirs.map(value => path.resolve(value)).sort());
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});

test("an unavailable executable setting retains the previous no-repository result", async t => {
  const f = await safetyFixture(t, "discovery-executable-setting-error");
  const stop = setGitExecutableResolver(() => { throw new Error("Configuration unavailable"); });
  try { assert.equal(await new GitServiceRegistry().resolve(f.root), undefined); }
  finally { stop(); }
});
