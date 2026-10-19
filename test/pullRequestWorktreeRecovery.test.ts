import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestWorktreeRecoveryError, PullRequestWorktreeRecoveryService } from "../src/git/pullRequestWorktreeRecovery";
import { listPullRequestWorktreeRecoveries, readPullRequestWorktreeRecovery } from "../src/git/pullRequestWorktreeRecoveryState";
import { cleanupPrOperationWorktrees, listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

/** 독립된 PR 충돌을 만들고 커밋 외 사용자 staged/unstaged 변경을 동시에 남긴다. */
async function fixture(t: TestContext, kind: "content" | "delete" = "content") {
  const setup = await safetyFixture(t, "pr-worktree-recovery");
  const { root } = setup;
  const file = "충돌\tfile.txt";
  await writeFile(join(root, file), "base\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "conflict base");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, file), "new PR behavior\n");
  await writeFile(join(root, "feature.txt"), "wanted feature\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "PR feature");
  const source = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  if (kind === "delete") await git(root, "rm", "--", file);
  else { await writeFile(join(root, file), "destination behavior\n"); await git(root, "add", "."); }
  await git(root, "commit", "-qm", "destination change");
  const beforeHead = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "user-staged.txt"), "staged user work\n");
  await git(root, "add", "user-staged.txt");
  await writeFile(join(root, "user-staged.txt"), "unstaged user work\n");
  await writeFile(join(root, "untracked.txt"), "untracked user work\n");
  return { ...setup, file, beforeHead, pr: safetyPullRequest(source), index: await git(root, "ls-files", "--stage") };
}

/** 실패 결과에서 구조화된 복구 ID를 얻고 테스트가 소유한 임시 디렉터리만 정리한다. */
async function paused(t: TestContext, run: () => Promise<unknown>) {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof PullRequestWorktreeRecoveryError, String(caught));
  const record = caught.recovery;
  t.after(() => rm(record.worktreePath, { recursive: true, force: true }));
  assert.equal(record.phase, "conflicts");
  return record;
}

for (const kind of ["content", "delete"] as const) {
  for (const side of ["current", "incoming"] as const) {
    test(`squash resumes ${kind} conflict with explicit ${side} resolution and keeps original local work`, async t => {
      const { root, file, beforeHead, pr, index } = await fixture(t, kind);
      const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
      assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
      assert.equal(await git(root, "ls-files", "--stage"), index);
      assert.equal((await listPullRequestWorktreeRecoveries(root))[0].id, record.id);
      assert.ok((await listPrOperationWorktrees(root))[0].locked);
      await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id), /Resolve and stage/);
      const service = new ConflictService(record.worktreePath);
      if (side === "current") await service.acceptCurrent(file);
      else await service.acceptIncoming(file);
      // 새 서비스가 디스크에서 읽도록 해 시작 시점 메모리 상태 없이도 이어가는지 확인한다.
      const result = await new PullRequestWorktreeRecoveryService(root).continue(record.id);
      assert.equal(result.status, "completed");
      assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
      assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "wanted feature\n");
      if (kind === "delete" && side === "current") await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
      else assert.equal(await readFile(join(root, file), "utf8"), side === "incoming" ? "new PR behavior\n" : "destination behavior\n");
      assert.equal(await readFile(join(root, "user-staged.txt"), "utf8"), "unstaged user work\n");
      assert.equal(await git(root, "show", ":user-staged.txt"), "staged user work");
      assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked user work\n");
      assert.deepEqual(await listPullRequestWorktreeRecoveries(root), []);
      assert.deepEqual(await listPrOperationWorktrees(root), []);
      assert.equal(await git(root, "for-each-ref", "--format=%(refname)", `refs/gitsimplecompare/pr-recovery-sources/${record.id}`), "");
      await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id));
      await git(root, "restore", "--staged", "--", "user-staged.txt");
      await new PullRequestOperationService(root).undoLastOperation();
      assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
      assert.equal(await readFile(join(root, "user-staged.txt"), "utf8"), "unstaged user work\n");
    });
  }
}

