import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { setGitExecutableResolver } from "../src/git/gitExec";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestSquashMerge } from "../src/git/pullRequestSquashMerge";
import { PullRequestWorktreeRecoveryError, PullRequestWorktreeRecoveryService } from "../src/git/pullRequestWorktreeRecovery";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

/** PR 내부의 두 branch를 merge하고 마지막 commit에서 임시 편집을 되돌린 이력을 만든다. */
async function mergedHistory(t: TestContext, realConflict = false) {
  const setup = await safetyFixture(t, "pr-squash-history");
  const { root, head: base } = setup;
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "tracked.txt"), "temporary PR edit\n");
  await git(root, "commit", "-qam", "intermediate edit");
  await git(root, "switch", "-qc", "side", base);
  await writeFile(join(root, "side.txt"), "included side change\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "side change");
  await git(root, "switch", "source");
  await git(root, "merge", "--no-ff", "-qm", "merge PR side", "side");
  await writeFile(join(root, "tracked.txt"), realConflict ? "final PR behavior\n" : "base\n");
  await writeFile(join(root, "feature.txt"), "final PR feature\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "final delta");
  const head = await git(root, "rev-parse", "HEAD");
  const commits = (await git(root, "rev-list", "--topo-order", "--reverse", `${base}..HEAD`)).split("\n");
  await git(root, "switch", "main");
  await writeFile(join(root, "tracked.txt"), "destination behavior\n");
  await git(root, "commit", "-qam", "destination change");
  const beforeHead = await git(root, "rev-parse", "HEAD");
  return { ...setup, base, beforeHead, commits, pr: { ...safetyPullRequest(head), commitHashes: commits } };
}

/** 구형 Git 경로를 검증하도록 이 테스트에서만 merge-tree를 미지원으로 응답한다. */
async function legacyGit(t: TestContext, directory: string) {
  const wrapper = join(directory, "legacy-git");
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = "merge-tree" ]; then\n  echo "error: unknown option write-tree" >&2\n  exit 129\nfi\nexec git "$@"\n', { mode: 0o755 });
  t.after(setGitExecutableResolver(() => wrapper));
}

for (const legacy of [false, true]) {
  test(`merged PR uses its final delta without intermediate conflicts (${legacy ? "legacy" : "modern"} Git)`, async t => {
    const { root, directory, base, beforeHead, commits, pr } = await mergedHistory(t);
    if (legacy) await legacyGit(t, directory);
    // API의 시간순과 parent 순서가 달라도 배열 순서 대신 실제 DAG로 범위를 확인한다.
    const shuffled = [commits[2], commits[0], commits[3], commits[1]];
    const plan = await new PullRequestSquashMerge(root).prepare(shuffled);
    assert.equal(plan.base, base);
    assert.equal(plan.head, pr.headHash);
    await writeFile(join(root, "user.txt"), "staged user work\n");
    await git(root, "add", "user.txt");
    await writeFile(join(root, "user.txt"), "unstaged user work\n");
    const result = await new PullRequestOperationService(root).squashCherryPick({ ...pr, commitHashes: shuffled });
    assert.equal(result.status, "completed");
    assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "destination behavior\n");
    assert.equal(await readFile(join(root, "side.txt"), "utf8"), "included side change\n");
    assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "final PR feature\n");
    assert.equal(await git(root, "show", ":user.txt"), "staged user work");
    assert.equal(await readFile(join(root, "user.txt"), "utf8"), "unstaged user work\n");
    assert.deepEqual(await listPrOperationWorktrees(root), []);
    await git(root, "restore", "--staged", "--", "user.txt");
    await new PullRequestOperationService(root).undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    assert.equal(await readFile(join(root, "user.txt"), "utf8"), "unstaged user work\n");
  });
}

