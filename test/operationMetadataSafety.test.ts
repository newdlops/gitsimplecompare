import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { readGitCheckoutIdentity, readGitDirectory } from "../src/git/repositoryIdentity";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("a same-call Undo directory cannot be adopted by another Git directory at the same branch and commit", async t => {
  const { root, directory, head } = await safetyFixture(t, "operation-directory-safety");
  await git(root, "init", "-q", "--separate-git-dir", join(directory, "original metadata"));
  const originalGitDir = await readGitDirectory(root), replacement = join(directory, "replacement");
  await git(root, "clone", "-q", "--no-hardlinks", root, replacement);
  const replacementGitDir = await readGitDirectory(replacement);
  const ref = "refs/gitsimplecompare/test-snapshot";
  await git(root, "update-ref", ref, head); await git(replacement, "update-ref", ref, head);
  const store = new OperationUndoStore(root);
  await store.start("main", head, ref);
  const file = join(originalGitDir, "gitsimplecompare", "branch-operation-undo", `${Buffer.from("main").toString("hex")}.json`);
  const before = await readFile(file, "utf8");
  const check = (store as any).assertSnapshot.bind(store);
  t.mock.method(store as any, "assertSnapshot", async (...args: any[]) => {
    await check(...args);
    await writeFile(join(root, ".git"), `gitdir: ${replacementGitDir}\n`);
  });
  await assert.rejects(store.capture("main", ref, "completed"), /no longer matches/);
  const current = await readGitCheckoutIdentity(root);
  assert.equal(current.branch, "main"); assert.equal(current.head, head);
  assert.equal(current.gitDir, replacementGitDir); assert.notEqual(current.gitDir, originalGitDir);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(stat(join(replacementGitDir, "gitsimplecompare")), { code: "ENOENT" });
});

test("Git directory reads preserve newline and trailing whitespace even before the first commit", { skip: process.platform === "win32" }, async t => {
  const { root, directory } = await safetyFixture(t, "metadata-path-safety");
  for (const [index, suffix] of ["newline\n ", "space "].entries()) {
    const worktree = join(directory, `empty-${index}`), metadata = join(directory, suffix);
    await mkdir(worktree);
    await git(root, "init", "-q", "-b", "main", "--separate-git-dir", metadata, worktree);
    const resolved = await readGitDirectory(worktree);
    assert.ok(resolved.endsWith(suffix));
    assert.ok((await stat(resolved)).isDirectory());
  }
});
