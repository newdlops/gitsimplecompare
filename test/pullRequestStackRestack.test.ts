import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";

const execFileAsync = promisify(execFile);

/** 테스트마다 실제 Git 저장소를 만들고 사용자 identity와 main 첫 commit을 준비한다. */
async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gsc-stack-restack-test-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Stack Test");
  await git(directory, "config", "user.email", "stack@example.com");
  await writeFile(join(directory, "shared.txt"), "base\n", "utf8");
  await git(directory, "add", "shared.txt");
  await git(directory, "commit", "-m", "base");
  return directory;
}

/** shell을 거치지 않고 테스트 저장소에서 git 명령을 실행하고 stdout을 반환한다. */
async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      HUSKY: "0",
    },
  });
  return result.stdout.trim();
}

/** 지정 commit이 target history의 조상인지 실제 git merge-base로 검사한다. */
async function isAncestor(repoRoot: string, ancestor: string, target: string): Promise<boolean> {
  try {
    await git(repoRoot, "merge-base", "--is-ancestor", ancestor, target);
    return true;
  } catch {
    return false;
  }
}

/** main 위에 stack/one → stack/two 두 layer와 각 고유 commit을 만든다. */
async function createTwoLayerStack(repoRoot: string): Promise<{
  metadata: PullRequestStackMetadataService;
  oldOne: string;
  oldTwo: string;
}> {
  const metadata = new PullRequestStackMetadataService(repoRoot);
  const main = await git(repoRoot, "rev-parse", "main");
  await metadata.createLayer({
    branch: "stack/one",
    parentBranch: "main",
    parentRef: main,
  });
  await git(repoRoot, "switch", "stack/one");
  await writeFile(join(repoRoot, "one.txt"), "one\n", "utf8");
  await git(repoRoot, "add", "one.txt");
  await git(repoRoot, "commit", "-m", "layer one");
  const oldOne = await git(repoRoot, "rev-parse", "HEAD");
  await metadata.createLayer({
    branch: "stack/two",
    parentBranch: "stack/one",
    parentRef: oldOne,
  });
  await git(repoRoot, "switch", "stack/two");
  await writeFile(join(repoRoot, "two.txt"), "two\n", "utf8");
  await git(repoRoot, "add", "two.txt");
  await git(repoRoot, "commit", "-m", "layer two");
  const oldTwo = await git(repoRoot, "rev-parse", "HEAD");
  await git(repoRoot, "switch", "main");
  return { metadata, oldOne, oldTwo };
}

