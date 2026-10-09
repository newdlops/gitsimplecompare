import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { forcePushCurrent, getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { GitError, runGit, runGitWithInput } from "../src/git/gitExec";
import {
  pushBranchCommits, SEQUENTIAL_PUSH_THRESHOLD_BYTES, SequentialPushError,
  type BranchPushTarget, type PushGitRunner, type PushProgress,
} from "../src/git/sequentialPush";
import { RemoteBranchService } from "../src/git/remoteBranchService";
import { PullRequestPublishError, PullRequestPublishService } from "../src/git/pullRequestPublishService";
import { publishErrorText } from "../src/webview/pullRequestPreviewPublish";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** shell hook에 경로를 삽입할 때 공백/작은따옴표를 문자 그대로 보존한다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** 원격에서 성공한 ref 업데이트만 기록해 실제 전송 순서와 횟수를 검증한다. */
async function recordUpdates(remote: string, directory: string): Promise<() => Promise<string[]>> {
  const file = join(directory, "received.log");
  await writeFile(join(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> ${quote(file)}\n`, { mode: 0o755 });
  return async () => (await readFile(file, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).map(line => line.split(" ")[1]);
}

/** 기본 commit 이후 서로 다른 내용의 outgoing commit을 만들고 OID를 오래된 순서로 반환한다. */
async function outgoing(root: string, count = 3): Promise<string[]> {
  const commits: string[] = [];
  for (let index = 0; index < count; index++) commits.push(await commitText(root, `commit ${index}\n`, `commit ${index}`));
  return commits;
}

/** 같은 로컬 source와 원격 ref에 대한 재사용 가능한 고정 목적지를 만든다. */
async function target(root: string, remote = "origin"): Promise<BranchPushTarget> {
  return { branch: "main", head: await git(root, "rev-parse", "HEAD"), remote, targetRef: "refs/heads/main" };
}

/** 저장소/원격/수신 로그를 한 번에 준비한다. 사용자 저장소나 실제 네트워크는 사용하지 않는다. */
async function fixture(t: TestContext, label: string, publish = true) {
  const value = await safetyFixture(t, label);
  const remote = await addOrigin(value.root, value.directory, publish);
  return { ...value, remote, updates: await recordUpdates(remote, value.directory) };
}

test("50MiB of new object data automatically pushes the outgoing commits oldest first", async t => {
  const f = await fixture(t, "push-large");
  await writeFile(join(f.root, "large.bin"), Buffer.alloc(SEQUENTIAL_PUSH_THRESHOLD_BYTES, 0x61));
  await git(f.root, "add", "large.bin");
  await git(f.root, "commit", "-qm", "large object");
  const commits = [await git(f.root, "rev-parse", "HEAD"), ...await outgoing(f.root, 2)];
  await writeFile(join(f.root, "keep.txt"), "unstaged user file\n");
  const status = await git(f.root, "status", "--porcelain");
  const index = await readFile(join(f.root, ".git/index"));
  const events: PushProgress[] = [];
  const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { onProgress: event => events.push(event) });
  assert.equal(result.execution?.strategy, "sequential");
  assert.ok(result.execution!.estimatedBytes! >= SEQUENTIAL_PUSH_THRESHOLD_BYTES);
  assert.deepEqual(await f.updates(), commits);
  assert.deepEqual(events.filter(event => event.phase === "pushing").map(event => event.completed), [0, 1, 2]);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), commits.at(-1));
  assert.equal(await git(f.root, "status", "--porcelain"), status);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
});

test("ordinary small multi-commit pushes keep a single remote update", async t => {
  const f = await fixture(t, "push-small");
  const commits = await outgoing(f.root);
  const result = await pushCurrentWithAutoUpstream(f.root);
  assert.equal(result.execution?.strategy, "single");
  assert.ok(result.execution!.estimatedBytes! < SEQUENTIAL_PUSH_THRESHOLD_BYTES);
  assert.deepEqual(await f.updates(), [commits.at(-1)]);
});

test("first publication pushes its ancestry in order and sets upstream only after every step succeeds", async t => {
  const f = await fixture(t, "push-first-sequence", false);
  const commits = [f.head, ...await outgoing(f.root)];
  const events: PushProgress[] = [];
  await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0, onProgress: event => events.push(event) });
  assert.deepEqual(await f.updates(), commits);
  assert.deepEqual(events.filter(event => event.phase === "pushed").map(event => event.completed), [1, 2, 3, 4]);
  assert.equal(await git(f.root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
});

test("a rejected middle step stops immediately and retry starts at the actual remote tip", async t => {
  const f = await fixture(t, "push-resume", false);
  const commits = [f.head, ...await outgoing(f.root)];
  const blocked = commits[2];
  await writeFile(join(f.remote, "hooks/pre-receive"), `#!/bin/sh\nwhile read old new ref; do\nif [ "$new" = "${blocked}" ]; then echo 'blocked commit' >&2; exit 1; fi\ndone\n`, { mode: 0o755 });
  const plan = await getCurrentPushPlan(f.root);
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, plan, { sequentialThresholdBytes: 0 }), error => {
    assert.ok(error instanceof SequentialPushError);
    assert.equal(error.result.completed, 2);
    assert.equal(error.result.total, 4);
    assert.equal(error.result.lastPushedCommit, commits[1]);
    assert.match(error.message, /blocked commit/);
    return true;
  });
  assert.deepEqual(await f.updates(), commits.slice(0, 2));
  await assert.rejects(git(f.root, "config", "--get", "branch.main.remote"));
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const resumed = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { sequentialThresholdBytes: 0 });
  assert.equal(resumed.execution?.total, 2);
  assert.deepEqual(await f.updates(), commits);
  assert.equal(await git(f.root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
});

test("a transport failure after a server update does not replay the acknowledged remote ancestry", async t => {
  const f = await fixture(t, "push-uncertain-ack");
  const commits = await outgoing(f.root);
  let pushes = 0;
  const runner: PushGitRunner = { input: runGitWithInput, run: async (args, root, options) => {
    const output = await runGit(args, root, options);
    if (args[0] === "push" && ++pushes === 2) throw new Error("Connection closed before acknowledgement");
    return output;
  } };
  await assert.rejects(pushBranchCommits(f.root, await target(f.root), { sequentialThresholdBytes: 0 }, runner), error => {
    assert.ok(error instanceof SequentialPushError);
    assert.equal(error.result.completed, 1);
    return true;
  });
  assert.equal(await git(f.remote, "rev-parse", "main"), commits[1]);
  await pushBranchCommits(f.root, await target(f.root), { sequentialThresholdBytes: 0 });
  assert.deepEqual(await f.updates(), commits);
});

test("an explicit lease protects another writer advancing the remote between steps", async t => {
  const f = await fixture(t, "push-concurrent-remote");
  const commits = await outgoing(f.root);
  const tree = await git(f.root, "rev-parse", `${commits[0]}^{tree}`);
  const concurrent = await git(f.root, "commit-tree", tree, "-p", commits[0], "-m", "another writer");
  await git(f.remote, "fetch", "-q", f.root, concurrent);
  let pushes = 0;
  const runner: PushGitRunner = { input: runGitWithInput, run: async (args, root, options) => {
    if (args[0] === "push") {
      assert.equal(options?.retryOnLock, false);
      if (++pushes === 2) await git(f.remote, "update-ref", "refs/heads/main", concurrent, commits[0]);
    }
    return runGit(args, root, options);
  } };
  await assert.rejects(pushBranchCommits(f.root, await target(f.root), { sequentialThresholdBytes: 0 }, runner), error => {
    assert.ok(error instanceof SequentialPushError);
    assert.equal(error.result.completed, 1);
    assert.match(error.message, /stale info|rejected/);
    return true;
  });
  assert.equal(pushes, 2);
  assert.equal(await git(f.remote, "rev-parse", "main"), concurrent);
  assert.deepEqual(await f.updates(), [commits[0]]);
});

test("cancellation after one completed step never starts the next push or changes upstream", async t => {
  const f = await fixture(t, "push-cancel", false);
  await outgoing(f.root);
  const controller = new AbortController();
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, undefined, {
    sequentialThresholdBytes: 0, signal: controller.signal,
    onProgress: event => { if (event.phase === "pushed") controller.abort(); },
  }), error => {
    assert.ok(error instanceof SequentialPushError && error.cancelled);
    assert.equal(error.result.completed, 1);
    return true;
  });
  assert.deepEqual(await f.updates(), [f.head]);
  await assert.rejects(git(f.root, "config", "--get", "branch.main.remote"));
});

