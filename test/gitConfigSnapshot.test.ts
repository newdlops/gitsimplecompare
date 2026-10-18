import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitConfigSnapshot, readGitConfigSnapshot } from "../src/git/gitConfigSnapshot";
import { getCurrentPushPlan } from "../src/git/pushService";
import { addOrigin, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("configuration records preserve duplicate, empty and multiline values and case-sensitive subsections", () => {
  const config = new GitConfigSnapshot("Branch.Feature.With.Dots.PushRemote\nfirst\0branch.Feature.With.Dots.pushremote\nSecond\0" +
    "branch.feature.with.dots.pushremote\nother\0remote.Second.push\n\0remote.Second.push\nfirst\nsecond\0core.flag\0");
  assert.equal(config.get("BRANCH.Feature.With.Dots.PUSHREMOTE"), "Second");
  assert.equal(config.get("branch.feature.with.dots.pushRemote"), "other");
  assert.deepEqual(config.getAll("remote.Second.push"), ["", "first\nsecond"]);
  const copy = config.getAll("remote.Second.push"); copy.push("mutated");
  assert.equal(config.getAll("remote.Second.push").length, 2);
  assert.equal(config.get("core.flag"), ""); assert.equal(config.get("core.missing"), undefined);
});

test("included configuration chooses the same final push remote as Git for mixed-case dotted branches", async t => {
  const { root, directory } = await safetyFixture(t, "push-config-snapshot");
  await addOrigin(root, directory);
  await git(root, "remote", "add", "Second", join(directory, "second.git"));
  await git(root, "switch", "-qc", "Feature.With.Dots");
  const include = join(directory, "included.config");
  await writeFile(include, '[branch "Feature.With.Dots"]\n pushRemote = origin\n pushRemote = Second\n');
  await git(root, "config", "include.path", include);
  const config = await readGitConfigSnapshot(root, "^branch\\.");
  assert.equal(config.get("branch.Feature.With.Dots.pushRemote"), await git(root, "config", "--get", "branch.Feature.With.Dots.pushRemote"));
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.branch, "Feature.With.Dots"); assert.equal(plan.remote, "Second");
  assert.equal(plan.mode, "setUpstream");
});
