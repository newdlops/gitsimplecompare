import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { resetPullRequestResult } from "../src/git/pullRequestResultReset";
import { git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

for (const sparse of [false, true]) {
  test(`PR result preserves staged new content and separate unstaged edits ${sparse ? "outside sparse patterns" : "on a full checkout"}`, async (t) => {
    const { root, base, pr, service } = await prSafetyFixture(t);
    if (sparse) {
      await git(root, "sparse-checkout", "init", "--no-cone");
      await git(root, "sparse-checkout", "set", "--no-cone", "tracked.txt", "other.txt");
    }
    const file = "new[1]\t한글.txt";
    await writeFile(join(root, file), "original staged content\n");
    await git(root, "--literal-pathspecs", "add", "--sparse", "--", file);
    await writeFile(join(root, file), "later unstaged content\n");
    const result = await service.squashCherryPick(pr);
    assert.equal(result.status, "completed");
    assert.equal(await readFile(join(root, file), "utf8"), "later unstaged content\n");
    assert.equal(await git(root, "show", `:${file}`), "original staged content");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "PR content\n");
    await assert.rejects(service.undoLastOperation(), /staged changes would be reset/);
    assert.equal(await readFile(join(root, file), "utf8"), "later unstaged content\n");
    assert.equal(await git(root, "show", `:${file}`), "original staged content");
    await git(root, "--literal-pathspecs", "reset", "-q", "HEAD", "--", file);
    await service.undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(root, file), "utf8"), "later unstaged content\n");
  });
}

test("a blocked PR update leaves staged new files and the original index intact", async (t) => {
  const { root, base, pr, service } = await prSafetyFixture(t);
  await writeFile(join(root, "user.txt"), "user staged content\n");
  await git(root, "add", "user.txt");
  await writeFile(join(root, "tracked.txt"), "overlapping user edit\n");
  const index = await git(root, "ls-files", "--stage", "-z");
  await assert.rejects(service.squashCherryPick(pr), /preserved in a temporary worktree/);
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "overlapping user edit\n");
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "user staged content\n");
  const [worktree] = await listPrOperationWorktrees(root);
  assert.ok(worktree);
  t.after(() => rm(worktree.path, { recursive: true, force: true }));
});

test("PR additions cannot overwrite a staged new file even if it is ignored", async (t) => {
  const { root, base, pr, service } = await prSafetyFixture(t);
  await git(root, "switch", "source");
  await writeFile(join(root, "new.txt"), "PR addition\n");
  await git(root, "add", "new.txt");
  await git(root, "commit", "-qm", "add new file");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await writeFile(join(root, ".git/info/exclude"), "new.txt\n");
  await writeFile(join(root, "new.txt"), "user staged addition\n");
  await git(root, "add", "-f", "new.txt");
  const index = await git(root, "ls-files", "--stage", "-z");
  await assert.rejects(service.squashCherryPick({ ...pr, headHash: head, commitHashes: [...pr.commitHashes, head] }), /overlaps staged new files/);
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "user staged addition\n");
  const [worktree] = await listPrOperationWorktrees(root);
  assert.ok(worktree);
  t.after(() => rm(worktree.path, { recursive: true, force: true }));
});

test("intent-to-add files remain present after applying a PR result", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  await writeFile(join(root, "intent.txt"), "intent content\n");
  await git(root, "add", "-N", "intent.txt");
  await service.squashCherryPick(pr);
  assert.equal(await readFile(join(root, "intent.txt"), "utf8"), "intent content\n");
});

test("applying a PR result verifies the expected HEAD again after acquiring the real index lock", async t => {
  const { root, base, source } = await prSafetyFixture(t);
  await git(root, "commit", "--allow-empty", "-qm", "concurrent user commit");
  const changedHead = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "user.txt"), "preserve staged user addition\n");
  await git(root, "add", "user.txt");
  const index = await git(root, "ls-files", "--stage", "-z");
  await assert.rejects(resetPullRequestResult(root, source, { branch: "main", head: base }), /Ref safety check/);
  assert.equal(await git(root, "rev-parse", "HEAD"), changedHead);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "preserve staged user addition\n");
});