test("a pre-push hook changing local commits invalidates the remaining sequence", async t => {
  const f = await fixture(t, "push-changing-head");
  const commits = await outgoing(f.root);
  await writeFile(join(f.directory, "hooks/pre-push"), "#!/bin/sh\ngit -c core.hooksPath=/dev/null commit --allow-empty -qm 'unapproved new commit'\n", { mode: 0o755 });
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 }), error => {
    assert.ok(error instanceof SequentialPushError);
    assert.equal(error.result.completed, 1);
    assert.match(error.message, /changed after confirmation/);
    return true;
  });
  assert.deepEqual(await f.updates(), [commits[0]]);
  assert.notEqual(await git(f.root, "rev-parse", "HEAD"), commits.at(-1));
});

test("a destination change after one completed step cannot redirect later commits", async t => {
  const f = await fixture(t, "push-changing-remote");
  const commits = await outgoing(f.root);
  const other = join(f.directory, "other.git");
  await git(f.directory, "init", "--bare", "-q", other);
  let completed = false;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, undefined, {
    sequentialThresholdBytes: 0, onProgress: event => { if (event.phase === "pushed") completed = true; },
    beforePush: async () => { if (completed) await git(f.root, "remote", "set-url", "origin", other); },
  }), /changed after confirmation/);
  assert.deepEqual(await f.updates(), [commits[0]]);
  assert.equal(await git(other, "for-each-ref", "--format=%(refname)"), "");
});

