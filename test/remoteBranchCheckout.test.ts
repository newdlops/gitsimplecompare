import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { runGit } from "../src/git/gitExec";
import { GitGraphActionService } from "../src/git/gitGraphActionService";
import { GitLogService } from "../src/git/gitLogService";
import { GitService } from "../src/git/gitService";
import { checkoutRemoteBranch } from "../src/webview/graphBranchActions";
import {
  __informationMessages,
  __resetWindowMessages,
  __setWarningMessageResult,
  __warningMessages,
} from "./helpers/vscodeMock";

/** 실제 Git checkout과 ref 보존을 검증할 임시 저장소 및 주요 commit 정보다. */
interface CheckoutFixture {
  root: string;
  localHash: string;
  remoteHash: string;
  shortHash: string;
  localShortHash: string;
  service: GitLogService;
}

/**
 * 서로 다른 커밋의 master와 origin/master를 가진 임시 저장소를 만든다.
 * @param t 종료 시 임시 파일과 VS Code 알림 대역을 정리할 테스트 컨텍스트
 * @returns master가 checkout된 저장소와 로컬/원격 tip 정보
 */
async function fixture(t: TestContext): Promise<CheckoutFixture> {
  const root = await mkdtemp(join(tmpdir(), "gsc-remote-checkout-"));
  t.after(async () => {
    __resetWindowMessages();
    await rm(root, { recursive: true, force: true });
  });
  __resetWindowMessages();
  await runGit(["init", "-b", "master"], root);
  await runGit(["config", "user.name", "Checkout Test"], root);
  await runGit(["config", "user.email", "checkout@example.test"], root);
  await runGit(["config", "commit.gpgsign", "false"], root);
  await runGit(["config", "core.hooksPath", "/dev/null"], root);
  await writeFile(join(root, "file.txt"), "local version\n");
  await runGit(["add", "file.txt"], root);
  await runGit(["commit", "-m", "local"], root);
  const localHash = (await runGit(["rev-parse", "HEAD"], root)).trim();
  const localShortHash = (await runGit(["rev-parse", "--short=7", "HEAD"], root)).trim();
  await runGit(["switch", "-c", "incoming"], root);
  await writeFile(join(root, "file.txt"), "remote version\n");
  await runGit(["commit", "-am", "remote"], root);
  const remoteHash = (await runGit(["rev-parse", "HEAD"], root)).trim();
  const shortHash = (await runGit(["rev-parse", "--short=7", "HEAD"], root)).trim();
  await runGit(["remote", "add", "origin", "."], root);
  await runGit(["update-ref", "refs/remotes/origin/master", remoteHash], root);
  await runGit(["switch", "master"], root);
  return { root, localHash, remoteHash, shortHash, localShortHash, service: new GitLogService(root) };
}

/**
 * 생성된 branch의 checkout 위치, upstream, 기존 master 보존을 Git으로 직접 확인한다.
 * @param repo checkout을 실행한 테스트 저장소
 * @param name 새로 생성돼 현재 checkout되어야 할 로컬 branch 이름
 * @param upstream 새 branch가 추적해야 할 원격 short ref
 * @param preservedMaster 기존 master가 보존되어야 할 이름. 생략하면 기본 stale 이름을 사용한다.
 */
async function assertCheckout(
  repo: CheckoutFixture,
  name: string,
  upstream = "origin/master",
  preservedMaster = `master-stale-${repo.localShortHash}`
): Promise<void> {
  assert.equal(
    (await runGit(["branch", "--show-current"], repo.root)).trim(),
    name
  );
  assert.equal(
    (await runGit(["rev-parse", "HEAD"], repo.root)).trim(),
    repo.remoteHash
  );
  assert.equal(
    (await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], repo.root)).trim(),
    upstream
  );
  assert.equal(
    (await runGit(["rev-parse", `refs/heads/${name === "master" ? preservedMaster : "master"}`], repo.root)).trim(),
    repo.localHash
  );
  assert.equal(
    await readFile(join(repo.root, "file.txt"), "utf8"),
    "remote version\n"
  );
}

test("remote checkout archives the existing current master using its own hash and gives the new branch the original name", async (t) => {
  const repo = await fixture(t);
  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, "master");
  await assertCheckout(repo, name);
});

