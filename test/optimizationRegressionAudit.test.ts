import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DiffHunkService } from "../src/git/diffHunkService";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("deferred details omit an untracked file deleted after the list snapshot", async t => {
  const { root } = await safetyFixture(t, "audit-deferred-delete");
  const file = join(root, "new.txt"), service = new DiffHunkService(root);
  await writeFile(file, "new\n"); await service.getWorkingDiff({ syntheticByteBudget: 0 });
  await rm(file);
  assert.deepEqual(await service.getDeferredFileWorkingDiff("new.txt"), await service.getFileWorkingDiff("new.txt"));
});

test("deferred details honor ignore rules changed after the list snapshot", async t => {
  const { root } = await safetyFixture(t, "audit-deferred-ignore");
  await mkdir(join(root, "folder")); await writeFile(join(root, "folder/new.txt"), "new\n");
  const service = new DiffHunkService(root);
  for (const target of [".gitignore", "folder/.gitignore", ".git/info/exclude"]) {
    await service.getWorkingDiff({ syntheticByteBudget: 0 });
    await writeFile(join(root, target), "new.txt\n");
    assert.deepEqual(await service.getDeferredFileWorkingDiff("folder/new.txt"), await service.getFileWorkingDiff("folder/new.txt"), target);
    await rm(join(root, target));
  }
});

test("deferred details honor changes in the configured global excludes file", async t => {
  const { root, directory } = await safetyFixture(t, "audit-deferred-global-ignore");
  const exclude = join(directory, "global-ignore"); await writeFile(exclude, "");
  await git(root, "config", "core.excludesFile", exclude);
  await writeFile(join(root, "new.txt"), "new\n"); const service = new DiffHunkService(root);
  await service.getWorkingDiff({ syntheticByteBudget: 0 }); await writeFile(exclude, "new.txt\n");
  assert.deepEqual(await service.getDeferredFileWorkingDiff("new.txt"), await service.getFileWorkingDiff("new.txt"));
});

test("deferred details reclassify a path replaced with a directory", async t => {
  const { root } = await safetyFixture(t, "audit-deferred-directory");
  const file = join(root, "new.txt"), service = new DiffHunkService(root);
  await writeFile(file, "new\n"); await service.getWorkingDiff({ syntheticByteBudget: 0 });
  await rm(file); await mkdir(file); await writeFile(join(file, "child.txt"), "child\n");
  assert.deepEqual(await service.getDeferredFileWorkingDiff("new.txt"), await service.getFileWorkingDiff("new.txt"));
});
