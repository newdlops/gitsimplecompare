import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readConflictOperationEpochAt, readConflictOperationSnapshot } from "../src/git/conflictOperationEpoch";
import { ConflictBlobReader } from "../src/git/conflictBlobReader";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** unborn HEAD에서도 directory 출력의 줄바꿈·공백을 손상하지 않고 marker를 새로 읽는다. */
test("unborn conflict snapshots preserve unusual directory names and fresh marker contents", async t => {
  const { directory } = await safetyFixture(t, "conflict-unborn");
  const root = join(directory, "unborn worktree\nand whitespace ");
  await mkdir(root); await git(root, "init", "-q");
  const original = childProcess.spawn; let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { calls++; return (original as Function)(...args); });
  const first = await readConflictOperationSnapshot(root);
  assert.equal(calls, 1); assert.equal(first.operation, "none");
  assert.equal(first.epoch, await readConflictOperationEpochAt(join(root, ".git"), "unborn"));
  await writeFile(join(root, ".git", "MERGE_HEAD"), "a".repeat(40) + "\n");
  const second = await readConflictOperationSnapshot(root);
  assert.equal(calls, 2); assert.equal(second.operation, "merge"); assert.notEqual(second.epoch, first.epoch);
  await writeFile(join(root, ".git", "MERGE_HEAD"), "b".repeat(40) + "\n");
  assert.notEqual((await readConflictOperationSnapshot(root)).epoch, second.epoch);
});

/** linked worktree의 marker와 epoch가 main worktree 상태에 섞이지 않도록 검사한다. */
test("one-process conflict snapshots use the linked worktree Git directory", async t => {
  const { root, directory, head } = await safetyFixture(t, "conflict-linked-epoch");
  const linked = join(directory, "linked\nworktree ");
  await git(root, "worktree", "add", "-qb", "linked", linked);
  const gitDir = await git(linked, "rev-parse", "--absolute-git-dir");
  const first = await readConflictOperationSnapshot(linked);
  assert.equal(first.epoch, await readConflictOperationEpochAt(gitDir, head));
  await writeFile(join(gitDir, "CHERRY_PICK_HEAD"), head + "\n");
  const second = await readConflictOperationSnapshot(linked);
  assert.equal(second.operation, "cherry-pick"); assert.notEqual(second.epoch, first.epoch);
  assert.equal((await readConflictOperationSnapshot(root)).operation, "none");
});

/** batch 프레임과 캐시 키가 SHA-1 길이에 묶이지 않고 SHA-256 index 객체도 읽어야 한다. */
test("conflict blob batches preserve SHA-256 object IDs and binary classification", async t => {
  const { directory } = await safetyFixture(t, "conflict-sha256");
  const root = join(directory, "sha256"); await mkdir(root);
  await git(root, "init", "-q", "--object-format=sha256");
  const file = join(root, "blob.txt"), oids: string[] = [];
  for (const bytes of [Buffer.from("SHA-256 한글\n"), Buffer.from([97, 0, 98])]) {
    await writeFile(file, bytes); oids.push(await git(root, "hash-object", "-w", file));
  }
  assert.equal(oids[0].length, 64);
  const values = await new ConflictBlobReader().readMany(root, oids);
  assert.equal(values.get(oids[0])?.content, "SHA-256 한글\n");
  assert.deepEqual(values.get(oids[1]), { kind: "binary", content: "" });
});
