import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitError } from "../src/git/gitExec";
import { PullService } from "../src/git/pullService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 자동 stash 및 pull/복원 충돌을 만들어 후속 명령을 검증할 상태를 반환한다. */
async function conflictingPull(t: TestContext, diverged = true) {
  const fixture = await safetyFixture(t, "pull-safety");
  const { root, directory, head: base } = fixture;
  await addOrigin(root, directory);
  await git(root, "switch", "-qc", "incoming");
  const incoming = await commitText(root, "remote version\n", "remote update");
  await git(root, "push", "-q", "origin", "HEAD:main");
  await git(root, "switch", "-q", "main");
  const beforeHead = diverged ? await commitText(root, "local version\n", "local update") : base;
  await writeFile(join(root, "tracked.txt"), "saved local changes\n");
  const service = new PullService(root);
  const result = await service.pullCurrent();
  assert.equal(result.status, "conflicts");
  assert.ok(result.status === "conflicts" && result.snapshot);
  assert.equal(result.stage, diverged ? "pull" : "restoreLocalChanges");
  return { ...fixture, service, beforeHead, incoming, snapshot: result.snapshot };
}

/** 다른 worktree에서 사용자 stash를 추가하여 공유 stash 목록의 순번을 바꾼다. */
async function addUnrelatedStash(root: string, directory: string, base: string): Promise<string> {
  const other = join(directory, "stash-worktree");
  await git(root, "worktree", "add", "-b", "stash-helper", other, base);
  await writeFile(join(other, "tracked.txt"), "unrelated saved work\n");
  await git(other, "stash", "push", "-m", "user stash");
  return git(root, "rev-parse", "refs/stash");
}

test("a pull conflict can be rolled back after service recreation and stash reordering", async (t) => {
  const { root, directory, head, beforeHead, snapshot } = await conflictingPull(t);
  const unrelated = await addUnrelatedStash(root, directory, head);
  const reloaded = new PullService(root);
  assert.equal((await reloaded.findLatestPullRollbackSnapshot())?.id, snapshot.id);
  assert.equal((await reloaded.rollbackLatestPull(snapshot.id))?.hash, snapshot.hash);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "saved local changes\n");
  assert.equal(await git(root, "stash", "list", "--format=%H"), unrelated);
  assert.equal(await reloaded.findLatestPullRollbackSnapshot(), undefined);
});

test("an old pull snapshot cannot reset or clean up another branch", async (t) => {
  const { root, head, snapshot } = await conflictingPull(t);
  await git(root, "merge", "--abort");
  await git(root, "switch", "-qc", "other");
  const otherHead = await commitText(root, "other branch work\n", "other commit");
  await git(root, "switch", "-qc", "side", head);
  await commitText(root, "unrelated merge\n", "side commit");
  await git(root, "switch", "-q", "other");
  await assert.rejects(() => git(root, "merge", "--no-edit", "side"));
  const before = await readFile(join(root, "tracked.txt"), "utf8");
  const service = new PullService(root);
  assert.equal(await service.findLatestPullRollbackSnapshot(), undefined);
  await assert.rejects(() => service.rollbackLatestPull(snapshot.id), /changed after confirmation/);
  assert.equal(await service.rollbackLatestPull(), undefined);
  assert.equal((await service.restoreSnapshotAfterResolvedPull()).status, "none");
  assert.equal((await service.dropSnapshotAfterResolvedRestore()).status, "none");
  assert.equal(await git(root, "rev-parse", "HEAD"), otherHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), before);
  assert.equal(await git(root, "diff", "--name-only", "--diff-filter=U"), "tracked.txt");
  assert.equal(await git(root, "rev-parse", "refs/stash"), snapshot.hash);
});

test("aborting and restarting the same merge on the same branch invalidates old pull recovery", async (t) => {
  const { root, beforeHead, snapshot } = await conflictingPull(t);
  await git(root, "merge", "--abort");
  await assert.rejects(() => git(root, "merge", "--no-edit", "incoming"));
  const before = await readFile(join(root, "tracked.txt"), "utf8");
  const service = new PullService(root);
  assert.equal(await service.findLatestPullRollbackSnapshot(), undefined);
  await assert.rejects(() => service.rollbackLatestPull(snapshot.id), /changed after confirmation/);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), before);
});

test("a linked worktree cannot use the main worktree recovery even on the same branch", async (t) => {
  const { root, directory, snapshot } = await conflictingPull(t);
  const linked = join(directory, "linked");
  await git(root, "worktree", "add", "--force", linked, "main");
  await assert.rejects(() => git(linked, "merge", "--no-edit", "incoming"));
  const service = new PullService(linked);
  assert.equal(await service.findLatestPullRollbackSnapshot(), undefined);
  await assert.rejects(() => service.rollbackLatestPull(snapshot.id), /changed after confirmation/);
  assert.equal((await new PullService(root).findLatestPullRollbackSnapshot())?.id, snapshot.id);
});