test("parent layer가 재작성되면 child만 새 parent 위로 restack하고 안전 ref를 남긴다", async () => {
  const repoRoot = await createRepository();
  try {
    const { metadata, oldOne, oldTwo } = await createTwoLayerStack(repoRoot);
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "one.txt"), "one amended\n", "utf8");
    await git(repoRoot, "add", "one.txt");
    await git(repoRoot, "commit", "--amend", "--no-edit");
    const newOne = await git(repoRoot, "rev-parse", "HEAD");
    assert.notEqual(newOne, oldOne);
    await git(repoRoot, "switch", "main");

    const service = new PullRequestStackRestackService(repoRoot);
    const plan = await service.createPlan("stack/one");
    assert.deepEqual(plan.steps.map((step) => [step.branch, step.action]), [
      ["stack/one", "record"],
      ["stack/two", "rebase"],
    ]);
    const result = await service.execute(plan);
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    const newTwo = await git(repoRoot, "rev-parse", "stack/two");
    assert.notEqual(newTwo, oldTwo);
    assert.equal(await isAncestor(repoRoot, newOne, newTwo), true);
    assert.deepEqual(result.rewrittenBranches, ["stack/two"]);
    assert.equal(result.backupRefs.length, 2);
    assert.equal(await git(repoRoot, "rev-parse", result.backupRefs[1]), oldTwo);
    const two = (await metadata.listBranches()).find((branch) => branch.name === "stack/two");
    assert.equal(two?.parentHead, newOne);
    assert.equal(await git(repoRoot, "show", "stack/two:one.txt"), "one amended");
    assert.equal(await git(repoRoot, "show", "stack/two:two.txt"), "two");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("연쇄 restack 충돌은 임시 worktree에 보존되고 Abort가 원래 child와 메타데이터를 복원한다", async () => {
  const repoRoot = await createRepository();
  try {
    const metadata = new PullRequestStackMetadataService(repoRoot);
    const main = await git(repoRoot, "rev-parse", "main");
    await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: main });
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "shared.txt"), "one\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "-m", "parent change");
    const oldOne = await git(repoRoot, "rev-parse", "HEAD");
    await metadata.createLayer({ branch: "stack/two", parentBranch: "stack/one", parentRef: oldOne });
    await git(repoRoot, "switch", "stack/two");
    await writeFile(join(repoRoot, "shared.txt"), "two\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "-m", "child change");
    const oldTwo = await git(repoRoot, "rev-parse", "HEAD");
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "shared.txt"), "one amended\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "--amend", "--no-edit");
    await git(repoRoot, "switch", "main");

    const service = new PullRequestStackRestackService(repoRoot);
    const result = await service.execute(await service.createPlan("stack/one"));
    assert.equal(result.status, "conflicts");
    if (result.status !== "conflicts") return;
    assert.equal(result.branch, "stack/two");
    assert.deepEqual(result.conflictFiles, ["shared.txt"]);
    assert.match(result.worktreePath, /gsc-stack-restack-/);
    await git(result.worktreePath, "rebase", "--abort");
    const restoredRoot = await new PullRequestStackRestackService(result.worktreePath)
      .restoreAfterAbort();
    assert.equal(restoredRoot, repoRoot);
    assert.equal(await git(repoRoot, "rev-parse", "stack/two"), oldTwo);
    const two = (await metadata.listBranches()).find((branch) => branch.name === "stack/two");
    assert.equal(two?.parentHead, oldOne);
    const worktrees = await git(repoRoot, "worktree", "list", "--porcelain");
    assert.equal(worktrees.includes(result.worktreePath), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("임시 worktree 충돌을 해결한 Continue는 원본 저장소 state로 돌아가 남은 restack을 완료한다", async () => {
  const repoRoot = await createRepository();
  try {
    const metadata = new PullRequestStackMetadataService(repoRoot);
    const main = await git(repoRoot, "rev-parse", "main");
    await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: main });
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "shared.txt"), "parent original\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "-m", "parent edits shared file");
    const oldParent = await git(repoRoot, "rev-parse", "HEAD");
    await metadata.createLayer({
      branch: "stack/two",
      parentBranch: "stack/one",
      parentRef: oldParent,
    });
    await git(repoRoot, "switch", "stack/two");
    await writeFile(join(repoRoot, "shared.txt"), "child original\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "-m", "child edits shared file");
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "shared.txt"), "parent amended\n", "utf8");
    await git(repoRoot, "add", "shared.txt");
    await git(repoRoot, "commit", "--amend", "--no-edit");
    const newParent = await git(repoRoot, "rev-parse", "HEAD");
    await git(repoRoot, "switch", "main");

    const rootService = new PullRequestStackRestackService(repoRoot);
    const paused = await rootService.execute(await rootService.createPlan("stack/one"));
    assert.equal(paused.status, "conflicts");
    if (paused.status !== "conflicts") return;
    await writeFile(join(paused.worktreePath, "shared.txt"), "resolved child on amended parent\n", "utf8");
    await git(paused.worktreePath, "add", "shared.txt");
    await git(paused.worktreePath, "rebase", "--continue");

    const completed = await new PullRequestStackRestackService(paused.worktreePath)
      .resumeAfterContinue();
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed") return;
    assert.deepEqual(completed.rewrittenBranches, ["stack/two"]);
    assert.equal(await isAncestor(repoRoot, newParent, await git(repoRoot, "rev-parse", "stack/two")), true);
    assert.equal(await git(repoRoot, "show", "stack/two:shared.txt"), "resolved child on amended parent");
    const child = (await metadata.listBranches()).find((branch) => branch.name === "stack/two");
    assert.equal(child?.parentHead, newParent);
    const worktrees = await git(repoRoot, "worktree", "list", "--porcelain");
    assert.equal(worktrees.includes(paused.worktreePath), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("stack branch를 checkout한 worktree가 dirty면 snapshot이나 rebase 전에 중단한다", async () => {
  const repoRoot = await createRepository();
  try {
    await createTwoLayerStack(repoRoot);
    await git(repoRoot, "switch", "stack/one");
    await writeFile(join(repoRoot, "dirty.txt"), "not committed\n", "utf8");
    const service = new PullRequestStackRestackService(repoRoot);
    const plan = await service.createPlan("stack/one");
    await assert.rejects(
      () => service.execute(plan),
      /has local changes/
    );
    const refs = await git(repoRoot, "for-each-ref", "refs/gitsimplecompare/stack-backups");
    assert.equal(refs, "");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
