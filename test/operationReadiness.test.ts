import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 종료 gate를 실제 시간 기반 sleep 없이 테스트가 직접 해제한다. */
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("PR readiness starts unmerged verification before waiting for the checkout and awaits both", async t => {
  const f = await safetyFixture(t, "pr-readiness-overlap"), state = new PullRequestOperationSnapshot(f.root), release = gate();
  let entered = false, finished = false;
  t.mock.method(state, "hasUnmergedChanges", async () => { entered = true; await release.promise; return false; });
  const pending = state.prepareForPrOperation().then(value => { finished = true; return value; });
  t.after(async () => { release.resolve(); await Promise.allSettled([pending]); });
  assert.equal(entered, true, "Unmerged verification was deferred until checkout completion");
  assert.equal(finished, false); release.resolve();
  assert.deepEqual(await pending, { branch: "main", beforeHead: f.head });
});

for (const operation of ["squash", "rebase", "PR"] as const) for (const code of ["ETIMEDOUT", "EACCES"]) {
  test(`${operation} readiness preserves an unmerged ${code} error and closes other reads before rejecting`, async t => {
    const f = await safetyFixture(t, `readiness-${operation}-${code}`); await git(f.root, "branch", "topic");
    const before = await readFile(path.join(f.root, ".git/index")), active = new Set<ReturnType<typeof childProcess.spawn>>();
    const commands: string[][] = [], spawn = childProcess.spawn;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1])) {
        commands.push([...args[1]]);
        if (args[1].includes("ls-files") && args[1].includes("--unmerged")) {
          throw Object.assign(new Error(`unmerged read stopped ${code}`), { code });
        }
      }
      const child = Reflect.apply(spawn, childProcess, args); active.add(child);
      child.once("close", () => { active.delete(child); }); return child;
    });
    const branch = new BranchOperationService(f.root);
    const pending = operation === "squash" ? branch.squashMerge("topic") : operation === "rebase" ? branch.rebaseMerge("topic")
      : new PullRequestOperationSnapshot(f.root).prepareForPrOperation();
    await assert.rejects(pending, new RegExp(`unmerged read stopped ${code}`));
    assert.equal(active.size, 0, "A failed preparation returned while another owned read was still live");
    const writes = new Set(["update-ref", "stash", "merge", "rebase", "reset", "commit"]);
    assert.equal(commands.some(args => args.some(arg => writes.has(arg))), false);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
    assert.equal(await git(f.root, "for-each-ref", "--format=%(refname)", "refs/gitsimplecompare"), "");
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), before);
  });
}

test("an active native operation retains error priority when the parallel unmerged read also fails", async t => {
  const f = await safetyFixture(t, "pr-readiness-operation-priority"), state = new PullRequestOperationSnapshot(f.root);
  await writeFile(path.join(f.root, ".git/MERGE_HEAD"), `${f.head}\n`);
  t.mock.method(state, "hasUnmergedChanges", async () => { throw new Error("parallel index read failed"); });
  await assert.rejects(state.prepareForPrOperation(), /Cannot start PR operation while merge is in progress/);
});

for (const operation of ["squash", "rebase"] as const) for (const code of ["ETIMEDOUT", "EACCES"]) {
  test(`${operation} preserves a target ${code} failure instead of reporting a missing branch`, async t => {
    const f = await safetyFixture(t, `readiness-target-${operation}-${code}`); await git(f.root, "branch", "topic");
    const expression = operation === "squash" ? "refs/heads/topic^{commit}" : "topic^{commit}", spawn = childProcess.spawn;
    let failed = false;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1]) && args[1].includes(expression)) {
        failed = true; throw Object.assign(new Error(`target read stopped ${code}`), { code });
      }
      return Reflect.apply(spawn, childProcess, args);
    });
    const service = new BranchOperationService(f.root);
    await assert.rejects(operation === "squash" ? service.squashMerge("topic") : service.rebaseMerge("topic"),
      new RegExp(`target read stopped ${code}`));
    assert.equal(failed, true); assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
    assert.equal(await git(f.root, "for-each-ref", "--format=%(refname)", "refs/gitsimplecompare"), "");
  });
}