/** 한 단계의 hook이 checkout을 바꿔도 다음 단계는 고정 branch/HEAD 표시를 다시 확인한다. */
for (const checkout of ["branch", "detached"] as const) {
  test(`a ${checkout} checkout change between steps stops the remaining current-branch push`, async t => {
    const f = await fixture(t, "push-switch-" + checkout);
    await git(f.root, "branch", "other");
    const commits = await outgoing(f.root);
    await writeFile(join(f.directory, "hooks/pre-push"), "#!/bin/sh\ngit switch --quiet " +
      (checkout === "branch" ? "other" : "--detach HEAD") + "\n", { mode: 0o755 });
    await assert.rejects(pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 }), error => {
      assert.ok(error instanceof SequentialPushError);
      assert.equal(error.result.completed, 1);
      assert.match(error.message, /changed after confirmation/);
      return true;
    });
    assert.deepEqual(await f.updates(), [commits[0]]);
  });
}

test("a destination change at planning cannot replace the approved configuration fingerprint", async t => {
  const f = await fixture(t, "push-approved-fingerprint");
  await outgoing(f.root);
  const other = join(f.directory, "unapproved.git"); await git(f.directory, "init", "--bare", "-q", other);
  let change: Promise<unknown> | undefined;
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, undefined, {
    sequentialThresholdBytes: 0,
    onProgress: event => { if (event.phase === "planning") change = git(f.root, "remote", "set-url", "origin", other); },
    beforePush: async () => { await change; },
  }), /changed after confirmation/);
  assert.deepEqual(await f.updates(), []);
  assert.equal(await git(other, "for-each-ref", "--format=%(refname)"), "");
});

test("merge histories advance along the first-parent chain without force-rewriting side branches", async t => {
  const f = await fixture(t, "push-merge");
  await git(f.root, "switch", "-qc", "topic");
  for (let index = 0; index < 3; index++) await git(f.root, "commit", "--allow-empty", "-qm", `side ${index}`);
  const sideHead = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-q", "main");
  const first = await commitText(f.root, "main change\n", "main change");
  await git(f.root, "merge", "--no-ff", "topic", "-m", "merge topic");
  const merge = await git(f.root, "rev-parse", "HEAD");
  const last = await commitText(f.root, "after merge\n", "after merge");
  await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 });
  assert.deepEqual(await f.updates(), [first, merge, last]);
  assert.equal(await git(f.root, "rev-parse", "topic"), sideHead);
  await git(f.remote, "merge-base", "--is-ancestor", sideHead, "main");
});

