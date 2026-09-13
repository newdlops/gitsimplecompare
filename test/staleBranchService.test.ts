import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitError, runGit } from "../src/git/gitExec";
import { StaleBranchCleanupCancelledError, StaleBranchRemoteError, StaleBranchService } from "../src/git/staleBranchService";
import { localBranches, staleBranchFixture, unmergedBranch } from "./helpers/staleBranchFixture";

test("stale means an exact branch name absent from every live remote, including unfetched heads", async t => {
  const repo = await staleBranchFixture(t);
  const upstream = join(repo.directory, "upstream.git");
  await runGit(["clone", "--bare", repo.remote, upstream], repo.directory);
  await runGit(["remote", "add", "upstream", upstream], repo.root);
  for (const name of ["feature/unfetched", "feature/local", "tag-only", "tracked-under-another-name"]) {
    await runGit(["branch", name], repo.root);
  }
  await runGit(["update-ref", "refs/heads/feature/unfetched", repo.hash], upstream);
  await runGit(["update-ref", "refs/heads/feature/local-extra", repo.hash], upstream);
  await runGit(["tag", "tag-only", repo.hash], repo.remote);
  await runGit(["branch", "--set-upstream-to=origin/main", "tracked-under-another-name"], repo.root);
  const snapshot = await repo.service.inspect();
  assert.deepEqual(snapshot.remotes, ["origin", "upstream"]);
  assert.deepEqual(snapshot.branches.map(branch => branch.name), ["feature/local", "tag-only", "tracked-under-another-name"]);
  assert.deepEqual(snapshot.localBranches.map(branch => branch.name), ["feature/local", "feature/unfetched", "main", "tag-only", "tracked-under-another-name"]);
  assert.deepEqual(snapshot.localBranches.find(branch => branch.name === "feature/unfetched")?.matchingRemotes, ["upstream"]);
  assert.equal(snapshot.localBranches.find(branch => branch.name === "main")?.current, true);
  assert.deepEqual(snapshot.localBranches.find(branch => branch.name === "main")?.worktreePaths, [await realpath(repo.root)]);
  await assert.rejects(repo.service.cleanup(snapshot, ["feature/unfetched"], true), /selection changed/);
  assert.equal(snapshot.branches.every(branch => branch.merged && !branch.inUse), true);
  assert.equal((await runGit(["for-each-ref", "refs/remotes/upstream/"], repo.root)).trim(), "", "원격 조회가 fetch나 tracking ref 변경을 수행하지 않는다");
});

test("a deleted remote head stays stale even when a cached tracking ref and upstream remain", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["branch", "old-feature"], repo.root);
  await runGit(["push", "-u", "origin", "old-feature"], repo.root);
  await runGit(["update-ref", "-d", "refs/heads/old-feature"], repo.remote);
  assert.equal((await runGit(["rev-parse", "refs/remotes/origin/old-feature"], repo.root)).trim(), repo.hash);
  assert.deepEqual((await repo.service.inspect()).branches.map(branch => branch.name), ["old-feature"]);
});

test("no configured remotes does not classify every branch as removable", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["remote", "remove", "origin"], repo.root);
  assert.deepEqual((await repo.service.inspect()).remotes, []);
  assert.deepEqual((await repo.service.inspect()).branches, []);
  assert.deepEqual((await repo.service.inspect()).localBranches.map(branch => [branch.name, branch.remoteState, branch.current]), [["main", "unconfigured", true]]);
  assert.deepEqual(await localBranches(repo.root), ["main"]);
});

test("current and linked worktree branches remain visible as protected and cannot be selected for deletion", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["update-ref", "-d", "refs/heads/main"], repo.remote);
  await runGit(["worktree", "add", "-b", "linked", join(repo.directory, "linked tree")], repo.root);
  const snapshot = await repo.service.inspect();
  assert.deepEqual(snapshot.branches.map(branch => [branch.name, branch.inUse]), [["linked", true], ["main", true]]);
  assert.deepEqual(snapshot.localBranches.find(branch => branch.name === "linked")?.worktreePaths, [await realpath(join(repo.directory, "linked tree"))]);
  await assert.rejects(repo.service.cleanup(snapshot, ["linked"], true), /selection changed/);
  await assert.rejects(repo.service.cleanup(snapshot, ["main"], true), /selection changed/);
  assert.deepEqual(await localBranches(repo.root), ["linked", "main"]);
});

test("default cleanup deletes only selected merged branches and preserves unmerged history, working files and remote refs", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["branch", "merged"], repo.root);
  await runGit(["branch", "unselected"], repo.root);
  await unmergedBranch(repo.root, "private-work");
  await writeFile(join(repo.root, "file.txt"), "unsaved worktree changes\n");
  const beforeRemote = await runGit(["show-ref"], repo.remote);
  const result = await repo.service.cleanup(await repo.service.inspect(), ["merged", "private-work"]);
  assert.deepEqual(result.deleted.map(branch => branch.name), ["merged"]);
  assert.deepEqual(result.unmerged.map(branch => branch.name), ["private-work"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await localBranches(repo.root), ["main", "private-work", "unselected"]);
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "unsaved worktree changes\n");
  assert.equal(await runGit(["show-ref"], repo.remote), beforeRemote);
});

