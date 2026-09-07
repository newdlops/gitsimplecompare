import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { recoverFailedRebaseStart } from "../src/git/rebaseFailureRecovery";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 pre-rebase hook에서 실패시킬 서로 갈라진 두 브랜치를 준비한다. */
async function fixture(t: TestContext) {
  const base = await safetyFixture(t, "rebase-failure");
  await writeFile(join(base.root, "other.txt"), "other base\n");
  await git(base.root, "add", ".");
  await git(base.root, "commit", "-qm", "other base");
  await git(base.root, "switch", "-qc", "target");
  await commitText(base.root, "target\n", "target");
  await git(base.root, "switch", "main");
  const beforeHead = await commitText(base.root, "local\n", "local");
  return { ...base, beforeHead, service: new BranchOperationService(base.root) };
}

/** 훅 내부의 별도 프로세스가 변경한 상태를 Git 명령 실패 후에도 보존하는지 검사한다. */
async function rejectHook(directory: string, commands = "") {
  await writeFile(join(directory, "hooks/pre-rebase"),
    `#!/bin/sh\n${commands}\nprintf 'rejected by pre-rebase hook\\n' >&2\nexit 1\n`, { mode: 0o755 });
}

for (const staged of [false, true]) {
  test(`failed rebase preserves new ${staged ? "staged" : "unstaged"} edits and its recovery snapshot`, async (t) => {
    const { root, directory, beforeHead, service } = await fixture(t);
    await rejectHook(directory, "printf 'new external edit\\n' > other.txt\nprintf 'untracked edit\\n' > new.txt\n" +
      (staged ? "git add other.txt\n" : ""));
    await assert.rejects(() => service.rebaseMerge("target"), /rejected by pre-rebase hook[\s\S]*recovery snapshot was kept/);
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new external edit\n");
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "untracked edit\n");
    assert.equal(await git(root, "show", ":other.txt"), staged ? "new external edit" : "other base");
    assert.equal(await git(root, "for-each-ref", "--format=%(objectname)", "refs/gitsimplecompare/branch-operation-snapshots"), beforeHead);
    assert.equal(await service.hasUndoSnapshot(), false);
  });
}

test("failed rebase keeps the original stash separate from new edits", async (t) => {
  const { root, directory, service } = await fixture(t);
  await writeFile(join(root, "other.txt"), "original saved edit\n");
  await rejectHook(directory, "printf 'new external edit\\n' > other.txt");
  await assert.rejects(() => service.rebaseMerge("target"), /preserved in stash/);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new external edit\n");
  assert.equal(await git(root, "show", "stash:other.txt"), "original saved edit");
});

test("clean failed rebase restores original staged and untracked work without reset", async (t) => {
  const { root, directory, beforeHead, service } = await fixture(t);
  await writeFile(join(root, "other.txt"), "original staged work\n");
  await git(root, "add", "other.txt");
  await writeFile(join(root, "other.txt"), "original staged work\nadditional unstaged work\n");
  await writeFile(join(root, "saved.txt"), "original untracked work\n");
  await rejectHook(directory);
  await assert.rejects(() => service.rebaseMerge("target"), /rejected by pre-rebase hook/);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(root, "show", ":other.txt"), "original staged work");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "original staged work\nadditional unstaged work\n");
  assert.equal(await readFile(join(root, "saved.txt"), "utf8"), "original untracked work\n");
  assert.equal(await git(root, "stash", "list"), "");
  assert.equal(await git(root, "for-each-ref", "refs/gitsimplecompare/branch-operation-snapshots"), "");
});

test("failed rebase does not switch back after an external branch change", async (t) => {
  const { root, directory, beforeHead, service } = await fixture(t);
  await git(root, "branch", "other");
  await rejectHook(directory, "git switch -q other\nprintf 'edit on other branch\\n' > other.txt");
  await assert.rejects(() => service.rebaseMerge("target"), /rejected by pre-rebase hook/);
  assert.equal(await git(root, "branch", "--show-current"), "other");
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "edit on other branch\n");
});

test("failed rebase keeps later commits and reports the original error", async (t) => {
  const { root, directory, beforeHead, service } = await fixture(t);
  await rejectHook(directory, "printf 'later edit\\n' > other.txt\ngit add other.txt\ngit commit -qm 'external commit'");
  await assert.rejects(() => service.rebaseMerge("target"), /rejected by pre-rebase hook[\s\S]*Ref safety check failed/);
  assert.notEqual(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(root, "show", "HEAD:other.txt"), "later edit");
});

test("stash restoration failure returns recovery details without hiding the original Git failure", async (t) => {
  const { root, beforeHead } = await fixture(t);
  const snapshotRef = "refs/gitsimplecompare/recovery-test";
  await git(root, "update-ref", snapshotRef, beforeHead);
  const result = await recoverFailedRebaseStart({ repoRoot: root, branch: "main", beforeHead, snapshotRef, preservedStashHash: "missing-stash-object" });
  assert.equal(result.restored, false);
  assert.match(result.notice, /missing-stash-object/);
  assert.match(result.notice, /recovery snapshot was kept/);
  assert.equal(await git(root, "status", "--porcelain"), "");
  assert.equal(await git(root, "rev-parse", snapshotRef), beforeHead);
});
