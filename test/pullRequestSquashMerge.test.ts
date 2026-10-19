import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestSquashMerge } from "../src/git/pullRequestSquashMerge";
import { setGitExecutableResolver } from "../src/git/gitExec";
import { snapshotRefForBranch } from "../src/git/pullRequestOperationFormat";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

/**
 * 삭제된 파일을 PR이 다시 만지는 실제 modify/delete 사례를 만든다.
 * @param t 자체 저장소와 보존 worktree의 정리를 등록할 테스트 컨텍스트
 * @param additions true면 PR에 실제 새 내용이 있어 자동 해결하면 안 된다.
 * @returns 목적 브랜치·PR 범위와 검증용 OID
 */
async function deletedFileFixture(t: TestContext, additions = false) {
  const fixture = await safetyFixture(t, "pr-squash-deleted");
  const { root } = fixture;
  const file = "obsolete\t한글.test.ts";
  await writeFile(join(root, file), "first\nobsolete field\nlast\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "test fixture");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "feature.txt"), "wanted PR change\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "feature");
  const first = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, file), additions ? "first\nnew behavior\nlast\n" : "first\nlast\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "obsolete field removed");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await git(root, "rm", "--", file);
  await git(root, "commit", "-qm", "test no longer exists");
  const beforeHead = await git(root, "rev-parse", "HEAD");
  return {
    ...fixture, file, base, beforeHead,
    pr: { ...safetyPullRequest(head), commitHashes: [first, head], fileCount: 2 },
  };
}

for (const strategy of ["auto", "worktree"] as const) {
  test(`squash ${strategy} keeps an absent file absent when the PR only removes obsolete lines`, async (t) => {
    const { root, file, pr, beforeHead } = await deletedFileFixture(t);
    await writeFile(join(root, "user.txt"), "untracked user work\n");
    const service = new PullRequestOperationService(root);
    const result = await service.squashCherryPick(pr, { strategy });
    assert.equal(result.status, "completed");
    assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
    await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "wanted PR change\n");
    assert.equal(await readFile(join(root, "user.txt"), "utf8"), "untracked user work\n");
    assert.deepEqual(await listPrOperationWorktrees(root), []);
    await service.undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "user.txt"), "utf8"), "untracked user work\n");
  });
}

test("squash preserves a real modify/delete conflict and all original user changes", async (t) => {
  const { root, file, pr, beforeHead } = await deletedFileFixture(t, true);
  await writeFile(join(root, "tracked.txt"), "user staged\n");
  await git(root, "add", "tracked.txt");
  const index = await git(root, "ls-files", "--stage");
  await assert.rejects(new PullRequestOperationService(root).squashCherryPick(pr), /preserved temporary worktree/);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(root, "ls-files", "--stage"), index);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "user staged\n");
  const [worktree] = await listPrOperationWorktrees(root);
  assert.ok(worktree);
  t.after(() => rm(worktree.path, { recursive: true, force: true }));
  assert.ok((await git(worktree.path, "ls-files", "--unmerged", "-z")).includes(file));
  assert.equal(await readFile(join(worktree.path, file), "utf8"), "first\nnew behavior\nlast\n");
});

for (const unsupported of [false, true]) {
test(`squash ignores intermediate conflicts ${unsupported ? "with legacy Git fallback" : "using merge-tree"}`, async (t) => {
  const { root, directory } = await safetyFixture(t, "pr-squash-net-change");
  if (unsupported) {
    const wrapper = join(directory, "legacy-git");
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = "merge-tree" ]; then\n  echo "error: unknown option write-tree" >&2\n  exit 129\nfi\nexec git "$@"\n', { mode: 0o755 });
    t.after(setGitExecutableResolver(() => wrapper));
  }
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "tracked.txt"), "temporary PR edit\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "temporary change");
  const first = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "feature.txt"), "final PR change\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "final change");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await writeFile(join(root, "tracked.txt"), "destination change\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "destination");
  const beforeHead = await git(root, "rev-parse", "HEAD");
  const result = await new PullRequestOperationService(root).squashCherryPick({ ...safetyPullRequest(head), commitHashes: [first, head] });
  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "destination change\n");
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "final PR change\n");
  assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
});
}

test("squash leaves a mode change on a deleted file unresolved", async (t) => {
  const { root, pr, beforeHead } = await deletedFileFixture(t);
  await git(root, "switch", "source");
  await chmod(join(root, "obsolete\t한글.test.ts"), 0o755);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "change executable mode");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  const merge = new PullRequestSquashMerge(root);
  const plan = await merge.prepare([...pr.commitHashes, head]);
  assert.equal(await merge.computeTree(plan, beforeHead), undefined);
});

