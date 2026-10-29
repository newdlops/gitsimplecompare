import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { readGitCheckoutIdentityWithSnapshot } from "../src/git/repositoryIdentity";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const ref = "refs/gitsimplecompare/test-snapshot";

test("snapshot identity reads distinct snapshot and current commits without caching either ref", async t => {
  const { root, head } = await safetyFixture(t, "snapshot-identity");
  await git(root, "update-ref", ref, head);
  const next = await commitText(root, "next\n", "next");
  const first = await readGitCheckoutIdentityWithSnapshot(root, ref);
  assert.equal(first.snapshotHead, head); assert.equal(first.identity.head, next);
  assert.equal(first.identity.branchRef, "refs/heads/main");
  await git(root, "update-ref", ref, next);
  await git(root, "switch", "-qc", "another", head);
  const second = await readGitCheckoutIdentityWithSnapshot(root, ref);
  assert.equal(second.snapshotHead, next); assert.equal(second.identity.head, head);
  assert.equal(second.identity.branch, "another");
});

test("snapshot identity preserves linked paths and HEAD tag ambiguity, including detached HEAD", async t => {
  const { root, directory, head } = await safetyFixture(t, "snapshot-identity-linked");
  const linked = join(directory, "linked\npath ");
  await git(root, "worktree", "add", "-qb", "feature/한글", linked, head);
  const alias = join(directory, "alias"); await symlink(linked, alias, "dir");
  await git(root, "update-ref", ref, head);
  const next = await commitText(alias, "next\n", "next");
  await git(root, "update-ref", "refs/tags/HEAD", head);
  const result = await readGitCheckoutIdentityWithSnapshot(alias, ref);
  assert.equal(result.snapshotHead, head); assert.equal(result.identity.head, next);
  assert.equal(result.identity.branch, "feature/한글");
  assert.notEqual(result.identity.gitDir, await realpath(join(root, ".git")));
  await git(alias, "switch", "--detach", next);
  assert.equal((await readGitCheckoutIdentityWithSnapshot(alias, ref)).identity.branch, "");
});

test("snapshot identity rejects missing refs, non-commits and revision expressions", async t => {
  const { root, head } = await safetyFixture(t, "snapshot-identity-invalid");
  await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, ref));
  await git(root, "update-ref", ref, await git(root, "rev-parse", "HEAD^{tree}"));
  await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, ref));
  await git(root, "update-ref", ref, head);
  for (const invalid of [ref + "^", ref + "\nHEAD", "--all", "HEAD", "refs/heads/main", ref + "@{0}"]) {
    await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, invalid), /Invalid operation recovery snapshot/);
  }
});

test("snapshot identity supports SHA-256 and refuses unborn HEAD", async t => {
  const { directory } = await safetyFixture(t, "snapshot-identity-sha256");
  const root = join(directory, "sha256"); await mkdir(root);
  await git(root, "init", "-qb", "main", "--object-format=sha256");
  await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, ref));
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test",
    "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(directory, "hooks") })) {
    await git(root, "config", key, value);
  }
  const head = await commitText(root, "sha256\n", "sha256");
  await git(root, "update-ref", ref, head);
  const result = await readGitCheckoutIdentityWithSnapshot(root, ref);
  assert.equal(head.length, 64); assert.equal(result.snapshotHead, head); assert.equal(result.identity.head, head);
});

test("snapshot identity handles CRLF and rejects truncated or failed Native responses", async t => {
  const { root, head } = await safetyFixture(t, "snapshot-identity-output");
  const gitDir = await realpath(join(root, ".git"));
  let output = `${gitDir}\r\n${head}\r\n${head}\r\nrefs/heads/main\r\n`, code = 0;
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[1].includes("--symbolic-full-name")) {
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)}); process.exitCode=${code};`], args[2]);
    }
    return (spawn as Function)(...args);
  });
  assert.deepEqual(await readGitCheckoutIdentityWithSnapshot(root, ref), {
    identity: { gitDir, head, branch: "main", branchRef: "refs/heads/main" }, snapshotHead: head,
  });
  output = `${gitDir}\n${head}\nrefs/heads/main\n`;
  await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, ref), /Cannot verify/);
  output = `${gitDir}\n${head}\n${head}\nrefs/heads/main\n`; code = 128;
  await assert.rejects(readGitCheckoutIdentityWithSnapshot(root, ref));
});

test("capture and prepare preserve their binding when the recovery snapshot was replaced or deleted", async t => {
  const { root, head } = await safetyFixture(t, "snapshot-binding-safety");
  await git(root, "update-ref", ref, head);
  const store = new OperationUndoStore(root);
  await store.start("main", head, ref); await store.capture("main", ref, "completed");
  const file = join(root, ".git/gitsimplecompare/branch-operation-undo", `${Buffer.from("main").toString("hex")}.json`);
  const before = await readFile(file);
  const next = await commitText(root, "next\n", "next");
  await git(root, "update-ref", ref, next);
  await assert.rejects(store.capture("main", ref, "completed"), /no longer matches/);
  await assert.rejects(store.prepare("main"), /no longer matches/);
  await git(root, "update-ref", "-d", ref);
  await assert.rejects(store.capture("main", ref, "completed"));
  await assert.rejects(store.prepare("main"));
  assert.deepEqual(await readFile(file), before);
  assert.equal(await git(root, "rev-parse", "HEAD"), next);
});
