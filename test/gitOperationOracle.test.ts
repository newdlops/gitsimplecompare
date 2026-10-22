import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperationFixture } from "./helpers/gitOperationFixture";
import { verifyGitOperationResult } from "./helpers/gitOperationOracle";
import { runGit } from "../src/git/gitExec";

/** 실제 Git 상태로 no-op과 완료를 구분하되 작은 소유 fixture와 private 원격만 만든다. */
async function fixture(t: TestContext) {
  const values = { GSC_BENCH_FILES: "3", GSC_BENCH_COMMITS: "12", GSC_BENCH_BRANCHES: "3", GSC_BENCH_SHARED_UPSTREAM_BRANCHES: "0" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-operation-oracle-"));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  return createGitOperationFixture(directory);
}

test("Native oracle rejects a partial receiver and accepts only the required push HEAD", async t => {
  const f = await fixture(t);
  await runGit(["switch", "-qC", "bench-push", f.pr], f.root);
  await runGit(["update-ref", "refs/heads/bench-push", f.main], f.remote);
  await assert.rejects(verifyGitOperationResult(f, "push"), /receiver HEAD/);
  await runGit(["push", "-q", "origin", "HEAD:refs/heads/bench-push"], f.root);
  await verifyGitOperationResult(f, "push");
});

test("Native oracle rejects an unapplied PR and verifies the squashed tree and parent", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyGitOperationResult(f, "pr-squash-cherry-pick"));
  await runGit(["merge", "--squash", f.prBranch], f.root);
  await runGit(["commit", "-qm", "Squashed fixture"], f.root);
  await verifyGitOperationResult(f, "pr-squash-cherry-pick");
});

test("Native oracle verifies actual merge parents instead of accepting the old HEAD", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyGitOperationResult(f, "merge-no-ff"));
  await runGit(["merge", "--no-ff", "--no-edit", f.topicBranch], f.root);
  await verifyGitOperationResult(f, "merge-no-ff");
});

test("Native oracle requires the requested checkout branch and not only a clean tree", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyGitOperationResult(f, "checkout", f.topicBranch));
  await runGit(["switch", "-q", f.topicBranch], f.root);
  await verifyGitOperationResult(f, "checkout", f.topicBranch);
});

test("Native oracle rejects a missing fetched ref and accepts the real incoming commit", async t => {
  const f = await fixture(t);
  await runGit(["update-ref", "refs/heads/incoming", f.incoming], f.remote);
  await assert.rejects(verifyGitOperationResult(f, "fetch"));
  await runGit(["fetch", "-q", "origin"], f.root);
  await verifyGitOperationResult(f, "fetch");
});

test("Native oracle rejects a PR source checkout even when its tree, count and messages match replay", async t => {
  const f = await fixture(t);
  await runGit(["switch", "-q", f.prBranch], f.root);
  await assert.rejects(verifyGitOperationResult(f, "pr-cherry-pick", undefined, undefined, f.mainBranch), /different checked-out branch/);
  await assert.rejects(verifyGitOperationResult(f, "fetch-unsupported" as "fetch"), /Unsupported operation/);
});
