import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { SEQUENTIAL_PUSH_THRESHOLD_BYTES, SequentialPushError } from "../src/git/sequentialPush";
import { createPublishedPushFixture } from "./helpers/publishedPushFixture";

const originalConfig = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
// 실제 push를 수행하는 임시 receiver가 사용자 global remote·hook 설정을 상속하지 않도록 worker만 격리한다.
test.before(() => { process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
test.after(() => {
  for (const [key, value] of [["GIT_CONFIG_GLOBAL", originalConfig.global], ["GIT_CONFIG_NOSYSTEM", originalConfig.system]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

test("a nearby published base after 64 stale advertisements prevents splitting an already-published 50MiB history", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-frontier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPublishedPushFixture(directory, { staleBranches: 64, largeBaseBytes: SEQUENTIAL_PUSH_THRESHOLD_BYTES });
  await writeFile(path.join(f.root, "tracked.txt"), "staged\n"); await runGit(["add", "tracked.txt"], f.root);
  await writeFile(path.join(f.root, "tracked.txt"), "unstaged\n"); await writeFile(path.join(f.root, "untracked.txt"), "keep\n");
  const index = await readFile(path.join(f.root, ".git/index"));
  const status = await runGit(["status", "--porcelain=v1"], f.root);
  const stale = await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/a-published-*"], f.remote);
  assert.equal(stale.trim().split("\n").length, 64);
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    onProgress: event => { if (event.phase === "ready") {
      assert.equal(event.strategy, "single", "The actual published base must be excluded even when not among the first 64 metadata tips");
      assert.ok(event.estimatedBytes! < SEQUENTIAL_PUSH_THRESHOLD_BYTES);
    } },
  });
  assert.equal(result.execution?.total, 1);
  const windows = calls.filter(args => args.includes("--first-parent") && args.includes("--format=%H%x00%P"));
  assert.equal(windows.length, 1, "Published-frontier discovery must reuse the existing recent-commit query");
  assert.ok(windows[0].includes("--max-count=65"));
  const estimates = calls.filter(args => args.includes("--objects"));
  assert.equal(estimates.length, 1); assert.ok(estimates[0].includes(`^${f.baseOid}`));
  const exclusions = estimates[0].filter(arg => arg.startsWith("^")).map(arg => arg.slice(1));
  assert.deepEqual(new Set(exclusions), new Set([f.baseOid, ...stale.trim().split("\n").map(line => line.split("\0")[1])]));
  assert.equal(exclusions.length, 65, "Keep all 64 typed tips and at most one source-verified frontier");
  const received = (await readFile(f.updates, "utf8")).trim().split("\n").map(line => line.split(" ")[1]);
  assert.deepEqual(received, [f.head]);
  assert.equal((await runGit(["rev-parse", "main"], f.remote)).trim(), f.baseOid);
  assert.equal((await runGit(["rev-parse", "feature"], f.remote)).trim(), f.head);
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), f.head);
  assert.equal(await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/a-published-*"], f.remote), stale);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
  assert.equal(await runGit(["status", "--porcelain=v1"], f.root), status);
});

test("a late advertised base still splits genuinely new large changes into only three empty-lease-first transfers", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-frontier-large-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPublishedPushFixture(directory, { staleBranches: 64, largeFeature: true });
  const commits = (await runGit(["rev-list", "--reverse", `${f.baseOid}..${f.head}`], f.root)).trim().split("\n");
  const pushes: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[1][gitCommandIndex(args[1])] === "push") pushes.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048,
    onProgress: event => { if (event.phase === "ready") assert.equal(event.total, 3, "Already published ancestors must not be transferred individually"); },
  });
  assert.equal(result.execution?.strategy, "sequential");
  assert.deepEqual((await readFile(f.updates, "utf8")).trim().split("\n").map(line => line.split(" ")[1]), commits);
  assert.deepEqual(pushes.map(args => args.find(arg => arg.startsWith("--force-with-lease="))),
    ["", ...commits.slice(0, -1)].map(oid => `--force-with-lease=refs/heads/feature:${oid}`));
  assert.equal((await runGit(["rev-parse", "main"], f.remote)).trim(), f.baseOid);
});

test("frontier publication still rejects a concurrent destination creation with its empty lease", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-frontier-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPublishedPushFixture(directory, { staleBranches: 64, largeFeature: true });
  let ready = false, created = false;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048,
    onProgress: event => { if (event.phase === "ready") { ready = true; assert.equal(event.total, 3); } },
    beforePush: async () => { if (ready && !created) {
      created = true; await runGit(["update-ref", "refs/heads/feature", f.baseOid], f.remote);
    } },
  }), error => {
    assert.ok(error instanceof SequentialPushError);
    assert.equal(error.result.completed, 0); assert.match(error.message, /stale info|rejected/); return true;
  });
  assert.equal(created, true);
  assert.equal((await runGit(["rev-parse", "feature"], f.remote)).trim(), f.baseOid);
  assert.equal(await readFile(f.updates, "utf8").catch(() => ""), "");
});

test("a local first-parent base absent from the actual server advertisement is never added as an exclusion", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-frontier-unadvertised-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPublishedPushFixture(directory, { staleBranches: 64, largeFeature: true });
  await runGit(["update-ref", "-d", "refs/heads/main"], f.remote);
  const unknown = (await runGit(["-c", "user.name=Remote", "-c", "user.email=remote@example.invalid",
    "commit-tree", `${f.baseOid}^{tree}`, "-p", f.baseOid, "-m", "remote-only"], f.remote)).trim();
  await runGit(["update-ref", "refs/heads/z-remote-only", unknown], f.remote);
  let ready = false;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048,
    onProgress: event => { if (event.phase === "ready") {
      ready = true; assert.equal(event.strategy, "sequential"); assert.ok(event.total > 3);
    } },
    beforePush: async () => { if (ready) throw new Error("stop after checking unadvertised history"); },
  }), /stop after checking unadvertised history/);
  assert.equal(ready, true);
  await assert.rejects(runGit(["cat-file", "-e", unknown], f.root));
  assert.equal(await readFile(f.updates, "utf8").catch(() => ""), "");
});

test("2048 stale remote heads keep frontier discovery bounded and publish only the three new commits once", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-frontier-many-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await createPublishedPushFixture(directory, { staleBranches: 2048 });
  const heads = (await runGit(["for-each-ref", "--format=%(refname)", "refs/heads/"], f.remote)).trim().split("\n");
  assert.equal(heads.length, 2049);
  const index = await readFile(path.join(f.root, ".git/index")), calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048,
    onProgress: event => { if (event.phase === "ready") {
      assert.equal(event.strategy, "single"); assert.equal(event.total, 1); assert.ok(event.estimatedBytes! < 2048);
    } },
  });
  assert.equal(result.execution?.total, 1);
  const windows = calls.filter(args => args.includes("--first-parent") && args.includes("--format=%H%x00%P"));
  assert.equal(windows.length, 1); assert.ok(windows[0].includes("--max-count=65"));
  const estimates = calls.filter(args => args.includes("--objects"));
  assert.equal(estimates.length, 1); assert.equal(estimates[0].filter(arg => arg.startsWith("^")).length, 65);
  assert.deepEqual((await readFile(f.updates, "utf8")).trim().split("\n").map(line => line.split(" ")[1]), [f.head]);
  assert.equal((await runGit(["rev-parse", "main"], f.remote)).trim(), f.baseOid);
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), f.head);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
});
