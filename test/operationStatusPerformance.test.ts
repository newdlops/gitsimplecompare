import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { PullService } from "../src/git/pullService";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

for (const kind of ["pull", "pull-request"] as const) {
  test(`${kind} checks for local changes without listing every file in an untracked directory`, async t => {
    const { root } = await safetyFixture(t, `status-boolean-${kind}`);
    await git(root, "config", "status.showUntrackedFiles", "all");
    const folder = join(root, "bulk untracked"); await mkdir(folder);
    for (let start = 0; start < 2000; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(folder, `file-${start + offset}.txt`), "local work\n")));
    }
    const spawn = childProcess.spawn; let bytes = 0;
    t.mock.method(childProcess, "spawn", (...args: any[]) => {
      const child = (spawn as Function)(...args);
      if (args[0] === "git" && args[1].includes("status")) child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      return child;
    });
    const service = kind === "pull" ? new PullService(root) : new PullRequestOperationSnapshot(root);
    const started = performance.now(), changed = await service.hasLocalChanges();
    t.diagnostic(JSON.stringify({ kind, files: 2000, statusBytes: bytes, elapsedMs: +(performance.now() - started).toFixed(1) }));
    assert.equal(changed, true);
    assert.ok(bytes < 100, `boolean check emitted ${bytes} bytes of file names`);
    assert.equal(await git(root, "ls-files", "--others", "--exclude-standard", "-z").then(output => output.split("\0").filter(Boolean).length), 2000);
  });

  test(`${kind} detects tracked and untracked edits while ignoring ignored-only files`, async t => {
    const { root } = await safetyFixture(t, `status-boolean-states-${kind}`);
    const service = kind === "pull" ? new PullService(root) : new PullRequestOperationSnapshot(root);
    assert.equal(await service.hasLocalChanges(), false);
    await writeFile(join(root, ".git", "info", "exclude"), "ignored/\n");
    await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored", "file.txt"), "ignored\n");
    assert.equal(await service.hasLocalChanges(), false);
    await writeFile(join(root, "tracked.txt"), "edit\n");
    assert.equal(await service.hasLocalChanges(), true);
    await git(root, "add", "tracked.txt"); assert.equal(await service.hasLocalChanges(), true);
    await git(root, "commit", "-qm", "staged edit"); assert.equal(await service.hasLocalChanges(), false);
    await git(root, "config", "status.showUntrackedFiles", "no");
    await mkdir(join(root, "new folder")); await writeFile(join(root, "new folder", "new.txt"), "untracked\n");
    assert.equal(await service.hasLocalChanges(), true);
  });
}
