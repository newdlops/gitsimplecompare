import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hasStagedWorkingTreeChanges, hasTrackedWorkingTreeChanges } from "../src/git/workingTreeChanges";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { setOwnedFsmonitorPolicy } from "../src/git/ownedFsmonitor";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 임시 fixture에 같은 HEAD를 유지한 채 각 index/작업 파일 상태를 구성한다. */
async function prepare(root: string, mode: string): Promise<void> {
  if (mode === "clean") return;
  if (mode === "untracked") { await writeFile(path.join(root, "new.txt"), "untracked\n"); return; }
  if (mode === "delete") { await rm(path.join(root, "tracked.txt")); return; }
  if (mode === "rename") { await git(root, "mv", "tracked.txt", "renamed 한글\nfile.txt"); return; }
  if (mode === "intent-to-add") {
    await writeFile(path.join(root, "new.txt"), "intent\n"); await git(root, "add", "-N", "new.txt"); return;
  }
  await writeFile(path.join(root, "tracked.txt"), mode === "binary" ? Buffer.from([0, 2, 0, 255]) : "changed\n");
  if (mode !== "unstaged") await git(root, "add", "tracked.txt");
  if (mode === "cancelling") await writeFile(path.join(root, "tracked.txt"), "base\n");
}

for (const mode of ["clean", "untracked", "staged", "unstaged", "delete", "rename", "binary", "cancelling", "intent-to-add"]) {
  test(`tracked ${mode} agrees with native status, preserves index and avoids unnecessary worktree reads`, async t => {
    const f = await safetyFixture(t, `tracked-${mode}`); await prepare(f.root, mode);
    const expected = Boolean(await git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=no"));
    const index = await readFile(path.join(f.root, ".git/index"));
    if (mode === "cancelling") assert.equal(await git(f.root, "diff", "HEAD", "--name-only"), "");
    const timings: string[] = [], stop = setGitExecutionObserver(value => timings.push(value.command));
    let actual: boolean;
    try { actual = await hasTrackedWorkingTreeChanges(f.root); } finally { stop(); }
    assert.equal(actual, expected); assert.equal(actual, !["clean", "untracked"].includes(mode));
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
    const staged = ["staged", "rename", "binary", "cancelling"].includes(mode);
    if (mode !== "intent-to-add") assert.deepEqual(timings, staged ? ["diff"] : ["diff", "diff"]);
    assert.ok(timings.length <= 2);
  });
}

test("tracked changes ignore configured external diff and textconv helpers", async t => {
  const f = await safetyFixture(t, "tracked-no-external"), marker = path.join(f.directory, "called"), helper = path.join(f.directory, "helper");
  await writeFile(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');process.exit(99);\n`, { mode: 0o755 });
  await writeFile(path.join(f.root, ".git/info/attributes"), "tracked.txt diff=fixture\n");
  await git(f.root, "config", "diff.external", helper); await git(f.root, "config", "diff.trustExitCode", "true");
  await git(f.root, "config", "diff.fixture.textconv", helper);
  await writeFile(path.join(f.root, "tracked.txt"), "changed\n");
  assert.equal(await hasTrackedWorkingTreeChanges(f.root), true);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("staged detection never prepares or starts a configured builtin filesystem monitor", async t => {
  const f = await safetyFixture(t, "tracked-index-monitor"); await prepare(f.root, "staged");
  await git(f.root, "config", "core.fsmonitor", "true");
  const stopPolicy = setOwnedFsmonitorPolicy(() => undefined), commands: string[] = [];
  const stopObserver = setGitExecutionObserver(value => commands.push(value.command));
  try { assert.equal(await hasTrackedWorkingTreeChanges(f.root), true); }
  finally { stopObserver(); stopPolicy(); }
  assert.deepEqual(commands, ["diff"]);
});

test("staged detection ignores unrelated working files and preserves a hidden gitlink in the index", async t => {
  const f = await safetyFixture(t, "tracked-gitlink");
  await prepare(f.root, "unstaged");
  assert.equal(await hasStagedWorkingTreeChanges(f.root), false);
  await git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.head},module`);
  await git(f.root, "config", "diff.ignoreSubmodules", "all");
  assert.notEqual(await git(f.root, "write-tree"), await git(f.root, "rev-parse", "HEAD^{tree}"));
  const index = await readFile(path.join(f.root, ".git/index"));
  assert.equal(await hasStagedWorkingTreeChanges(f.root), true);
  assert.equal(await hasTrackedWorkingTreeChanges(f.root), true);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
});

for (const staged of [true, false]) for (const code of ["ETIMEDOUT", "EACCES"]) {
  test(`tracked ${staged ? "index" : "worktree"} ${code} is propagated without starting another read`, async t => {
    const f = await safetyFixture(t, "tracked-error"), spawn = childProcess.spawn;
    const failure = Object.assign(new Error(`tracked read failed ${code}`), { code }); let reads = 0;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1]) && args[1].includes("diff")) {
        reads++; if (args[1].includes("--cached") === staged) throw failure;
      }
      return Reflect.apply(spawn, childProcess, args);
    });
    await assert.rejects(hasTrackedWorkingTreeChanges(f.root), error => error === failure);
    assert.equal(reads, staged ? 1 : 2);
  });
}

test("a corrupt native index is an error instead of a positive pending-changes result", async t => {
  const f = await safetyFixture(t, "tracked-index-corrupt"), invalid = Buffer.from("broken index fixture");
  await writeFile(path.join(f.root, ".git/index"), invalid);
  const state = new PullRequestOperationSnapshot(f.root);
  await assert.rejects(state.hasPendingChanges(), error => (error as { code?: unknown }).code === 128);
  await assert.rejects(state.hasPendingChangesIn(f.root), error => (error as { code?: unknown }).code === 128);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), invalid);
});