test("merging updated base into a PR excludes unlisted base-only changes on another destination", async t => {
  const { root, head: base } = await safetyFixture(t, "pr-squash-base-merge");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "feature.txt"), "PR feature\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "PR feature");
  await git(root, "switch", "main");
  await writeFile(join(root, "base-only.txt"), "must not be imported\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "base update");
  const updatedBase = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "source");
  await git(root, "merge", "--no-ff", "-qm", "update base", "main");
  const head = await git(root, "rev-parse", "HEAD");
  const commits = (await git(root, "rev-list", "--reverse", `${updatedBase}..HEAD`)).split("\n");
  const plan = await new PullRequestSquashMerge(root).prepare(commits);
  assert.equal(plan.base, updatedBase);
  assert.equal(plan.head, head);
  await git(root, "switch", "-qc", "destination", base);
  await new PullRequestOperationService(root).squashCherryPick({ ...safetyPullRequest(head), commitHashes: commits });
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "PR feature\n");
  await assert.rejects(readFile(join(root, "base-only.txt")), { code: "ENOENT" });
});

test("a single verified merge source is aggregated before legacy replay", async t => {
  const { root, directory, head: base } = await safetyFixture(t, "pr-squash-single-merge");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "feature.txt"), "PR feature\n");
  await git(root, "add", ".");
  const tree = await git(root, "write-tree");
  const advanced = await git(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "base advancement");
  const head = await git(root, "commit-tree", tree, "-p", base, "-p", advanced, "-m", "single PR merge");
  await git(root, "reset", "--hard", head);
  await git(root, "switch", "main");
  await legacyGit(t, directory);
  const result = await new PullRequestOperationService(root).squashCherryPick(safetyPullRequest(head));
  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "PR feature\n");
});

test("missing intermediate commits in a merge history cannot import unlisted changes", async t => {
  const { root, commits } = await mergedHistory(t);
  // 연결하는 merge commit이 빠진 목록에 최종 tree 전체를 적용하면 안 된다.
  const selected = [commits[0], commits[1], commits[3]];
  assert.deepEqual(await new PullRequestSquashMerge(root).prepare(selected), { commits: selected });
});

test("unrelated boundary parents remain ambiguous instead of guessing a merge mainline", async t => {
  const { root, commits } = await mergedHistory(t);
  const selected = [commits[2], commits[3]];
  assert.deepEqual(await new PullRequestSquashMerge(root).prepare(selected), { commits: selected });
});

test("a real conflict in a merged PR keeps one final patch and resumes after explicit resolution", async t => {
  const { root, beforeHead, pr } = await mergedHistory(t, true);
  let record;
  try { await new PullRequestOperationService(root).squashCherryPick(pr); }
  catch (error) { assert.ok(error instanceof PullRequestWorktreeRecoveryError); record = error.recovery; }
  assert.ok(record);
  t.after(() => rm(record.worktreePath, { recursive: true, force: true }));
  assert.equal(record.remaining.length, 0);
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  await new ConflictService(record.worktreePath).acceptIncoming("tracked.txt");
  await new PullRequestWorktreeRecoveryService(root).continue(record.id);
  assert.equal(await git(root, "rev-list", "--count", `${beforeHead}..HEAD`), "1");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "final PR behavior\n");
  assert.equal(await readFile(join(root, "side.txt"), "utf8"), "included side change\n");
});

test("the verified PR tree is reused at its exact base without merge-tree or a temporary unstaged scan", async t => {
  const { root, directory, head: base } = await safetyFixture(t, "pr-squash-direct-tree");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "feature.txt"), "PR feature\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "feature");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  const file = join(directory, "trace.jsonl");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  try {
    await new PullRequestOperationService(root).squashCherryPick(safetyPullRequest(head));
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const starts = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter(event => event.event === "start");
  assert.ok(!starts.some(event => event.argv.includes("merge-tree")));
  assert.ok(!starts.some(event => event.argv.join(" ").endsWith("diff --quiet")));
  assert.equal(await git(root, "rev-list", "--count", `${base}..HEAD`), "1");
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "PR feature\n");
});
