import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runGit } from "../src/git/gitExec";
import { GitTagService, invalidateRemoteTagCache } from "../src/git/gitTagService";

test("Native lightweight/annotated tag targets, invalidation and local rename remain exact", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-tag-native-")), root = path.join(directory, "repo"), remote = path.join(directory, "remote.git");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  const git = (args: string[]) => runGit(args, root);
  await git(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"]);
  for (const [key, value] of Object.entries({ "user.name": "Tag fixture", "user.email": "tag@example.invalid", "core.fsmonitor": "false",
    "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false", "tag.gpgSign": "false" })) await git(["config", key, value]);
  await writeFile(path.join(root, "tracked.txt"), "one\n"); await git(["add", "tracked.txt"]); await git(["commit", "-qm", "one"]);
  const first = (await git(["rev-parse", "HEAD"])).trim();
  await git(["tag", "v-light"]); await git(["tag", "-a", "v-annotated", "-m", "annotated"]);
  const annotatedObject = (await git(["rev-parse", "refs/tags/v-annotated"])).trim();
  await git(["-c", "init.templateDir=", "init", "-q", "--bare", remote]); await git(["remote", "add", "origin", remote]);
  await git(["push", "-q", "--tags", "origin"]);
  const service = new GitTagService(root), initial = await service.getTagStatuses();
  assert.equal(initial.length, 2);
  for (const tag of initial) { assert.equal(tag.localHash, first); assert.equal(tag.remoteTargets[0].hash, first); }
  await writeFile(path.join(root, "tracked.txt"), "two\n"); await git(["commit", "-qam", "two"]);
  const second = (await git(["rev-parse", "HEAD"])).trim();
  await git(["tag", "-f", "v-light"]); await git(["push", "-q", "--force", "origin", "refs/tags/v-light"]);
  invalidateRemoteTagCache(root, "origin");
  const refreshed = await service.getTagStatuses();
  assert.equal(refreshed.find(tag => tag.name === "v-light")?.remoteTargets[0].hash, second);
  assert.equal(refreshed.find(tag => tag.name === "v-annotated")?.remoteTargets[0].hash, first);
  await service.renameLocalTag("v-annotated", "v-renamed");
  assert.equal((await git(["rev-parse", "refs/tags/v-renamed"])).trim(), annotatedObject);
  const renamed = await service.getTagStatuses();
  assert.equal(renamed.find(tag => tag.name === "v-annotated")?.localHash, undefined);
  assert.equal(renamed.find(tag => tag.name === "v-renamed")?.localHash, first);
});