test("unresolved recovery is protected from temporary worktree cleanup", async t => {
  const { root, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  const cleanup = await cleanupPrOperationWorktrees(root);
  assert.deepEqual(cleanup.removed, []);
  assert.equal(cleanup.failed[0].path, record.worktreePath);
  assert.equal((await new ConflictService(record.worktreePath).listConflicts()).length, 1);
});

test("resolved PR is prepared once and retained when the destination HEAD changes", async t => {
  const { root, pr, file, beforeHead } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  await new ConflictService(record.worktreePath).acceptIncoming(file);
  await git(root, "restore", "--staged", "--", "user-staged.txt");
  await writeFile(join(root, "concurrent.txt"), "concurrent user commit\n");
  await git(root, "add", "concurrent.txt");
  await git(root, "commit", "-qm", "concurrent user commit");
  const changedHead = await git(root, "rev-parse", "HEAD");
  await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id), /Ref safety check/);
  assert.equal(await git(root, "rev-parse", "HEAD"), changedHead);
  const ready = await readPullRequestWorktreeRecovery(root, record.id);
  assert.equal(ready.phase, "ready");
  assert.equal(await git(record.worktreePath, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
  // 테스트 소유 브랜치를 시작점으로 돌린 뒤, 이미 만든 결과만 적용하는 재시도를 확인한다.
  await git(root, "reset", "--keep", beforeHead);
  const result = await new PullRequestWorktreeRecoveryService(root).continue(record.id);
  assert.equal(result.afterHead, ready.afterHead);
  assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
});

test("unstaged resolution edits are left untouched and can be staged before retry", async t => {
  const { root, file, pr, beforeHead } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  await new ConflictService(record.worktreePath).acceptIncoming(file);
  await writeFile(join(record.worktreePath, file), "manual final result\n");
  await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id), /Save and stage/);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  await git(record.worktreePath, "add", "--", file);
  await new PullRequestWorktreeRecoveryService(root).continue(record.id);
  assert.equal(await readFile(join(root, file), "utf8"), "manual final result\n");
});

test("ignored user files in a resolved worktree are preserved after applying the PR", async t => {
  const { root, file, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  await new ConflictService(record.worktreePath).acceptIncoming(file);
  await writeFile(join(record.worktreePath, ".gitignore"), "private-note\n");
  await writeFile(join(record.worktreePath, "private-note"), "do not discard\n");
  // .gitignore 자체도 사용자가 만든 미추적 파일로 남긴다.
  assert.equal((await new PullRequestWorktreeRecoveryService(root).continue(record.id)).status, "completed");
  assert.equal(await readFile(join(record.worktreePath, "private-note"), "utf8"), "do not discard\n");
  assert.equal(await readFile(join(record.worktreePath, ".gitignore"), "utf8"), "private-note\n");
});

test("a new Git operation with the same commits cannot adopt an old recovery", async t => {
  const { root, file, pr, beforeHead, index } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  await git(record.worktreePath, "cherry-pick", "--quit");
  await git(record.worktreePath, "reset", "--hard", beforeHead);
  await assert.rejects(git(record.worktreePath, "cherry-pick", "--no-commit", pr.headHash));
  await new ConflictService(record.worktreePath).acceptIncoming(file);
  await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id), /operation changed/);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(root, "ls-files", "--stage"), index);
});

