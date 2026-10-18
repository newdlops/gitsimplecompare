import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { PullService } from "../src/git/pullService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * fixture 안에서 실행한 Git 프로세스를 구간별로 측정한다.
 * @param t 종료 시 spawn 대역을 복구하는 문맥 @returns 다음 작업 전에 비울 수 있는 실제 Git 인수 목록
 */
function observeGit(t: TestContext): string[][] {
  const spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("Undo metadata shares only same-call directories while retaining a usable recovery binding", async t => {
  const { root, head } = await safetyFixture(t, "operation-metadata-performance");
  const ref = "refs/gitsimplecompare/test-snapshot";
  await git(root, "update-ref", ref, head);
  const store = new OperationUndoStore(root), calls = observeGit(t);
  await store.start("main", head, ref);
  const start = calls.length;
  calls.length = 0;
  await store.capture("main", ref, "completed");
  const capture = calls.length;
  t.diagnostic(JSON.stringify({ start, capture }));
  assert.ok(start <= 1, `Undo start exceeded its Git process budget: ${start}`);
  assert.ok(capture <= 4, `Undo capture exceeded its Git process budget: ${capture}`);
  const plan = await store.prepare("main");
  assert.equal(plan.restoredHead, head); assert.equal(plan.expectedHead, head);
  assert.equal(plan.snapshotRef, ref); assert.equal(plan.phase, "completed");
});

test("a blocked dirty pull and rollback share fresh metadata without losing edits or stash ownership", async t => {
  const { root, directory, head } = await safetyFixture(t, "pull-metadata-performance");
  await addOrigin(root, directory);
  await git(root, "switch", "-qc", "remote-next");
  const next = await commitText(root, "remote content\n", "remote next");
  await git(root, "push", "origin", `${next}:refs/heads/main`);
  await git(root, "switch", "main");
  await writeFile(join(root, "tracked.txt"), "local content\n");
  await writeFile(join(root, "untracked.txt"), "keep untracked\n");
  const service = new PullService(root), calls = observeGit(t);
  const result = await service.pullCurrent();
  const pull = calls.length;
  assert.equal(result.status, "conflicts");
  if (result.status !== "conflicts") return;
  assert.equal(result.stage, "restoreLocalChanges"); assert.ok(result.snapshot);
  calls.length = 0;
  assert.ok(await service.rollbackLatestPull(result.snapshot.id));
  const rollback = calls.length;
  t.diagnostic(JSON.stringify({ pull, rollback }));
  assert.ok(pull <= 20, `Dirty pull exceeded its Git process budget: ${pull}`);
  assert.ok(rollback <= 20, `Pull rollback exceeded its Git process budget: ${rollback}`);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "local content\n");
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "keep untracked\n");
  assert.equal(await git(root, "stash", "list"), "");
});
