import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createReplayWorktree, materializeReplayWorktree } from "../src/git/replayWorktree";
import { canUseCompactReplayWorktree } from "../src/git/replayWorktreePolicy";
import { removeTemporaryWorktree } from "../src/git/temporaryWorktree";
import { runDeferredCommitRebase } from "../src/git/deferredCommitRebase";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestWorktreeRecoveryError, PullRequestWorktreeRecoveryService } from "../src/git/pullRequestWorktreeRecovery";
import { ConflictService } from "../src/git/conflictService";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { readPullRequestWorktreeRecovery } from "../src/git/pullRequestWorktreeRecoveryState";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { replayWorktreeFixture } from "./helpers/replayWorktreeFixture";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("compact Native PR replay preserves exact trees, author/message and the original worktree", async t => {
  const f = await replayWorktreeFixture(t), before = await f.originalState();
  const worktree = await createReplayWorktree(f.root, f.beforeHead, [f.source]);
  f.ownWorktree(worktree.path); assert.equal(worktree.compact, true);
  await assert.rejects(readFile(join(worktree.path, f.paths[0])), { code: "ENOENT" });
  const result = await runDeferredCommitRebase({ kind: "pr-rebase", label: "PR test", repoRoot: worktree.path,
    commits: [f.source], destinationBranch: "main", beforeHead: f.beforeHead, snapshotRef: f.beforeHead });
  assert.equal(result.status, "completed");
  assert.equal(await git(worktree.path, "rev-parse", "HEAD^{tree}"), f.tree);
  assert.equal(await git(worktree.path, "log", "-1", "--format=%an%n%ae%n%aI%n%B"),
    await git(f.root, "log", "-1", "--format=%an%n%ae%n%aI%n%B", f.source));
  await assert.rejects(readFile(join(worktree.path, f.paths[0])), { code: "ENOENT" });
  assert.deepEqual(await f.originalState(), before);
});

test("compact Native revert preserves the exact inverse tree without materializing unchanged files", async t => {
  const f = await replayWorktreeFixture(t), before = await f.originalState();
  const worktree = await createReplayWorktree(f.root, f.source, [f.source]);
  f.ownWorktree(worktree.path); assert.equal(worktree.compact, true);
  const result = await runDeferredCommitRebase({ kind: "pr-revert", operation: "revert", label: "PR revert test",
    repoRoot: worktree.path, commits: [f.source], destinationBranch: "main", beforeHead: f.source, snapshotRef: f.source });
  assert.equal(result.status, "completed");
  assert.equal(await git(worktree.path, "rev-parse", "HEAD^{tree}"), await git(f.root, "rev-parse", `${f.base}^{tree}`));
  assert.equal(await git(worktree.path, "log", "-1", "--format=%P"), f.source);
  assert.match(await git(worktree.path, "log", "-1", "--format=%B"), new RegExp(`This reverts commit ${f.source}`));
  await assert.rejects(readFile(join(worktree.path, f.paths[0])), { code: "ENOENT" });
  assert.deepEqual(await f.originalState(), before);
});

test("materialization preserves manual S-path edits and ordinary user deletions", async t => {
  const f = await replayWorktreeFixture(t), before = await f.originalState();
  const worktree = await createReplayWorktree(f.root, f.beforeHead, [f.source]);
  f.ownWorktree(worktree.path); assert.equal(worktree.compact, true);
  await mkdir(join(worktree.path, "padding")); await writeFile(join(worktree.path, f.paths[0]), "manual edit\n");
  // 이 경로는 이미 펼친 후 사용자가 지웠다. 나머지 S-tag 복원이 이를 되살리면 안 된다.
  await materializeReplayWorktree(worktree.path);
  await rm(join(worktree.path, f.paths[1]));
  await materializeReplayWorktree(worktree.path);
  assert.equal(await readFile(join(worktree.path, f.paths[0]), "utf8"), "manual edit\n");
  await assert.rejects(readFile(join(worktree.path, f.paths[1])), { code: "ENOENT" });
  assert.equal(await readFile(join(worktree.path, f.paths[2]), "utf8"), "unchanged padding\n");
  assert.deepEqual(await f.originalState(), before);
});

