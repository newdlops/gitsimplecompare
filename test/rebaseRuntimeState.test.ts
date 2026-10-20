import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { captureGitOperation } from "../src/git/operationControl";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * 실제 native edit 정지 지점을 만들어 파일/작업 경합을 재현한다.
 * @param t 종료 시 임시 저장소와 mock을 정리하는 테스트 문맥 @param two 두 번째 edit도 추가할지 여부
 * @returns 첫 edit에서 정지한 저장소·서비스·원본 todo 항목
 */
async function fixture(t: TestContext, two = false) {
  const fixture = await safetyFixture(t, "rebase-runtime-state");
  const { root, head } = fixture;
  const first = await commitText(root, "first\n", "first");
  const items: RebaseItem[] = [{ hash: first, action: "edit" }];
  if (two) items.push({ hash: await commitText(root, "second\n", "second"), action: "edit" });
  const service = new RebaseService(root);
  assert.equal((await service.start(head, false, items, resolve("media/rebase/rebaseEditor.js"))).status, "paused");
  return { ...fixture, first, service, items };
}

test("a conflict introduced during detail lookup is reflected in the final runtime state", async t => {
  const { root, first, service } = await fixture(t);
  const oid = await git(root, "rev-parse", `${first}:tracked.txt`);
  const details = (service as any).readPausedEditDetails.bind(service);
  t.mock.method(service as any, "readPausedEditDetails", async (...args: any[]) => {
    const state = await details(...args);
    await writeFile(join(root, "late.txt"), "external conflict\n");
    await runGitWithInput(["update-index", "--index-info"], root, [1, 2, 3]
      .map(stage => `100644 ${oid} ${stage}\tlate.txt\n`).join(""));
    return state;
  });
  const state = await service.getRuntimeState();
  assert.ok((await git(root, "ls-files", "--unmerged")).includes("late.txt"));
  assert.deepEqual(state.conflicts, ["late.txt"]);
  assert.equal(state.paused, undefined);
  assert.equal(await service.getPausedEditState(), undefined);
});

for (const action of ["continue", "abort"] as const) {
  test(`native ${action} during a runtime read invalidates the entire old snapshot`, async t => {
    const { root, service, items } = await fixture(t, true);
    const details = (service as any).readPausedEditDetails.bind(service);
    t.mock.method(service as any, "readPausedEditDetails", async (...args: any[]) => {
      const state = await details(...args);
      await git(root, "-c", "core.editor=true", "rebase", action === "continue" ? "--continue" : "--abort");
      return state;
    });
    await assert.rejects(service.getRuntimeState(), /operation changed/i);
    if (action === "continue") {
      assert.equal((await new RebaseService(root).getPausedEditState())?.originalHash, items[1].hash);
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "second\n");
    } else {
      const current = await new RebaseService(root).getRuntimeState();
      assert.equal(current.operation.operation, "none");
      assert.equal(current.paused, undefined); assert.equal(current.stopped, undefined);
      assert.equal(current.progress, undefined); assert.deepEqual(current.conflicts, []);
    }
  });
}

test("an expected identity from an earlier native step is rejected before querying runtime content", async t => {
  const { root, service } = await fixture(t, true);
  const expected = await captureGitOperation(root);
  await git(root, "-c", "core.editor=true", "rebase", "--continue");
  const spawn = childProcess.spawn;
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls.push(args[1]); return (spawn as Function)(...args); });
  await assert.rejects(service.getRuntimeState(expected), /operation changed/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "rev-parse");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "second\n");
});

test("paused file detail errors preserve the restorable operation and todo without guessing file metadata", async t => {
  const { first, service } = await fixture(t);
  t.mock.method(service as any, "readPausedEditDetails", async () => { throw new Error("file metadata unavailable"); });
  const state = await service.getRuntimeState();
  assert.equal(state.paused, undefined);
  assert.equal(state.operation.operation, "rebase");
  assert.equal(state.stopped?.originalHash, first);
  assert.equal(state.progress?.currentHash, first);
  assert.deepEqual(state.conflicts, []);
  await assert.rejects(service.getPausedEditState(), /file metadata unavailable/);
});

test("an unreadable index cannot be interpreted as a paused edit with no conflicts", async t => {
  const { first, service } = await fixture(t);
  const spawn = childProcess.spawn;
  let details = 0, unreadableLists = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const command = args[0] === "git" ? args[1][gitCommandIndex(args[1])] : undefined;
    if (command === "ls-files") {
      unreadableLists++;
      return spawn(process.execPath, ["-e", 'process.stderr.write("index temporarily unreadable\\n"); process.exit(1);'], args[2]);
    }
    if (command === "log") details++;
    return (spawn as Function)(...args);
  });
  const state = await service.getRuntimeState();
  assert.equal(unreadableLists, 2, "both real index read boundaries must receive the injected error");
  assert.equal(state.paused, undefined); assert.equal(details, 0);
  assert.equal(state.operation.operation, "rebase");
  assert.equal(state.stopped?.originalHash, first);
  assert.equal(state.progress?.currentHash, first);
});

for (const hasConflicts of [false, true]) {
  test(`a failed final index query keeps known paths and does not infer edit state (conflicts: ${hasConflicts})`, async t => {
    const { root, first, service } = await fixture(t);
    if (hasConflicts) {
      const oid = await git(root, "rev-parse", `${first}:tracked.txt`);
      await runGitWithInput(["update-index", "--index-info"], root,
        [1, 2, 3].map(stage => `100644 ${oid} ${stage}\tkept.txt\n`).join(""));
    }
    const spawn = childProcess.spawn;
    let lists = 0;
    t.mock.method(childProcess, "spawn", (...args: any[]) => {
      if (args[0] === "git" && args[1][gitCommandIndex(args[1])] === "ls-files" && ++lists === 2) {
        return spawn(process.execPath, ["-e", 'process.stderr.write("index temporarily unreadable\\n"); process.exit(1);'], args[2]);
      }
      return (spawn as Function)(...args);
    });
    const state = await service.getRuntimeState();
    assert.equal(lists, 2, "the final index error must actually be injected despite global Git options");
    assert.deepEqual(state.conflicts, hasConflicts ? ["kept.txt"] : []);
    assert.equal(state.paused, undefined);
    assert.equal(state.stopped?.originalHash, first);
  });
}

test("a missing stopped-sha shares the same fresh todo read instead of reading the whole todo twice", async t => {
  const { root, first, service } = await fixture(t);
  const operation = await captureGitOperation(root);
  await rm(join(operation.gitDir, "rebase-merge", "stopped-sha"));
  const read = fs.promises.readFile;
  const reads: string[] = [];
  t.mock.method(fs.promises, "readFile", ((...args: any[]) => {
    if (args[1] === "utf8" && ["done", "git-rebase-todo"].includes(basename(String(args[0])))) reads.push(basename(String(args[0])));
    return (read as Function)(...args);
  }) as typeof read);
  const state = await service.getRuntimeState();
  assert.equal(state.paused?.originalHash, first);
  assert.equal(state.stopped?.originalHash, first);
  assert.equal(state.progress?.currentHash, first);
  assert.deepEqual(reads.sort(), ["done", "git-rebase-todo"]);
});

test("runtime snapshots freeze expected values and still read the current worktree operation", async t => {
  const { root, service } = await fixture(t);
  const expected = await captureGitOperation(root);
  const originalHead = expected.head;
  const reading = service.getRuntimeState(expected);
  expected.head = "0".repeat(40);
  const state = await reading;
  assert.equal(state.operation.head, originalHead);
  assert.equal(state.paused?.hash, originalHead);
  assert.notEqual(state.operation, expected);
});