test("repeated remote checkout uses numbered stale names without moving previous archived tips", async (t) => {
  const repo = await fixture(t);
  const base = `master-stale-${repo.localShortHash}`;
  await runGit(["branch", base, repo.localHash], repo.root);
  await runGit(["branch", `${base}-2`, repo.localHash], repo.root);

  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), "master");
  await assertCheckout(repo, "master", "origin/master", `${base}-3`);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(), repo.localHash);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}-2`], repo.root)).trim(), repo.localHash);
  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), "master");
  await assertCheckout(repo, "master", "origin/master", `${base}-3`);
  const remoteArchive = `master-stale-${repo.shortHash}`;
  assert.equal((await runGit(["rev-parse", `refs/heads/${remoteArchive}`], repo.root)).trim(), repo.remoteHash);
  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), "master");
  assert.equal((await runGit(["rev-parse", `refs/heads/${remoteArchive}-2`], repo.root)).trim(), repo.remoteHash);
});

test("remote checkout keeps the unsuffixed branch name when it is available", async (t) => {
  const repo = await fixture(t);
  await runGit(["update-ref", "refs/remotes/origin/topic", repo.remoteHash], repo.root);
  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/topic");
  assert.equal(name, "topic");
  await assertCheckout(repo, name, "origin/topic");
});

test("graph confirmation creates the remote snapshot instead of switching to the existing local branch", async (t) => {
  const repo = await fixture(t);
  let refreshed = 0;
  __setWarningMessageResult("Create and Checkout");
  await checkoutRemoteBranch({
    logService: repo.service,
    refreshCheckout: async () => { refreshed++; },
    refreshGraph: async () => { throw new Error("clean checkout must not enter conflict refresh"); },
  }, "origin/master");

  const name = "master";
  await assertCheckout(repo, name);
  assert.deepEqual(__warningMessages, [
    `Rename existing local branch 'master' to 'master-stale-${repo.localShortHash}', then create 'master' from 'origin/master' and checkout?`,
  ]);
  assert.deepEqual(__informationMessages, [`Branch '${name}' created and checked out.`]);
  assert.equal(refreshed, 1);
});

test("nested branch names and non-origin upstreams retain their exact tracking target", async (t) => {
  const repo = await fixture(t);
  await runGit(["remote", "add", "upstream", "."], repo.root);
  await runGit(["branch", "feature/review", repo.localHash], repo.root);
  await runGit(["update-ref", "refs/remotes/upstream/feature/review", repo.remoteHash], repo.root);

  const name = await repo.service.checkoutRemoteBranchAsLocal("upstream/feature/review");
  assert.equal(name, "feature/review");
  await assertCheckout(repo, name, "upstream/feature/review");
  assert.equal(
    (await runGit(["rev-parse", `refs/heads/feature/review-stale-${repo.localShortHash}`], repo.root)).trim(),
    repo.localHash
  );
});

test("packed local refs also reserve stale branch names", async (t) => {
  const repo = await fixture(t);
  const base = `master-stale-${repo.localShortHash}`;
  await runGit(["branch", base, repo.localHash], repo.root);
  await runGit(["pack-refs", "--all", "--prune"], repo.root);

  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), "master");
  await assertCheckout(repo, "master", "origin/master", `${base}-2`);
  assert.equal(
    (await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(),
    repo.localHash
  );
});

test("an existing master in another dirty worktree is renamed without changing its HEAD or files", async (t) => {
  const repo = await fixture(t);
  const otherWorktree = join(repo.root, "other-worktree");
  await runGit(["switch", "incoming"], repo.root);
  await runGit(["worktree", "add", otherWorktree, "master"], repo.root);
  await writeFile(join(otherWorktree, "file.txt"), "linked worktree edit\n");

  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, "master");
  await assertCheckout(repo, name);
  assert.equal((await runGit(["branch", "--show-current"], otherWorktree)).trim(), `master-stale-${repo.localShortHash}`);
  assert.equal((await runGit(["rev-parse", "HEAD"], otherWorktree)).trim(), repo.localHash);
  assert.equal(await readFile(join(otherWorktree, "file.txt"), "utf8"), "linked worktree edit\n");
});

test("dirty checkout failure restores the old name and merge retry preserves both branch tips", async (t) => {
  const repo = await fixture(t);
  const name = "master";
  const staleName = `master-stale-${repo.localShortHash}`;
  let invalidations = 0;
  const actions = new GitGraphActionService(repo.root, () => { invalidations++; });
  await writeFile(join(repo.root, "file.txt"), "uncommitted edit\n");

  await assert.rejects(actions.checkoutRemoteBranchAsLocal("origin/master"), /overwritten|local changes/i);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "uncommitted edit\n");
  await assert.rejects(runGit(["show-ref", "--verify", `refs/heads/${staleName}`], repo.root));
  assert.equal((await runGit(["rev-parse", "refs/heads/master"], repo.root)).trim(), repo.localHash);

  assert.equal(await actions.checkoutRemoteBranchAsLocal("origin/master", true), name);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), name);
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.remoteHash);
  assert.equal((await runGit(["rev-parse", `refs/heads/${staleName}`], repo.root)).trim(), repo.localHash);
  assert.equal((await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], repo.root)).trim(), "origin/master");
  const conflicted = await readFile(join(repo.root, "file.txt"), "utf8");
  assert.match(conflicted, /<<<<<<<|=======|>>>>>>>/);
  assert.match(conflicted, /uncommitted edit/);
  assert.match(conflicted, /remote version/);
  assert.equal(invalidations, 2, "실패한 일반 checkout과 충돌을 남긴 merge checkout 모두 cache를 무효화한다");
});

test("missing remote refs fail without creating a branch or changing the existing checkout", async (t) => {
  const repo = await fixture(t);
  const before = await runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], repo.root);
  await runGit(["update-ref", "-d", "refs/remotes/origin/master"], repo.root);

  await assert.rejects(repo.service.checkoutRemoteBranchAsLocal("origin/master"));
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.localHash);
  assert.equal(await runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], repo.root), before);
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "local version\n");
});

test("canceling graph confirmation does not create a branch or trigger a refresh", async (t) => {
  const repo = await fixture(t);
  const before = await runGit(["for-each-ref", "--format=%(refname)", "refs/heads"], repo.root);
  let refreshed = 0;
  await checkoutRemoteBranch({
    logService: repo.service,
    refreshCheckout: async () => { refreshed++; },
    refreshGraph: async () => { refreshed++; },
  }, "origin/master");

  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal(await runGit(["for-each-ref", "--format=%(refname)", "refs/heads"], repo.root), before);
  assert.match(__warningMessages[0], new RegExp(`master-stale-${repo.localShortHash}`));
  assert.deepEqual(__informationMessages, []);
  assert.equal(refreshed, 0);
});

test("a stale name taken during graph confirmation is rechecked while the new branch keeps its name", async (t) => {
  const repo = await fixture(t);
  const base = `master-stale-${repo.localShortHash}`;
  let confirmations = 0;
  t.mock.method(vscode.window, "showWarningMessage", async (message: string) => {
    confirmations++;
    assert.equal(message, `Rename existing local branch 'master' to '${base}', then create 'master' from 'origin/master' and checkout?`);
    await runGit(["branch", base, repo.localHash], repo.root);
    return "Create and Checkout";
  });

  await checkoutRemoteBranch({
    logService: repo.service,
    refreshCheckout: async () => undefined,
    refreshGraph: async () => undefined,
  }, "origin/master");

  await assertCheckout(repo, "master", "origin/master", `${base}-2`);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(), repo.localHash);
  assert.deepEqual(__informationMessages, ["Branch 'master' created and checked out."]);
  assert.equal(confirmations, 1);
});

test("checkout invalidates cached branch pickers so the generated branch becomes current", async (t) => {
  const repo = await fixture(t);
  const comparison = new GitService(repo.root);
  const before = await comparison.listBranches(true);
  assert.equal(before.find((branch) => branch.isCurrent)?.name, "master");
  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  const after = await comparison.listBranches(true);

  assert.equal(after.find((branch) => branch.isCurrent)?.name, name);
  assert.equal(after.find((branch) => branch.name === "master")?.isCurrent, true);
  assert.equal(after.find((branch) => branch.name === `master-stale-${repo.localShortHash}`)?.isCurrent, false);
  assert.equal(after.some((branch) => branch.name === "origin/master" && branch.kind === "remote"), true);
});

test("an existing upstream and a similarly named tag do not redirect the remote checkout", async (t) => {
  const repo = await fixture(t);
  await runGit(["branch", "--set-upstream-to=origin/master", "master"], repo.root);
  await runGit(["tag", "origin/master", repo.localHash], repo.root);

  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, "master");
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.remoteHash);
  assert.equal(
    (await runGit(["rev-parse", "--symbolic-full-name", "@{upstream}"], repo.root)).trim(),
    "refs/remotes/origin/master"
  );
  assert.equal((await runGit(["config", "branch.master.remote"], repo.root)).trim(), "origin");
  assert.equal((await runGit(["config", "branch.master.merge"], repo.root)).trim(), "refs/heads/master");
  const stale = `master-stale-${repo.localShortHash}`;
  assert.equal((await runGit(["rev-parse", `refs/heads/${stale}`], repo.root)).trim(), repo.localHash);
  assert.equal((await runGit(["config", `branch.${stale}.remote`], repo.root)).trim(), "origin");
  assert.equal((await runGit(["config", `branch.${stale}.merge`], repo.root)).trim(), "refs/heads/master");
  assert.equal((await runGit(["rev-parse", "refs/tags/origin/master"], repo.root)).trim(), repo.localHash);
});

test("previewing a generated checkout name is repeatable and leaves the repository unchanged", async (t) => {
  const repo = await fixture(t);
  const beforeRefs = await runGit(
    ["for-each-ref", "--format=%(refname) %(objectname)"], repo.root
  );
  const beforeStatus = await runGit(["status", "--porcelain"], repo.root);
  const name = "master";

  assert.equal(await repo.service.getRemoteBranchCheckoutName("origin/master"), name);
  assert.equal(await repo.service.getRemoteBranchCheckoutName("origin/master"), name);
  assert.deepEqual((await repo.service.getRemoteBranchCheckoutPlan("origin/master")).staleBranch, {
    name: `master-stale-${repo.localShortHash}`, hash: repo.localHash,
  });
  assert.equal(
    await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], repo.root),
    beforeRefs
  );
  assert.equal(await runGit(["status", "--porcelain"], repo.root), beforeStatus);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "local version\n");
});

test("ordinary local checkout retains branch names and commits", async (t) => {
  const repo = await fixture(t);
  const before = await runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], repo.root);
  await repo.service.checkoutLocalBranch("incoming");
  await repo.service.checkoutLocalBranch("master");
  assert.equal(await runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], repo.root), before);
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.localHash);
});

test("stale names also avoid ref directory collisions", async (t) => {
  const repo = await fixture(t);
  const base = `master-stale-${repo.localShortHash}`;
  await runGit(["branch", `${base}/child`, repo.localHash], repo.root);
  await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  await assertCheckout(repo, "master", "origin/master", `${base}-2`);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}/child`], repo.root)).trim(), repo.localHash);
});

