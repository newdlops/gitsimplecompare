import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

for (const dirty of [false, true]) {
  test(`branch squash uses native merged index without restaging files (${dirty ? "isolated" : "current"} worktree)`, async t => {
    const f = await safetyFixture(t, "squash-index");
    await writeFile(path.join(f.root, "other.txt"), "other base\n"); await git(f.root, "add", "other.txt"); await git(f.root, "commit", "-qm", "other base");
    await git(f.root, "switch", "-qc", "source");
    await git(f.root, "mv", "tracked.txt", "renamed.txt");
    await writeFile(path.join(f.root, "added.txt"), "added\n"); await git(f.root, "add", "added.txt"); await git(f.root, "commit", "-qm", "source changes");
    await git(f.root, "switch", "-q", "main");
    const expectedTree = await git(f.root, "rev-parse", "source^{tree}");
    if (dirty) await writeFile(path.join(f.root, "other.txt"), "local user edit\n");
    const commands: string[][] = [], spawn = childProcess.spawn; let lateEdit = false;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      commands.push([...argv]); const child = Reflect.apply(spawn, childProcess, args);
      if (!dirty && argv.includes("merge") && argv.includes("--squash")) child.once("close", code => {
        if (code !== 0) return;
        // Native merge 직후 새로 생긴 사용자 작업을 다음 자동 stage가 쓸어 담지 않아야 한다.
        writeFileSync(path.join(f.root, "other.txt"), "late user edit\n");
        writeFileSync(path.join(f.root, "late.txt"), "late untracked edit\n"); lateEdit = true;
      });
      return child;
    });
    const result = await new BranchOperationService(f.root).squashMerge("source");
    assert.equal(result.status, "completed");
    assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), expectedTree);
    assert.equal(commands.some(argv => argv[gitCommandIndex(argv)] === "add"), false);
    assert.equal(await git(f.root, "show", "HEAD:added.txt"), "added");
    assert.equal(await git(f.root, "show", "HEAD:other.txt"), "other base");
    assert.equal(await readFile(path.join(f.root, "other.txt"), "utf8"), dirty ? "local user edit\n" : "late user edit\n");
    if (!dirty) { assert.equal(lateEdit, true); assert.equal(await readFile(path.join(f.root, "late.txt"), "utf8"), "late untracked edit\n"); }
  });
}