test("noncontiguous PR commits keep the original replay instead of including unlisted changes", async (t) => {
  const { root } = await safetyFixture(t, "pr-squash-noncontiguous");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  const commits: string[] = [];
  for (const name of ["first", "unlisted", "last"]) {
    await writeFile(join(root, `${name}.txt`), `${name}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", name);
    commits.push(await git(root, "rev-parse", "HEAD"));
  }
  await git(root, "switch", "main");
  const selected = [commits[0], commits[2]];
  assert.deepEqual(await new PullRequestSquashMerge(root).prepare(selected), { commits: selected });
  const result = await new PullRequestOperationService(root).squashCherryPick({ ...safetyPullRequest(commits[2]), commitHashes: selected });
  assert.equal(result.status, "completed");
  assert.equal(await git(root, "rev-list", "--count", `${base}..HEAD`), "1");
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first\n");
  assert.equal(await readFile(join(root, "last.txt"), "utf8"), "last\n");
  await assert.rejects(readFile(join(root, "unlisted.txt")), { code: "ENOENT" });
});

test("a net-empty PR does not commit the missing checkout files or the user's staged work", async (t) => {
  const { root } = await safetyFixture(t, "pr-squash-empty");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "temporary.txt"), "temporary\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "temporary");
  const first = await git(root, "rev-parse", "HEAD");
  await rm(join(root, "temporary.txt"));
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "undo temporary");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  const before = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "tracked.txt"), "user staged\n");
  await git(root, "add", ".");
  const index = await git(root, "ls-files", "--stage");
  await assert.rejects(new PullRequestOperationService(root).squashCherryPick({ ...safetyPullRequest(head), commitHashes: [first, head] }), /did not produce changes/);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await git(root, "ls-files", "--stage"), index);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "user staged\n");
  assert.deepEqual(await listPrOperationWorktrees(root), []);
});

test("squash revert uses the final inverse delta and preserves unrelated destination edits", async (t) => {
  const { root } = await safetyFixture(t, "pr-squash-revert-net");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "tracked.txt"), "temporary PR content\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "intermediate");
  const first = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "feature.txt"), "PR feature\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "final PR delta");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await git(root, "merge", "--ff-only", "source");
  await writeFile(join(root, "tracked.txt"), "destination change\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "destination");
  const before = await git(root, "rev-parse", "HEAD");
  const pr = { ...safetyPullRequest(head), commitHashes: [first, head] };
  const service = new PullRequestOperationService(root);
  const result = await service.squashRevertPullRequest(pr);
  assert.equal(result.status, "completed");
  assert.equal(await git(root, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "destination change\n");
  await assert.rejects(readFile(join(root, "feature.txt")), { code: "ENOENT" });
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "PR feature\n");
  assert.equal(await git(root, "merge-base", base, "HEAD"), base);
});

for (const movedBranch of [false, true]) {
  test(`a concurrent ${movedBranch ? "branch commit" : "overlapping edit"} keeps both user work and the prepared PR result`, async (t) => {
    const { root } = await safetyFixture(t, "pr-squash-concurrent");
    const before = await git(root, "rev-parse", "HEAD");
    await git(root, "switch", "-qc", "source");
    await writeFile(join(root, "tracked.txt"), "PR content\n");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "PR change");
    const head = await git(root, "rev-parse", "HEAD");
    await git(root, "switch", "main");
    const original = PullRequestSquashMerge.prototype.computeTree;
    let userHead = before;
    PullRequestSquashMerge.prototype.computeTree = async function(plan, start) {
      const tree = await original.call(this, plan, start);
      if (this.repoRoot === root) {
        await writeFile(join(root, "tracked.txt"), "concurrent user content\n");
        if (movedBranch) {
          await git(root, "add", ".");
          await git(root, "commit", "-qm", "concurrent user commit");
          userHead = await git(root, "rev-parse", "HEAD");
        }
      }
      return tree;
    };
    t.after(() => { PullRequestSquashMerge.prototype.computeTree = original; });
    const service = new PullRequestOperationService(root);
    await assert.rejects(service.squashCherryPick(safetyPullRequest(head)), /preserved in a temporary worktree/);
    assert.equal(await git(root, "rev-parse", "HEAD"), userHead);
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "concurrent user content\n");
    const [worktree] = await listPrOperationWorktrees(root);
    assert.ok(worktree);
    t.after(() => rm(worktree.path, { recursive: true, force: true }));
    assert.equal(await git(worktree.path, "show", "HEAD:tracked.txt"), "PR content");
    assert.equal(await git(root, "rev-parse", snapshotRefForBranch("main")), before);
    assert.equal(await service.hasUndoSnapshot(), false);
  });
}

test("commit hooks cannot replace the computed PR tree with a different result", async (t) => {
  const { root, directory } = await safetyFixture(t, "pr-squash-hook-tree");
  const before = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "feature.txt"), "PR feature\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "feature");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await writeFile(join(directory, "hooks/post-commit"), '#!/bin/sh\ngit read-tree --empty\ngit -c core.hooksPath=__gsc_fixture_no_hooks__ commit --amend --allow-empty --no-verify -m "hook altered result"\n', { mode: 0o755 });
  await assert.rejects(new PullRequestOperationService(root).squashCherryPick(safetyPullRequest(head)), /commit tree changed/);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "base\n");
  const [worktree] = await listPrOperationWorktrees(root);
  assert.ok(worktree);
  t.after(() => rm(worktree.path, { recursive: true, force: true }));
});

test("binary edits to a deleted file require manual conflict resolution", async (t) => {
  const { root, pr, file, beforeHead } = await deletedFileFixture(t);
  await git(root, "switch", "source");
  await writeFile(join(root, file), Buffer.from([0, 1, 2, 3]));
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "binary change");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  const merge = new PullRequestSquashMerge(root);
  assert.equal(await merge.computeTree(await merge.prepare([...pr.commitHashes, head]), beforeHead), undefined);
});

test("a destination rename receives the PR deletion edit at its new path", async (t) => {
  const { root, pr, file, base } = await deletedFileFixture(t);
  await git(root, "switch", "-qc", "renamed", base);
  await git(root, "mv", "--", file, "renamed.test.ts");
  await git(root, "commit", "-qm", "rename destination test");
  const result = await new PullRequestOperationService(root).squashCherryPick(pr);
  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(root, "renamed.test.ts"), "utf8"), "first\nlast\n");
  await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
});