test("simultaneous remote checkouts serialize archival instead of overwriting branches", async (t) => {
  const repo = await fixture(t);
  assert.deepEqual(await Promise.all([
    repo.service.checkoutRemoteBranchAsLocal("origin/master"),
    new GitLogService(repo.root).checkoutRemoteBranchAsLocal("origin/master"),
  ]), ["master", "master"]);
  await assertCheckout(repo, "master");
  assert.equal((await runGit(["rev-parse", `refs/heads/master-stale-${repo.shortHash}`], repo.root)).trim(), repo.remoteHash);
});

test("a failed post-checkout hook preserves the completed checkout and runs only once", { skip: process.platform === "win32" }, async (t) => {
  const repo = await fixture(t);
  const hooks = join(repo.root, ".git", "hooks");
  await runGit(["config", "core.hooksPath", hooks], repo.root);
  const counter = join(repo.root, ".git", "checkout-hook-count");
  await writeFile(join(hooks, "post-checkout"), "#!/bin/sh\nprintf 'run\\n' >> .git/checkout-hook-count\nprintf \"fatal: Unable to create 'index.lock': File exists.\\n\" >&2\nexit 1\n");
  await chmod(join(hooks, "post-checkout"), 0o755);
  await assert.rejects(repo.service.checkoutRemoteBranchAsLocal("origin/master"), /index.lock/);
  await assertCheckout(repo, "master");
  assert.equal(await readFile(counter, "utf8"), "run\n");
});

test("rename lock failures leave the original branch and working files intact", async (t) => {
  const repo = await fixture(t);
  const stale = `master-stale-${repo.localShortHash}`;
  const lock = join(repo.root, ".git", "refs", "heads", `${stale}.lock`);
  await writeFile(lock, "fixture lock\n");
  await assert.rejects(repo.service.checkoutRemoteBranchAsLocal("origin/master"), /File exists|lock/i);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.localHash);
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "local version\n");
  await assert.rejects(runGit(["show-ref", "--verify", `refs/heads/${stale}`], repo.root));
  await rm(lock);
  await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  await assertCheckout(repo, "master");
});
