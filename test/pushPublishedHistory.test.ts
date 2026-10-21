import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { SEQUENTIAL_PUSH_THRESHOLD_BYTES, SequentialPushError } from "../src/git/sequentialPush";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 수신 hook의 기록 경로를 shell에 리터럴로 전달한다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** post-receive hook으로 실제 Native push의 성공한 목적 ref 변경만 수집한다. */
async function receiveLog(remote: string, directory: string) {
  const file = join(directory, "received");
  await mkdir(join(remote, "hooks"), { recursive: true });
  await git(remote, "config", "core.hooksPath", join(remote, "hooks"));
  await writeFile(join(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> ${quote(file)}\n`, { mode: 0o755 });
  return async () => (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => line.split(" ")[1]);
}

/** 기본 이력을 게시한 뒤 그 위의 새 feature commit 세 개만 아직 게시하지 않은 상태를 만든다. */
async function fixture(t: TestContext, largeFeature = false, actualLargeBase = false) {
  const f = await safetyFixture(t, "push-published-history");
  if (actualLargeBase) {
    const file = join(f.root, "published-large.bin"); await writeFile(file, "");
    // sparse 파일로 실제 50MiB objectsize 경계를 검증하되 Node에 큰 Buffer를 만들지 않는다.
    await truncate(file, SEQUENTIAL_PUSH_THRESHOLD_BYTES);
    await git(f.root, "add", "published-large.bin"); await git(f.root, "commit", "-qm", "published large data");
  } else {
    const lines: string[] = [];
    for (let index = 1; index <= 32; index++) lines.push(`commit refs/heads/main\nmark :${index}\ncommitter Published <published@example.test> 1700000000 +0000\ndata 10\npublished\nfrom ${index === 1 ? f.head : `:${index - 1}`}\n\n`);
    await runGitWithInput(["fast-import", "--quiet"], f.root, lines.join(""));
    await git(f.root, "reset", "--hard", "main");
  }
  const base = await git(f.root, "rev-parse", "HEAD"), remote = await addOrigin(f.root, f.directory);
  const updates = await receiveLog(remote, f.directory);
  await git(f.root, "switch", "-qc", "feature");
  const commits: string[] = [];
  for (let index = 0; index < 3; index++) commits.push(await commitText(f.root,
    largeFeature && index === 0 ? "large new change\n".repeat(1024) : `feature ${index}\n`, `feature ${index}`));
  return { ...f, base, remote, updates, commits, tip: commits.at(-1)! };
}

test("a new branch counts only unpublished objects and preserves staged, unstaged and untracked work", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "tracked.txt"), "staged work\n"); await git(f.root, "add", "tracked.txt");
  await writeFile(join(f.root, "tracked.txt"), "unstaged work\n"); await writeFile(join(f.root, "keep.txt"), "untracked\n");
  const index = await readFile(join(f.root, ".git/index")), status = await git(f.root, "status", "--porcelain=v1");
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { sequentialThresholdBytes: 2048 });
  assert.equal(result.execution?.strategy, "single"); assert.equal(result.execution.total, 1);
  assert.ok(result.execution.estimatedBytes! < 2048);
  assert.deepEqual(await f.updates(), [f.tip]);
  assert.equal(await git(f.remote, "rev-parse", "main"), f.base);
  assert.equal(await git(f.root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/feature");
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
  assert.equal(await git(f.root, "status", "--porcelain=v1"), status);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "unstaged work\n");
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "untracked\n");
});

test("a real 50MiB object already published on main does not split three tiny new commits", async t => {
  const f = await fixture(t, false, true);
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root));
  assert.equal(result.execution?.strategy, "single"); assert.ok(result.execution.estimatedBytes! < SEQUENTIAL_PUSH_THRESHOLD_BYTES);
  assert.deepEqual(await f.updates(), [f.tip]);
  assert.equal(await git(f.remote, "rev-parse", "main"), f.base);
  assert.equal(await git(f.remote, "show", "feature:tracked.txt"), "feature 2");
  assert.equal(calls.filter(args => args[gitCommandIndex(args)] === "ls-remote").length, 1, "Destination and published tips share one actual-server advertisement");
  const estimates = calls.filter(args => args.includes("--objects"));
  assert.equal(estimates.length, 1, "The already-published full history must not be estimated first");
  assert.ok(estimates[0].includes(`^${f.base}`), "The only object walk must exclude the server-verified base");
});

test("genuinely new large objects split only the three new commits and keep the destination's empty lease", async t => {
  const f = await fixture(t, true), pushes: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[1][gitCommandIndex(args[1])] === "push") pushes.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { sequentialThresholdBytes: 2048 });
  assert.equal(result.execution?.strategy, "sequential"); assert.equal(result.execution.total, 3);
  assert.ok(result.execution.estimatedBytes! >= 2048);
  assert.deepEqual(await f.updates(), f.commits);
  assert.deepEqual(pushes.map(args => args.find(arg => arg.startsWith("--force-with-lease="))),
    ["", ...f.commits.slice(0, -1)].map(oid => `--force-with-lease=refs/heads/feature:${oid}`));
  assert.equal(await git(f.remote, "rev-parse", "main"), f.base);
});

test("the push URL's published history is not replaced by the fetch remote's newer tracking state", async t => {
  const f = await fixture(t), other = join(f.directory, "push.git");
  await git(f.directory, "init", "--bare", "-q", other);
  await git(other, "fetch", "-q", f.root, `${f.head}:refs/heads/main`);
  await git(f.root, "remote", "set-url", "--push", "origin", other);
  let ready = false, total = 0;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048, onProgress: event => { if (event.phase === "ready") { ready = true; total = event.total; } },
    beforePush: async () => { if (ready) throw new Error("stop after verifying the actual server boundary"); },
  }), /stop after verifying/);
  assert.equal(total, Number(await git(f.root, "rev-list", "--count", `${f.head}..${f.tip}`)));
  assert.ok(total > 3, "the actual push server lacks the intermediate published main history");
  assert.equal(await git(other, "for-each-ref", "--format=%(refname)", "refs/heads/feature"), "");
  assert.equal(await git(f.remote, "for-each-ref", "--format=%(refname)", "refs/heads/feature"), "");
  assert.equal(await git(f.remote, "rev-parse", "main"), f.base);
});

test("unknown and non-commit advertised objects are not fetched or used as published commit proof", async t => {
  const f = await fixture(t);
  const unknown = await git(f.remote, "-c", "user.name=Remote", "-c", "user.email=remote@example.test", "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "remote-only");
  await git(f.remote, "update-ref", "refs/heads/remote-only", unknown);
  const blob = await git(f.root, "rev-parse", `${f.base}:tracked.txt`);
  await writeFile(join(f.remote, "refs/heads/blob-tip"), blob + "\n");
  await assert.rejects(git(f.root, "cat-file", "-e", unknown));
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { sequentialThresholdBytes: 2048 });
  assert.equal(result.execution?.strategy, "single"); assert.deepEqual(await f.updates(), [f.tip]);
  await assert.rejects(git(f.root, "cat-file", "-e", unknown));
  assert.equal(await git(f.remote, "rev-parse", "refs/heads/remote-only"), unknown);
  assert.equal(await git(f.remote, "rev-parse", "refs/heads/blob-tip"), blob);
});

test("a concurrent creation of the destination is rejected without leasing against the shared main tip", async t => {
  const f = await fixture(t, true);
  let ready = false, created = false;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), {
    sequentialThresholdBytes: 2048, onProgress: event => { if (event.phase === "ready") ready = true; },
    beforePush: async () => { if (ready && !created) { created = true; await git(f.remote, "update-ref", "refs/heads/feature", f.base); } },
  }), error => {
    assert.ok(error instanceof SequentialPushError); assert.equal(error.result.completed, 0); assert.equal(error.result.total, 3);
    assert.match(error.message, /stale info|rejected/); return true;
  });
  assert.equal(created, true); assert.equal(await git(f.remote, "rev-parse", "feature"), f.base);
  assert.deepEqual(await f.updates(), []);
  await assert.rejects(git(f.root, "config", "--get", "branch.feature.remote"));
});