test("a Native materialization failure retains skip flags and can be retried without overwriting a local path", async t => {
  const f = await replayWorktreeFixture(t), worktree = await createReplayWorktree(f.root, f.beforeHead, [f.source]);
  f.ownWorktree(worktree.path);
  await mkdir(join(worktree.path, f.paths[0]), { recursive: true });
  await assert.rejects(materializeReplayWorktree(worktree.path), /blocks PR worktree/);
  assert.ok((await git(worktree.path, "ls-files", "-t", "--", f.paths[0])).startsWith("S "));
  await rm(join(worktree.path, f.paths[0]), { recursive: true });
  await materializeReplayWorktree(worktree.path);
  assert.equal(await readFile(join(worktree.path, f.paths[0]), "utf8"), "unchanged padding\n");
});

test("the PR service applies a compact replay and keeps staged, unstaged and untracked user work", async t => {
  const f = await replayWorktreeFixture(t);
  const result = await new PullRequestOperationService(f.root).rebasePullRequest(f.pr, { strategy: "worktree" });
  assert.equal(result.status, "completed"); assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), f.tree);
  assert.equal(await git(f.root, "show", ":user.txt"), "staged user work");
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "unstaged user work\n");
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "untracked user work\n");
});

test("compact PR conflicts expose complete files and resume through a fresh recovery service", async t => {
  const f = await replayWorktreeFixture(t, true), before = await f.originalState();
  let caught: unknown;
  try { await new PullRequestOperationService(f.root).rebasePullRequest(f.pr, { strategy: "worktree" }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof PullRequestWorktreeRecoveryError, String(caught));
  const record = caught.recovery;
  t.after(() => rm(record.worktreePath, { recursive: true, force: true }));
  assert.equal(record.phase, "conflicts"); assert.equal(record.compactReplay, undefined);
  assert.equal(await readFile(join(record.worktreePath, f.paths[0]), "utf8"), "unchanged padding\n");
  assert.deepEqual(await f.originalState(), before);
  await new ConflictService(record.worktreePath).acceptIncoming("tracked.txt");
  assert.equal((await new PullRequestWorktreeRecoveryService(f.root).continue(record.id)).status, "completed");
  assert.equal(await git(f.root, "show", ":user.txt"), "staged user work");
});

test("small repositories retain the original full checkout without compact metadata reads", async t => {
  const f = await safetyFixture(t, "small-replay-worktree"), worktree = await createReplayWorktree(f.root, f.head, [f.head]);
  try {
    assert.equal(worktree.compact, false); assert.equal(await readFile(join(worktree.path, "tracked.txt"), "utf8"), "base\n");
  } finally { await removeTemporaryWorktree(f.root, worktree.path); }
});

test("tracked hooks, external filters and external merge drivers retain the full-checkout path", async t => {
  const f = await replayWorktreeFixture(t);
  for (const key of ["filter.fixture.clean", "merge.fixture.driver"]) {
    await git(f.root, "config", key, "true");
    assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [f.source]), false);
    await git(f.root, "config", "--unset", key);
  }
  await mkdir(join(f.root, ".hooks")); await writeFile(join(f.root, ".hooks/post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(f.root, "add", ".hooks"); await git(f.root, "commit", "-qm", "tracked hooks");
  await git(f.root, "config", "core.hooksPath", ".hooks");
  assert.equal(await canUseCompactReplayWorktree(f.root, await git(f.root, "rev-parse", "HEAD"), [f.source]), false);
});

test("a failed compact materialization persists its recovery obligation and preserves later local edits", async t => {
  const f = await replayWorktreeFixture(t), before = await f.originalState();
  const failing = t.mock.method(PullRequestOperationSnapshot.prototype, "createSnapshot", async () => {
    const [worktree] = await listPrOperationWorktrees(f.root); assert.ok(worktree);
    await mkdir(join(worktree.path, f.paths[0]), { recursive: true });
    throw new Error("Controlled destination failure after replay");
  });
  let caught: unknown;
  try { await new PullRequestOperationService(f.root).rebasePullRequest(f.pr, { strategy: "worktree" }); }
  catch (error) { caught = error; }
  finally { failing.mock.restore(); }
  assert.ok(caught instanceof PullRequestWorktreeRecoveryError, String(caught));
  const record = caught.recovery;
  t.after(() => rm(record.worktreePath, { recursive: true, force: true }));
  assert.equal(record.phase, "ready"); assert.equal(record.compactReplay, true); assert.equal(record.version, 2);
  assert.equal((await readPullRequestWorktreeRecovery(f.root, record.id)).compactReplay, true);
  assert.deepEqual(await f.originalState(), before);
  await assert.rejects(new PullRequestWorktreeRecoveryService(f.root).continue(record.id), /blocks PR worktree/);
  await rm(join(record.worktreePath, f.paths[0]), { recursive: true });
  await writeFile(join(record.worktreePath, f.paths[1]), "manual work in the preserved result\n");
  assert.equal((await new PullRequestWorktreeRecoveryService(f.root).continue(record.id)).status, "completed");
  assert.equal(await readFile(join(record.worktreePath, f.paths[1]), "utf8"), "manual work in the preserved result\n");
  assert.equal(await git(f.root, "show", ":user.txt"), "staged user work");
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "unstaged user work\n");
});

