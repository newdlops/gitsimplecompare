import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { snapshotRefForBranch, snapshotRefForCommand } from "../src/git/pullRequestOperationFormat";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { GitError, resolveGitExecutable, runGitWithInput, setGitExecutableResolver } from "../src/git/gitExec";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { createSnapshotRefSet } from "../src/git/snapshotRefTransaction";

/** 실제 Git의 명령 파서만 시험하고 abort해 구버전에서 atomic 전용 검사를 명확하게 건너뛴다. */
async function supportsSymbolicTransaction(root: string): Promise<boolean> {
  return runGitWithInput(["update-ref", "--stdin"], root,
    "start\nsymref-update refs/gitsimplecompare/atomic-capability refs/heads/main\nabort\n", { retryOnLock: false })
    .then(() => true, () => false);
}

test("PR snapshot and both latest pointers use one owned Git transaction and remain undoable", async t => {
  const f = await safetyFixture(t, "pr-atomic-snapshot");
  if (!await supportsSymbolicTransaction(f.root)) { t.skip("This Git does not support symbolic ref transactions"); return; }
  const writes: string[] = [];
  const stop = setGitExecutionObserver(timing => { if (["update-ref", "symbolic-ref"].includes(timing.command)) writes.push(timing.command); });
  const state = new PullRequestOperationSnapshot(f.root);
  let snapshot: string;
  try { snapshot = await state.createSnapshot("main", f.head, "squash"); }
  finally { stop(); }
  assert.deepEqual(writes, ["update-ref"], "Three coupled recovery refs must use one transaction");
  assert.equal(await git(f.root, "rev-parse", snapshot), f.head);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForBranch("main")), snapshot);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForCommand("main", "squash")), snapshot);
  await state.recordCompleted("main", snapshot);
  assert.equal((await state.prepareUndo("main")).snapshotRef, snapshot);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("a locked latest pointer leaves every recovery ref and the previous Undo unchanged", async t => {
  const f = await safetyFixture(t, "pr-atomic-lock");
  if (!await supportsSymbolicTransaction(f.root)) { t.skip("This Git does not support symbolic ref transactions"); return; }
  const state = new PullRequestOperationSnapshot(f.root), previous = await state.createSnapshot("main", f.head, "squash");
  await state.recordCompleted("main", previous);
  const refs = () => git(f.root, "for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/gitsimplecompare");
  const before = await refs(), lock = join(f.root, ".git", snapshotRefForBranch("main") + ".lock");
  await writeFile(lock, "held by another process\n");
  try { await assert.rejects(state.createSnapshot("main", f.head, "squash"), /lock|File exists/i); }
  finally { await rm(lock); }
  assert.equal(await refs(), before, "A failed coupled update must not create or move any recovery ref");
  assert.equal((await state.prepareUndo("main")).snapshotRef, previous);
  assert.equal(await git(f.root, "status", "--porcelain"), "");
});

test("a rejecting reference transaction hook does not trigger a legacy retry or remove the previous snapshot", async t => {
  const f = await safetyFixture(t, "pr-atomic-hook");
  if (!await supportsSymbolicTransaction(f.root)) { t.skip("This Git does not support symbolic ref transactions"); return; }
  const state = new PullRequestOperationSnapshot(f.root), previous = await state.createSnapshot("main", f.head, "squash");
  const before = await git(f.root, "for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/gitsimplecompare");
  const events = join(f.directory, "hook-events");
  const quotedEvents = "'" + events.replace(/'/g, "'\\''") + "'";
  // hook이 parser와 같은 문구를 출력해도 Git의 실제 hook 거부를 fallback으로 재실행하면 안 된다.
  await writeFile(join(f.directory, "hooks/reference-transaction"), `#!/bin/sh\nif [ "$1" = prepared ]; then printf 'prepared\\n' >> ${quotedEvents}; printf 'fatal: unknown command: symref-update ignored\\n' >&2; exit 1; fi\n`, { mode: 0o755 });
  await assert.rejects(state.createSnapshot("main", f.head, "squash"), error => {
    return error instanceof GitError && /ref updates aborted by hook/i.test(error.stderr);
  });
  assert.equal((await readFile(events, "utf8")).trim(), "prepared", "A real hook failure must not be retried as an unsupported command");
  assert.equal(await git(f.root, "for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/gitsimplecompare"), before);
  assert.equal(await git(f.root, "rev-parse", previous), f.head);
});

for (const unsupported of ["start", "symref-update"]) {
test(`older Git without ${unsupported} uses the symbolic ref contract and does not repeat unsupported probes`, async t => {
  const f = await safetyFixture(t, "pr-atomic-old-git");
  const executable = join(f.directory, "older-git"), probes = join(f.directory, "unsupported-probes");
  const nativeGit = resolveGitExecutable(f.root);
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);if(args.includes('--stdin')){fs.readFileSync(0);fs.appendFileSync(${JSON.stringify(probes)},'unsupported\\n');process.stderr.write(${JSON.stringify(`fatal: unknown command: ${unsupported}\n`)});process.exit(128);}const result=cp.spawnSync(${JSON.stringify(nativeGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`, { mode: 0o755 });
  const reset = setGitExecutableResolver(() => executable); t.after(reset);
  const state = new PullRequestOperationSnapshot(f.root);
  const first = await state.createSnapshot("main", f.head, "squash"), second = await state.createSnapshot("main", f.head, "rebase");
  assert.notEqual(first, second);
  assert.equal((await readFile(probes, "utf8")).trim(), "unsupported");
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForCommand("main", "squash")), first);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForCommand("main", "rebase")), second);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForBranch("main")), second);
  await state.recordCompleted("main", second);
  assert.equal((await state.prepareUndo("main")).snapshotRef, second);
});
}

test("a colliding immutable snapshot is never overwritten or claimed by the failing caller", async t => {
  const f = await safetyFixture(t, "pr-atomic-collision");
  const snapshot = "refs/gitsimplecompare/collision/snapshot", latest = "refs/gitsimplecompare/collision/latest";
  await createSnapshotRefSet(f.root, snapshot, f.head, [latest], () => undefined);
  let created = false;
  await assert.rejects(createSnapshotRefSet(f.root, snapshot, f.head, [latest], () => { created = true; }), /already exists|reference exists/i);
  assert.equal(created, false, "The failing caller must not be allowed to clean up someone else's snapshot");
  assert.equal(await git(f.root, "rev-parse", snapshot), f.head);
  assert.equal(await git(f.root, "symbolic-ref", latest), snapshot);
});

test("a later snapshot moves symbolic pointers without changing the earlier immutable recovery commit", async t => {
  const f = await safetyFixture(t, "pr-atomic-repeat");
  const state = new PullRequestOperationSnapshot(f.root), first = await state.createSnapshot("main", f.head, "squash");
  const nextHead = await commitText(f.root, "next\n", "next");
  const second = await state.createSnapshot("main", nextHead, "squash");
  assert.notEqual(second, first);
  assert.equal(await git(f.root, "rev-parse", first), f.head);
  assert.equal(await git(f.root, "rev-parse", second), nextHead);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForCommand("main", "squash")), second);
  assert.equal(await git(f.root, "symbolic-ref", snapshotRefForBranch("main")), second);
  await state.recordCompleted("main", second);
  assert.equal((await state.prepareUndo("main")).snapshotRef, second);
});
