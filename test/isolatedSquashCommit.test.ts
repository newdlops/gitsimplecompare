import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { PullRequestOperationWorktree } from "../src/git/pullRequestOperationWorktree";
import { createPromisorPushFixture, missingPromisorBlobs, promisorPackState, promisorGit as git } from "./helpers/promisorPushFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

for (const revert of [false, true]) test(`isolated PR ${revert ? "squash revert" : "squash"} commits keep absent blobs absent and still refresh the Native index`, async t => {
  const version = /git version (\d+)\.(\d+)/.exec(await runGit(["--version"], process.cwd()));
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 45) {
    t.skip("Native no-lazy-fetch verification requires Git 2.45 or newer"); return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-isolated-squash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPromisorPushFixture(directory, { blobCount: 4, blobBytes: 128 * 1024 });
  // 삭제될 원본 blob은 서버에만 남긴다. summary용 diffstat만 이 객체를 요구할 수 있는 index를 만든다.
  await runGitWithInput(["update-index", "--force-remove", "-z", "--stdin"], f.root,
    f.blobs.map((_blob, index) => `base-${index}.txt\0`).join(""));
  const tree = await git(f.root, "write-tree"), before = await promisorPackState(f.root);
  const config = await readFile(path.join(f.root, ".git/config"));
  assert.equal(await missingPromisorBlobs(f.root, f.blobs), 4);
  const trace = path.join(directory, "commit.jsonl"), previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  t.after(() => { if (previous === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previous; });
  const worktree = new PullRequestOperationWorktree(f.root, new PullRequestOperationSnapshot(f.root));
  const method = revert ? worktree.commitSquashRevert.bind(worktree) : worktree.commitSquash.bind(worktree);
  await method(safetyPullRequest(f.head), f.root, false);
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const fetches = events.filter(event => event.event === "child_start" && event.argv?.includes("fetch"));
  assert.equal(fetches.length, 0, "A discarded success summary must not hydrate deleted promisor blobs");
  assert.equal(await missingPromisorBlobs(f.root, f.blobs), 4);
  assert.deepEqual(await promisorPackState(f.root), before);
  assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git(f.root, "rev-parse", "HEAD^"), f.head);
  assert.deepEqual(await readFile(path.join(f.root, ".git/config")), config);
  const refreshes = events.filter(event => event.event === "data" && event.key === "refresh/sum_lstat");
  assert.ok(refreshes.some(event => Number(event.value) > 0), "Fresh Native file checks must remain after suppressing parallel preload");
  assert.equal(events.filter(event => event.event === "region_enter" && event.label === "preload").length, 0);
  assert.ok((await runGit(["log", "-1", "--format=%B"], f.root)).includes(revert ? "Revert" : "Cherry-Pick"));
});
