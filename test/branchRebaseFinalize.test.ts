import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("completed branch rebase reuses its verified restoration HEAD without a second standalone lookup", async t => {
  const f = await safetyFixture(t, "branch-rebase-finalize");
  await writeFile(join(f.root, "local.txt"), "base local\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "base local");
  await git(f.root, "switch", "-qc", "source");
  await writeFile(join(f.root, "source.txt"), "source\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "source");
  const source = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "main");
  await writeFile(join(f.root, "destination.txt"), "destination\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "destination");
  await writeFile(join(f.root, "local.txt"), "preserved local edit\n");
  const calls: string[][] = [], spawn = childProcess.spawn;
  const observer = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    calls.push(argv.slice(gitCommandIndex(argv)));
    return Reflect.apply(spawn, childProcess, args);
  });
  let result: Awaited<ReturnType<BranchOperationService["rebaseMerge"]>>;
  try { result = await new BranchOperationService(f.root).rebaseMerge("source"); }
  finally { observer.mock.restore(); }
  assert.equal(result.status, "completed");
  // rebase 직후 결과 OID는 한 번 읽되 stash 복원 직전에는 branch+HEAD 안전 검증을 그대로 수행한다.
  assert.equal(calls.filter(args => JSON.stringify(args) === JSON.stringify(["rev-parse", "--verify", "HEAD"])).length, 1);
  await git(f.root, "merge-base", "--is-ancestor", source, "HEAD");
  assert.equal(await git(f.root, "show", "HEAD:destination.txt"), "destination");
  assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "preserved local edit\n");
  assert.equal(await git(f.root, "stash", "list"), "");
  assert.equal(await new BranchOperationService(f.root).hasUndoSnapshot(), true);
});