test("a stale upstream cannot allow unmerged history to bypass the extra force confirmation", async t => {
  const repo = await staleBranchFixture(t);
  const hash = await unmergedBranch(repo.root, "gone-upstream");
  await runGit(["push", "-u", "origin", "gone-upstream"], repo.root);
  await runGit(["update-ref", "-d", "refs/heads/gone-upstream"], repo.remote);
  const snapshot = await repo.service.inspect();
  assert.equal(snapshot.branches[0].merged, false);
  const ordinary = await repo.service.cleanup(snapshot, ["gone-upstream"]);
  assert.deepEqual(ordinary.deleted, []);
  assert.equal(ordinary.unmerged[0].hash, hash);
  const forced = await repo.service.cleanup(snapshot, ["gone-upstream"], true);
  assert.equal(forced.deleted[0].hash, hash);
  assert.deepEqual(await localBranches(repo.root), ["main"]);
});

test("a remote branch created while confirmation is open cancels deletion of that local name", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["branch", "republished"], repo.root);
  const snapshot = await repo.service.inspect();
  await runGit(["update-ref", "refs/heads/republished", repo.hash], repo.remote);
  const result = await repo.service.cleanup(snapshot, ["republished"], true);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.skipped[0].reason, "notStale");
  assert.deepEqual(await localBranches(repo.root), ["main", "republished"]);
});

test("tip movement and a new worktree between inspection and force deletion preserve both branches", async t => {
  const repo = await staleBranchFixture(t);
  for (const name of ["changed", "occupied"]) await runGit(["branch", name], repo.root);
  const snapshot = await repo.service.inspect();
  const newHash = await unmergedBranch(repo.root, "new-tip");
  await runGit(["update-ref", "refs/heads/changed", newHash], repo.root);
  await runGit(["worktree", "add", join(repo.directory, "occupied"), "occupied"], repo.root);
  const result = await repo.service.cleanup(snapshot, ["changed", "occupied"], true);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped.map(entry => entry.reason), ["changed", "inUse"]);
  assert.equal((await runGit(["rev-parse", "refs/heads/changed"], repo.root)).trim(), newHash);
});

test("a changed remote URL or a failed remote query cannot authorize any deletion", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["branch", "keep"], repo.root);
  const snapshot = await repo.service.inspect();
  const other = join(repo.directory, "other.git");
  await runGit(["init", "--bare", other], repo.directory);
  await runGit(["remote", "set-url", "origin", other], repo.root);
  await assert.rejects(repo.service.cleanup(snapshot, ["keep"], true), /Remote settings changed/);
  await runGit(["remote", "add", "offline", join(repo.directory, "missing.git")], repo.root);
  await assert.rejects(repo.service.inspect(), StaleBranchRemoteError);
  await assert.rejects(repo.service.cleanup(snapshot, ["keep"], true), StaleBranchRemoteError);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
});

test("an invalid remote response is a failed inspection, never an empty remote", async t => {
  const repo = await staleBranchFixture(t);
  const service = new StaleBranchService(repo.root, async (args, cwd, options) => {
    if (args[0] === "ls-remote") return "server returned an invalid response\n";
    return runGit(args, cwd, options);
  });
  await assert.rejects(service.inspect(), StaleBranchRemoteError);
});

test("cancelling a remote query aborts its Git process and never returns a candidate list", async t => {
  const repo = await staleBranchFixture(t);
  const cancellation = new AbortController();
  let observedAbort = false;
  const service = new StaleBranchService(repo.root, async (args, cwd, options) => {
    if (args[0] !== "ls-remote") return runGit(args, cwd, options);
    const pending = new Promise<string>((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
      observedAbort = true; reject(new Error("aborted"));
    }, { once: true }));
    cancellation.abort();
    return pending;
  });
  await assert.rejects(service.inspect(cancellation.signal), StaleBranchCleanupCancelledError);
  assert.equal(observedAbort, true);
});

test("a single failed deletion is reported separately while later selected branches are still cleaned", async t => {
  const repo = await staleBranchFixture(t);
  for (const name of ["locked", "removable"]) await runGit(["branch", name], repo.root);
  const service = new StaleBranchService(repo.root, async (args, cwd, options) => {
    if (args[0] === "branch" && args.at(-1) === "locked") throw new GitError("branch deletion failed", "cannot lock ref");
    return runGit(args, cwd, options);
  });
  const result = await service.cleanup(await service.inspect(), ["locked", "removable"]);
  assert.deepEqual(result.deleted.map(branch => branch.name), ["removable"]);
  assert.equal(result.skipped[0].reason, "failed");
  assert.deepEqual(await localBranches(repo.root), ["locked", "main"]);
});

test("snapshot repository binding and membership reject arbitrary branch deletion", async t => {
  const repo = await staleBranchFixture(t);
  await runGit(["branch", "selected"], repo.root);
  const snapshot = await repo.service.inspect();
  await assert.rejects(repo.service.cleanup({ ...snapshot, repoRoot: "elsewhere" }, ["selected"]), /repository changed/);
  await assert.rejects(repo.service.cleanup(snapshot, ["main"], true), /selection changed/);
  assert.deepEqual(await localBranches(repo.root), ["main", "selected"]);
});
