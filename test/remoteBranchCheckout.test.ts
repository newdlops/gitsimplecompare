import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await runGit(["switch", "-c", "incoming"], root);
  await writeFile(join(root, "file.txt"), "remote version\n");
  await runGit(["commit", "-am", "remote"], root);
  const remoteHash = (await runGit(["rev-parse", "HEAD"], root)).trim();
  const shortHash = (await runGit(["rev-parse", "--short=7", "HEAD"], root)).trim();
  await runGit(["remote", "add", "origin", "."], root);
  await runGit(["update-ref", "refs/remotes/origin/master", remoteHash], root);
  await runGit(["switch", "master"], root);
  return { root, localHash, remoteHash, shortHash, service: new GitLogService(root) };
}

/**
 * 생성된 branch의 checkout 위치, upstream, 기존 master 보존을 Git으로 직접 확인한다.
 * @param repo checkout을 실행한 테스트 저장소
 * @param name 새로 생성돼 현재 checkout되어야 할 로컬 branch 이름
 * @param upstream 새 branch가 추적해야 할 원격 short ref
 */
async function assertCheckout(repo: CheckoutFixture, name: string, upstream = "origin/master"): Promise<void> {
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
    (await runGit(["rev-parse", "refs/heads/master"], repo.root)).trim(),
    repo.localHash
  );
  assert.equal(
    await readFile(join(repo.root, "file.txt"), "utf8"),
    "remote version\n"
  );
}

test("an existing current master is preserved while origin/master checks out a hash-suffixed branch", async (t) => {
  const repo = await fixture(t);
  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, `master-${repo.shortHash}`);
  await assertCheckout(repo, name);
});

