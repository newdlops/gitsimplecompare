import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { setOwnedFsmonitorPolicy } from "../src/git/ownedFsmonitor";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

test("Native index mutations with builtin fsmonitor configured preserve content/config and never start a daemon", { skip: process.platform !== "darwin" }, async t => {
  const f = await safetyFixture(t, "monitor-native-write");
  await git(f.root, "config", "core.fsmonitor", "true");
  const config = await readFile(path.join(f.root, ".git/config")), commands: string[] = [];
  const reset = setOwnedFsmonitorPolicy(() => undefined), stop = setGitExecutionObserver(timing => commands.push(timing.command));
  try {
    await writeFile(path.join(f.root, "tracked.txt"), "user content\n");
    await git(f.root, "add", "--", "tracked.txt");
    assert.equal(await git(f.root, "-c", "core.fsmonitor=false", "diff", "--cached", "--name-only"), "tracked.txt");
    await git(f.root, "commit", "--no-verify", "-qm", "native write");
    assert.notEqual(await git(f.root, "rev-parse", "HEAD"), f.head);
    assert.equal(await git(f.root, "show", "HEAD:tracked.txt"), "user content");
    assert.equal(await git(f.root, "-c", "core.fsmonitor=false", "status", "--porcelain=v1"), "");
    assert.deepEqual(await readFile(path.join(f.root, ".git/config")), config);
    assert.equal(commands.includes("fsmonitor--daemon"), false);
    await assert.rejects(runGit(["fsmonitor--daemon", "status"], f.root, { readTimeoutMs: 1000, retryOnLock: false }));
  } finally {
    stop(); reset(); await gitProcesses.dispose();
    await runGit(["fsmonitor--daemon", "stop"], f.root, { signal: AbortSignal.timeout(2000), retryOnLock: false }).catch(() => undefined);
  }
});

for (const mode of ["squash", "replay"] as const) test(`Native PR ${mode} and Undo do not start fsmonitor in the checkout or temporary worktree`, { skip: process.platform !== "darwin" }, async t => {
  const f = await prSafetyFixture(t);
  await git(f.root, "config", "core.fsmonitor", "true");
  const config = await readFile(path.join(f.root, ".git/config")), commands: string[] = [];
  const reset = setOwnedFsmonitorPolicy(() => undefined), stop = setGitExecutionObserver(timing => commands.push(timing.command));
  try {
    const result = mode === "squash" ? await f.service.squashCherryPick(f.pr) : await f.service.rebasePullRequest(f.pr);
    assert.equal(result.status, "completed");
    assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), await git(f.root, "rev-parse", `${f.source}^{tree}`));
    assert.equal(commands.includes("fsmonitor--daemon"), false, "PR writes must not create a daemon for a disposable no-checkout worktree");
    await f.service.undoLastOperation();
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.base);
    assert.deepEqual(await readFile(path.join(f.root, ".git/config")), config);
    assert.equal(commands.includes("fsmonitor--daemon"), false);
    await assert.rejects(runGit(["fsmonitor--daemon", "status"], f.root, { readTimeoutMs: 1000, retryOnLock: false }));
  } finally {
    stop(); reset(); await gitProcesses.dispose();
    await runGit(["fsmonitor--daemon", "stop"], f.root, { signal: AbortSignal.timeout(2000), retryOnLock: false }).catch(() => undefined);
  }
});