test("a changed approval or removed snapshot never falls back to another stash", async (t) => {
  const { root, directory, head, snapshot, service } = await conflictingPull(t);
  await assert.rejects(() => service.rollbackLatestPull("different-approved-id"), /changed after confirmation/);
  const unrelated = await addUnrelatedStash(root, directory, head);
  await git(root, "stash", "drop", "stash@{1}");
  const before = await readFile(join(root, "tracked.txt"), "utf8");
  await assert.rejects(() => service.rollbackLatestPull(snapshot.id), /changed after confirmation/);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), before);
  assert.equal(await git(root, "stash", "list", "--format=%H"), unrelated);
});

test("resolving the original pull merge restores saved local changes and removes only its snapshot", async (t) => {
  const { root } = await conflictingPull(t);
  await writeFile(join(root, "tracked.txt"), "local version\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--no-edit");
  const merged = await git(root, "rev-parse", "HEAD");
  const result = await new PullService(root).restoreSnapshotAfterResolvedPull();
  assert.equal(result.status, "restored");
  assert.equal(await git(root, "rev-parse", "HEAD"), merged);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "saved local changes\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("fast-forward pull with a stash-apply conflict can return to the pre-pull head", async (t) => {
  const { root, beforeHead, snapshot } = await conflictingPull(t, false);
  const service = new PullService(root);
  assert.equal((await service.findLatestPullRollbackSnapshot())?.id, snapshot.id);
  await service.rollbackLatestPull(snapshot.id);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "saved local changes\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("resolving a stash-apply conflict cleans up the bound snapshot without changing HEAD", async (t) => {
  const { root, incoming } = await conflictingPull(t, false);
  await writeFile(join(root, "tracked.txt"), "resolved local and remote\n");
  await git(root, "add", "tracked.txt");
  assert.equal((await new PullService(root).dropSnapshotAfterResolvedRestore()).status, "dropped");
  assert.equal(await git(root, "rev-parse", "HEAD"), incoming);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "resolved local and remote\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("a clean pull completes normally without creating recovery records", async (t) => {
  const { root, directory } = await safetyFixture(t, "clean-pull");
  await addOrigin(root, directory);
  assert.equal((await new PullService(root).pullCurrent()).status, "completed");
  assert.equal(await git(root, "stash", "list"), "");
});

test("a branch switch between rollback reset and stash apply preserves the saved stash", { skip: process.platform === "win32" }, async (t) => {
  const { root, directory, snapshot } = await conflictingPull(t);
  await git(root, "branch", "other");
  const bin = join(directory, "git-wrapper");
  await mkdir(bin);
  await writeFile(join(bin, "git"), [
    "#!/bin/sh",
    'PATH="$GSC_TEST_ORIGINAL_GIT_PATH"',
    "export PATH",
    'if [ "$1" = reset ] && [ "$2" = --hard ]; then',
    '  git "$@" || exit "$?"',
    "  git switch --quiet other",
    "else",
    '  exec git "$@"',
    "fi", "",
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousOriginal = process.env.GSC_TEST_ORIGINAL_GIT_PATH;
  try {
    process.env.GSC_TEST_ORIGINAL_GIT_PATH = previousPath;
    process.env.PATH = bin;
    await assert.rejects(() => new PullService(root).rollbackLatestPull(snapshot.id), /no longer matches/);
  } finally {
    process.env.PATH = previousPath;
    if (previousOriginal === undefined) delete process.env.GSC_TEST_ORIGINAL_GIT_PATH;
    else process.env.GSC_TEST_ORIGINAL_GIT_PATH = previousOriginal;
  }
  assert.equal(await git(root, "branch", "--show-current"), "other");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "local version\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), snapshot.hash);
});

test("pull preserves SSH authentication errors instead of reporting a missing branch", async (t) => {
  const { root, directory } = await safetyFixture(t, "pull-auth");
  const ssh = join(directory, "deny-ssh");
  await writeFile(ssh, "#!/bin/sh\nprintf 'Permission denied (publickey).\\n' >&2\nexit 255\n", { mode: 0o755 });
  await git(root, "remote", "add", "origin", "ssh://git@example.invalid/fixture.git");
  await git(root, "config", "core.sshCommand", ssh);
  await git(root, "config", "ssh.variant", "ssh");
  await git(root, "config", "branch.main.remote", "origin");
  await git(root, "config", "branch.main.merge", "refs/heads/main");
  await assert.rejects(() => new PullService(root).pullCurrent(), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.match(error.stderr, /Permission denied \(publickey\)/);
    assert.doesNotMatch(error.message, /was not found/);
    return true;
  });
});

test("an actually missing upstream still receives the missing-branch explanation", async (t) => {
  const { root, directory } = await safetyFixture(t, "missing-upstream");
  await addOrigin(root, directory, false);
  await git(root, "config", "branch.main.remote", "origin");
  await git(root, "config", "branch.main.merge", "refs/heads/missing");
  await assert.rejects(() => new PullService(root).pullCurrent(), /Configured upstream 'origin\/missing' was not found/);
});