test("a remote tip on the merge second parent skips first-parent commits that would rewind the destination", async t => {
  const f = await fixture(t, "push-second-parent");
  await git(f.root, "switch", "-qc", "topic");
  await git(f.root, "commit", "--allow-empty", "-qm", "remote side");
  await git(f.root, "push", "-q", "origin", "HEAD:main");
  await git(f.root, "switch", "-q", "main");
  await commitText(f.root, "local side\n", "local side");
  await git(f.root, "merge", "--no-ff", "topic", "-m", "integrate remote");
  const merge = await git(f.root, "rev-parse", "HEAD");
  const after = await outgoing(f.root, 2);
  const result = await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 });
  assert.equal(result.execution?.strategy, "sequential");
  assert.deepEqual((await f.updates()).slice(1), [merge, ...after]);
});

test("push URL is used for planning when the fetch destination is different", async t => {
  const f = await fixture(t, "push-url");
  const other = join(f.directory, "push-only.git");
  await git(f.directory, "init", "--bare", "-q", other);
  await git(f.root, "remote", "set-url", "--push", "origin", other);
  const otherUpdates = await recordUpdates(other, join(other, "hooks"));
  const commits = [f.head, ...await outgoing(f.root)];
  await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 });
  assert.deepEqual(await otherUpdates(), commits);
  assert.equal(await git(f.remote, "rev-parse", "main"), f.head);
});

test("restoring a gone upstream does not invalidate the remaining approved sequence", async t => {
  const f = await fixture(t, "push-gone-upstream");
  await git(f.remote, "config", "receive.denyDeleteCurrent", "ignore");
  await git(f.root, "push", "origin", "--delete", "main");
  const commits = [f.head, ...await outgoing(f.root)];
  const plan = await getCurrentPushPlan(f.root);
  assert.equal(plan.mode, "setUpstream");
  await pushCurrentWithAutoUpstream(f.root, plan, { sequentialThresholdBytes: 0 });
  assert.deepEqual((await f.updates()).slice(1), commits);
});

test("a single outgoing commit and an already published tip use ordinary push", async t => {
  const f = await fixture(t, "push-one");
  const [head] = await outgoing(f.root, 1);
  assert.equal((await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 })).execution?.strategy, "single");
  assert.equal((await pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 })).execution?.strategy, "single");
  assert.deepEqual(await f.updates(), [head]);
});

test("explicit force pushes remain a single approved update", async t => {
  const f = await fixture(t, "push-force-single");
  const commits = await outgoing(f.root);
  await forcePushCurrent(f.root, "forceWithLease");
  assert.deepEqual(await f.updates(), [commits.at(-1)]);
});

test("remote-branch publication and PR publication share the sequential push service", async t => {
  const f = await fixture(t, "push-publish-paths", false);
  const commits = [f.head, ...await outgoing(f.root)];
  await new RemoteBranchService(f.root).pushCurrentBranchToRemote("origin", "published", { sequentialThresholdBytes: 0 });
  assert.deepEqual(await f.updates(), commits);
  await new PullRequestPublishService(f.root).publishBranch("main", "origin", "pr-branch", { sequentialThresholdBytes: 0 });
  assert.deepEqual(await f.updates(), [...commits, ...commits]);
  assert.equal(await git(f.root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/pr-branch");
});

test("remote inspection errors never expose push URL credentials", async t => {
  const f = await fixture(t, "push-secret-error");
  const secretUrl = "https://private-user:secret-password@example.test/repo.git";
  const runner: PushGitRunner = { input: runGitWithInput, run: async (args, root, options) => {
    if (args[0] === "remote" && args[1] === "get-url") return secretUrl;
    if (args[0] === "ls-remote") throw new GitError(`failure: ${secretUrl}`, secretUrl);
    return runGit(args, root, options);
  } };
  await assert.rejects(pushBranchCommits(f.root, await target(f.root), {}, runner), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /authentication/);
    assert.equal(JSON.stringify(error).includes("secret-password"), false);
    assert.equal(error.message.includes("secret-password"), false);
    return true;
  });
  assert.deepEqual(await f.updates(), []);
});

