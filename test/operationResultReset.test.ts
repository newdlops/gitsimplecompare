import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resetOperationResult } from "../src/git/operationResultReset";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 두 tracked 경로와 서로 겹치지 않는 격리 결과를 만들어 stage 보존을 Native와 대조한다. */
async function fixture(t: TestContext) {
  const f = await safetyFixture(t, "operation-result-index");
  await writeFile(join(f.root, "remove.txt"), "removed by user\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "base files");
  const before = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-qc", "result");
  await writeFile(join(f.root, "incoming.txt"), "incoming\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "result");
  const target = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "main");
  return { ...f, before, target };
}

test("applying a branch result preserves unrelated staged modification and deletion separately from working edits", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "tracked.txt"), "staged content\n"); await git(f.root, "add", "tracked.txt");
  await writeFile(join(f.root, "tracked.txt"), "unstaged content\n"); await git(f.root, "rm", "remove.txt");
  const staged = await git(f.root, "diff", "--cached", "--raw", "--no-abbrev", "-z");
  await resetOperationResult(f.root, f.target, { branch: "main", head: f.before }, "branch squash");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.target);
  assert.equal(await git(f.root, "diff", "--cached", "--raw", "--no-abbrev", "-z"), staged);
  assert.equal(await git(f.root, "show", ":tracked.txt"), "staged content");
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "unstaged content\n");
  await assert.rejects(access(join(f.root, "remove.txt")), { code: "ENOENT" });
});

test("a staged mode change survives applying an unrelated result", async t => {
  const f = await fixture(t);
  await git(f.root, "update-index", "--chmod=+x", "tracked.txt");
  const entry = await git(f.root, "ls-files", "--stage", "--", "tracked.txt");
  await resetOperationResult(f.root, f.target, { branch: "main", head: f.before }, "branch squash");
  assert.equal(await git(f.root, "ls-files", "--stage", "--", "tracked.txt"), entry);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "base\n");
});

test("a result overlapping staged edits stops before changing HEAD, index or worktree", async t => {
  const f = await fixture(t);
  await git(f.root, "switch", "result");
  await writeFile(join(f.root, "tracked.txt"), "incoming overlapping change\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "overlap");
  const target = await git(f.root, "rev-parse", "HEAD"); await git(f.root, "switch", "main");
  await writeFile(join(f.root, "tracked.txt"), "staged local edit\n"); await git(f.root, "add", "tracked.txt");
  const index = await readFile(join(f.root, ".git/index"));
  await assert.rejects(resetOperationResult(f.root, target, { branch: "main", head: f.before }, "branch squash"));
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "staged local edit\n");
});

test("a staged rename with literal special paths keeps its staged blob and later working edit", async t => {
  const f = await fixture(t), renamed = "new[1]\t한글\nfile.txt";
  await git(f.root, "mv", "tracked.txt", renamed);
  await writeFile(join(f.root, renamed), "later working edit\n");
  const staged = await git(f.root, "diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z");
  await resetOperationResult(f.root, f.target, { branch: "main", head: f.before }, "branch squash");
  assert.equal(await git(f.root, "diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"), staged);
  assert.equal(await git(f.root, "show", `:${renamed}`), "base");
  assert.equal(await readFile(join(f.root, renamed), "utf8"), "later working edit\n");
  await assert.rejects(access(join(f.root, "tracked.txt")), { code: "ENOENT" });
});

for (const stagedParent of [false, true]) {
  test(`a result refuses a staged ${stagedParent ? "parent" : "child"} path without confusing adjacent names`, async t => {
    const f = await fixture(t), staged = stagedParent ? "area" : "area/child.txt", incoming = stagedParent ? "area/child.txt" : "area";
    await git(f.root, "switch", "result");
    if (stagedParent) await mkdir(join(f.root, "area"));
    await writeFile(join(f.root, incoming), "incoming\n");
    await writeFile(join(f.root, "area-other"), "adjacent name\n");
    await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "file directory overlap");
    const target = await git(f.root, "rev-parse", "HEAD"); await git(f.root, "switch", "main");
    if (!stagedParent) await mkdir(join(f.root, "area"));
    await writeFile(join(f.root, staged), "staged user work\n"); await git(f.root, "add", "area");
    const index = await readFile(join(f.root, ".git/index"));
    await assert.rejects(resetOperationResult(f.root, target, { branch: "main", head: f.before }), /overlaps staged new files/);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
    assert.equal(await readFile(join(f.root, staged), "utf8"), "staged user work\n");
  });
}