test("conditional hook configuration is revalidated for the new detached worktree", async t => {
  const f = await replayWorktreeFixture(t), shared = join(f.directory, "shared-hooks"), marker = join(f.directory, "hook-ran");
  await mkdir(shared);
  await writeFile(join(shared, "prepare-commit-msg"), `#!/bin/sh\ntest -f padding/keep-0000.txt || exit 1\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  await git(f.root, "config", "--local", "core.hooksPath", shared);
  const include = join(f.directory, "main-only.config");
  await writeFile(include, `[core]\n hooksPath = ${join(f.directory, "hooks")}\n`);
  await git(f.root, "config", "--add", "includeIf.onbranch:main.path", include);
  assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [f.source]), true,
    "the source on main legitimately has an empty conditional hook override");
  const worktree = await createReplayWorktree(f.root, f.beforeHead, [f.source]);
  f.ownWorktree(worktree.path);
  assert.equal(worktree.compact, false, "the new worktree must validate its own effective shared hooks");
  assert.equal(await git(worktree.path, "config", "--get", "core.hooksPath"), shared);
  const before = await f.originalState();
  const result = await runDeferredCommitRebase({ kind: "pr-rebase", label: "conditional hook test", repoRoot: worktree.path,
    commits: [f.source], destinationBranch: "main", beforeHead: f.beforeHead, snapshotRef: f.beforeHead });
  assert.equal(result.status, "completed");
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.deepEqual(await f.originalState(), before);
});

test("an attributes file named false still requires the full Native checkout", async t => {
  const f = await replayWorktreeFixture(t);
  await git(f.root, "config", "core.attributesFile", "false");
  assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [f.source]), false);
});

test("a source commit that introduces the relative hook directory prevents compact replay", async t => {
  const f = await replayWorktreeFixture(t);
  await mkdir(join(f.root, ".new-hooks"));
  await writeFile(join(f.root, ".new-hooks/post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(f.root, "add", ".new-hooks"); await git(f.root, "commit", "-qm", "new hooks");
  const hookCommit = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "config", "core.hooksPath", ".new-hooks");
  assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [hookCommit]), false);
});

test("a submodule index falls back through Native worktree creation without resetting the source", async t => {
  const f = await replayWorktreeFixture(t);
  await git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.base},module`);
  await git(f.root, "commit", "-qm", "submodule entry");
  const beforeHead = await git(f.root, "rev-parse", "HEAD"), before = await f.originalState(), commands: string[] = [];
  const stop = setGitExecutionObserver(row => commands.push(row.command));
  let worktree: Awaited<ReturnType<typeof createReplayWorktree>>;
  try { worktree = await createReplayWorktree(f.root, beforeHead, [f.source]); }
  finally { stop(); }
  f.ownWorktree(worktree.path);
  assert.equal(worktree.compact, false);
  assert.equal(commands.includes("reset"), false);
  assert.ok((await git(worktree.path, "ls-files", "--stage", "--", "module")).startsWith("160000 "));
  assert.deepEqual(await f.originalState(), before);
});