test("publication keeps git push -u semantics when the target is excluded from the fetch refspec", async t => {
  const f = await fixture(t, "push-narrow-fetch");
  await git(f.root, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  const commits = await outgoing(f.root);
  await new RemoteBranchService(f.root).pushCurrentBranchToRemote("origin", "release", { sequentialThresholdBytes: 0 });
  assert.equal(await git(f.remote, "rev-parse", "release"), commits.at(-1));
  assert.equal(await git(f.root, "config", "--get", "branch.main.remote"), "origin");
  assert.equal(await git(f.root, "config", "--get", "branch.main.merge"), "refs/heads/release");
});

test("a partial PR push preserves the new local commit and reports remote progress without creating a PR", async t => {
  const f = await fixture(t, "push-partial-pr");
  const commits = await outgoing(f.root);
  await writeFile(join(f.root, "staged.txt"), "staged PR changes\n");
  await git(f.root, "add", "staged.txt");
  await writeFile(join(f.remote, "hooks/pre-receive"), `#!/bin/sh\nwhile read old new ref; do\nif [ "$new" = "${commits[1]}" ]; then exit 1; fi\ndone\n`, { mode: 0o755 });
  const service = new PullRequestPublishService(f.root);
  t.mock.method(service, "inspect", async () => ({
    sourceBranch: "main", targetBranch: "base", targetRef: f.head, sourceIsLocal: true,
    currentBranch: "main", stagedFileCount: 1, unstagedFileCount: 0, commitsAhead: 3,
    remotes: [{ name: "origin", branch: "main", recommended: true }],
  }));
  t.mock.method(service as any, "assertNoOpenPullRequest", async () => {});
  const create = t.mock.method(service, "createPullRequest", async () => "unreachable");
  await assert.rejects(service.publishPreview({
    sourceBranch: "main", targetBranch: "base", remote: "origin", title: "PR", body: "", draft: false, commitMessage: "staged PR commit",
  }, { sequentialThresholdBytes: 0 }), error => {
    assert.ok(error instanceof PullRequestPublishError);
    assert.equal(error.committed, true);
    assert.equal(error.pushed, false);
    assert.ok(error.originalError instanceof SequentialPushError);
    assert.equal(error.originalError.result.completed, 1);
    assert.match(publishErrorText(error), /1\/4.*remain on the remote/);
    assert.match(publishErrorText(error), /committed locally/);
    assert.doesNotMatch(publishErrorText(error), /nothing was pushed/);
    return true;
  });
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(await f.updates(), [commits[0]]);
  assert.equal(await git(f.root, "show", "HEAD:staged.txt"), "staged PR changes");
});

for (const rewrite of ["replace", "graft"] as const) {
  test(`${rewrite} ancestry cannot turn an ordinary sequential push into a remote history rewrite`, async t => {
    const f = await fixture(t, `push-raw-${rewrite}`);
    const tree = await git(f.root, "rev-parse", `${f.head}^{tree}`);
    const unrelated = await git(f.root, "commit-tree", tree, "-m", "unrelated remote history");
    await git(f.root, "push", "--force", "origin", `${unrelated}:refs/heads/main`);
    await outgoing(f.root);
    if (rewrite === "replace") await git(f.root, "replace", "--graft", f.head, unrelated);
    else {
      await mkdir(join(f.root, ".git/info"), { recursive: true });
      await writeFile(join(f.root, ".git/info/grafts"), `${f.head} ${unrelated}\n`);
    }
    await assert.rejects(pushBranchCommits(f.root, await target(f.root), { sequentialThresholdBytes: 0 }), /non-fast-forward|rejected/);
    assert.equal(await git(f.remote, "rev-parse", "main"), unrelated);
  });
}