for (const command of ["squash", "squashRevert", "rebase", "rebaseRevert"] as const) {
  test(`${command} resumes two separate conflicts and keeps the complete remaining queue`, async t => {
    const { root } = await safetyFixture(t, `pr-recovery-${command}`);
    for (const file of ["one", "two"]) await writeFile(join(root, file), "base\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "base files");
    await git(root, "switch", "-qc", "source");
    const commits: string[] = [];
    for (const file of ["one", "unlisted", "two"]) {
      await writeFile(join(root, file), "PR change\n");
      await git(root, "add", "."); await git(root, "commit", "-qm", `PR ${file}`);
      commits.push(await git(root, "rev-parse", "HEAD"));
    }
    await git(root, "switch", "main");
    if (command.endsWith("Revert")) await git(root, "merge", "--ff-only", "source");
    for (const file of ["one", "two"]) await writeFile(join(root, file), "destination change\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "destination");
    const beforeHead = await git(root, "rev-parse", "HEAD");
    const pr = { ...safetyPullRequest(commits[2]), commitHashes: [commits[0], commits[2]] };
    const service = new PullRequestOperationService(root);
    const run = command === "squash" ? () => service.squashCherryPick(pr)
      : command === "squashRevert" ? () => service.squashRevertPullRequest(pr, { strategy: "worktree" })
      : command === "rebase" ? () => service.rebasePullRequest(pr, { strategy: "worktree" })
      : () => service.rebaseRevertPullRequest(pr, { strategy: "worktree" });
    const record = await paused(t, run);
    const conflict = new ConflictService(record.worktreePath);
    let files = await conflict.listConflicts();
    assert.equal(files.length, 1);
    await conflict.acceptIncoming(files[0]);
    assert.equal((await new PullRequestWorktreeRecoveryService(root).continue(record.id)).status, "conflicts");
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    files = await conflict.listConflicts();
    assert.equal(files.length, 1);
    await conflict.acceptIncoming(files[0]);
    const result = await new PullRequestWorktreeRecoveryService(root).continue(record.id);
    assert.equal(result.status, "completed");
    assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), command.startsWith("squash") ? "1" : "2");
    for (const file of ["one", "two"]) assert.equal(await readFile(join(root, file), "utf8"), command.endsWith("Revert") ? "base\n" : "PR change\n");
    if (!command.endsWith("Revert")) await assert.rejects(readFile(join(root, "unlisted")), { code: "ENOENT" });
    assert.deepEqual(await listPullRequestWorktreeRecoveries(root), []);
  });
}

test("empty rebase resolution skips only the owned conflict and completes the remaining queue", async t => {
  const { root, file, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).rebasePullRequest(pr, { strategy: "worktree" }));
  await new ConflictService(record.worktreePath).acceptCurrent(file);
  const result = await new PullRequestWorktreeRecoveryService(root).continue(record.id);
  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "wanted feature\n");
  assert.equal(await readFile(join(root, file), "utf8"), "destination behavior\n");
});

test("repeated PR actions reuse the preserved worktree instead of replaying the same conflict", async t => {
  const { root, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  const again = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  assert.equal(again.id, record.id);
  assert.equal((await listPrOperationWorktrees(root)).length, 1);
});

test("a rejected squash commit can be retried without losing the staged resolution", async t => {
  const { root, directory, file, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).squashCherryPick(pr));
  await new ConflictService(record.worktreePath).acceptIncoming(file);
  const hook = join(directory, "hooks/prepare-commit-msg");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(new PullRequestWorktreeRecoveryService(root).continue(record.id), /git commit failed/);
  assert.equal((await readPullRequestWorktreeRecovery(root, record.id)).phase, "conflicts");
  assert.equal(await readFile(join(record.worktreePath, file), "utf8"), "new PR behavior\n");
  await rm(hook);
  assert.equal((await new PullRequestWorktreeRecoveryService(root).continue(record.id)).status, "completed");
});

test("a fully empty rebase resolution skips the owned commit and preserves the original branch", async t => {
  const { root, file, beforeHead, pr } = await fixture(t);
  const record = await paused(t, () => new PullRequestOperationService(root).rebasePullRequest(pr, { strategy: "worktree" }));
  await new ConflictService(record.worktreePath).acceptCurrent(file);
  await git(record.worktreePath, "rm", "-f", "feature.txt");
  assert.equal((await new PullRequestWorktreeRecoveryService(root).continue(record.id)).status, "completed");
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "user-staged.txt"), "utf8"), "unstaged user work\n");
});