test("repeated remote checkout skips existing hash names without moving their tips", async (t) => {
  const repo = await fixture(t);
  const base = `master-${repo.shortHash}`;
  await runGit(["branch", base, repo.localHash], repo.root);
  await runGit(["branch", `${base}-2`, repo.localHash], repo.root);

  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), `${base}-3`);
  await assertCheckout(repo, `${base}-3`);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(), repo.localHash);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}-2`], repo.root)).trim(), repo.localHash);
  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), `${base}-4`);
  await assertCheckout(repo, `${base}-4`);
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

  const name = `master-${repo.shortHash}`;
  await assertCheckout(repo, name);
  assert.deepEqual(__warningMessages, [`Create local branch '${name}' from 'origin/master' and checkout?`]);
  assert.deepEqual(__informationMessages, [`Branch '${name}' created and checked out.`]);
  assert.equal(refreshed, 1);
});

test("nested branch names and non-origin upstreams retain their exact tracking target", async (t) => {
  const repo = await fixture(t);
  await runGit(["remote", "add", "upstream", "."], repo.root);
  await runGit(["branch", "feature/review", repo.localHash], repo.root);
  await runGit(["update-ref", "refs/remotes/upstream/feature/review", repo.remoteHash], repo.root);

  const name = await repo.service.checkoutRemoteBranchAsLocal("upstream/feature/review");
  assert.equal(name, `feature/review-${repo.shortHash}`);
  await assertCheckout(repo, name, "upstream/feature/review");
  assert.equal(
    (await runGit(["rev-parse", "refs/heads/feature/review"], repo.root)).trim(),
    repo.localHash
  );
});

test("packed local refs also reserve the base and hash-suffixed branch names", async (t) => {
  const repo = await fixture(t);
  const base = `master-${repo.shortHash}`;
  await runGit(["branch", base, repo.localHash], repo.root);
  await runGit(["pack-refs", "--all", "--prune"], repo.root);

  assert.equal(await repo.service.checkoutRemoteBranchAsLocal("origin/master"), `${base}-2`);
  await assertCheckout(repo, `${base}-2`);
  assert.equal(
    (await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(),
    repo.localHash
  );
});

test("an existing master checked out in another worktree does not block remote checkout", async (t) => {
  const repo = await fixture(t);
  const otherWorktree = join(repo.root, "other-worktree");
  await runGit(["switch", "incoming"], repo.root);
  await runGit(["worktree", "add", otherWorktree, "master"], repo.root);

  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, `master-${repo.shortHash}`);
  await assertCheckout(repo, name);
  assert.equal((await runGit(["branch", "--show-current"], otherWorktree)).trim(), "master");
  assert.equal(await readFile(join(otherWorktree, "file.txt"), "utf8"), "local version\n");
});

test("dirty-file protection and merge retry preserve the collision-free name", async (t) => {
  const repo = await fixture(t);
  const name = `master-${repo.shortHash}`;
  let invalidations = 0;
  const actions = new GitGraphActionService(repo.root, () => { invalidations++; });
  await writeFile(join(repo.root, "file.txt"), "uncommitted edit\n");

  await assert.rejects(actions.checkoutRemoteBranchAsLocal("origin/master"), /overwritten|local changes/i);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "uncommitted edit\n");
  await assert.rejects(runGit(["show-ref", "--verify", `refs/heads/${name}`], repo.root));

  assert.equal(await actions.checkoutRemoteBranchAsLocal("origin/master", true), name);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), name);
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.remoteHash);
  assert.equal((await runGit(["rev-parse", "refs/heads/master"], repo.root)).trim(), repo.localHash);
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
  assert.match(__warningMessages[0], new RegExp(`master-${repo.shortHash}`));
  assert.deepEqual(__informationMessages, []);
  assert.equal(refreshed, 0);
});

test("a name taken during graph confirmation is rechecked and the actual created name is reported", async (t) => {
  const repo = await fixture(t);
  const base = `master-${repo.shortHash}`;
  let confirmations = 0;
  t.mock.method(vscode.window, "showWarningMessage", async (message: string) => {
    confirmations++;
    assert.equal(message, `Create local branch '${base}' from 'origin/master' and checkout?`);
    await runGit(["branch", base, repo.localHash], repo.root);
    return "Create and Checkout";
  });

  await checkoutRemoteBranch({
    logService: repo.service,
    refreshCheckout: async () => undefined,
    refreshGraph: async () => undefined,
  }, "origin/master");

  await assertCheckout(repo, `${base}-2`);
  assert.equal((await runGit(["rev-parse", `refs/heads/${base}`], repo.root)).trim(), repo.localHash);
  assert.deepEqual(__informationMessages, [`Branch '${base}-2' created and checked out.`]);
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
  assert.equal(after.find((branch) => branch.name === "master")?.isCurrent, false);
  assert.equal(after.some((branch) => branch.name === "origin/master" && branch.kind === "remote"), true);
});

test("an existing upstream and a similarly named tag do not redirect the remote checkout", async (t) => {
  const repo = await fixture(t);
  await runGit(["branch", "--set-upstream-to=origin/master", "master"], repo.root);
  await runGit(["tag", "origin/master", repo.localHash], repo.root);

  const name = await repo.service.checkoutRemoteBranchAsLocal("origin/master");
  assert.equal(name, `master-${repo.shortHash}`);
  assert.equal((await runGit(["rev-parse", "HEAD"], repo.root)).trim(), repo.remoteHash);
  assert.equal(
    (await runGit(["rev-parse", "--symbolic-full-name", "@{upstream}"], repo.root)).trim(),
    "refs/remotes/origin/master"
  );
  assert.equal((await runGit(["config", "branch.master.remote"], repo.root)).trim(), "origin");
  assert.equal((await runGit(["config", "branch.master.merge"], repo.root)).trim(), "refs/heads/master");
  assert.equal((await runGit(["rev-parse", "refs/heads/master"], repo.root)).trim(), repo.localHash);
  assert.equal((await runGit(["rev-parse", "refs/tags/origin/master"], repo.root)).trim(), repo.localHash);
});

test("previewing a generated checkout name is repeatable and leaves the repository unchanged", async (t) => {
  const repo = await fixture(t);
  const beforeRefs = await runGit(
    ["for-each-ref", "--format=%(refname) %(objectname)"], repo.root
  );
  const beforeStatus = await runGit(["status", "--porcelain"], repo.root);
  const name = `master-${repo.shortHash}`;

  assert.equal(await repo.service.getRemoteBranchCheckoutName("origin/master"), name);
  assert.equal(await repo.service.getRemoteBranchCheckoutName("origin/master"), name);
  assert.equal(
    await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], repo.root),
    beforeRefs
  );
  assert.equal(await runGit(["status", "--porcelain"], repo.root), beforeStatus);
  assert.equal((await runGit(["branch", "--show-current"], repo.root)).trim(), "master");
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "local version\n");
});
