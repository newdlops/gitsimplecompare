import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput, setGitExecutableResolver } from "../src/git/gitExec";
import { PullRequestRevertPlanService } from "../src/git/pullRequestRevertPlan";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

/** 80개 선형 commit을 한 fast-import로 만들어 사전검증의 프로세스 증가를 실제 Git으로 검사한다. */
async function batchFixture(t: TestContext) {
  const fixture = await safetyFixture(t, "pr-revert-batch");
  const { root, head: base } = fixture;
  const data = (value: string) => `data ${Buffer.byteLength(value)}\n${value}\n`;
  let stream = "";
  let content = "";
  for (let index = 0; index < 80; index++) {
    content += `change ${index}\n`;
    stream += `commit refs/heads/source\nmark :${index + 1}\ncommitter Batch Test <batch@example.invalid> ${1700000000 + index} +0000\n`;
    stream += data(`PR commit ${index}\n`) + `from ${index ? `:${index}` : base}\nM 100644 inline feature.txt\n` + data(content) + "\n";
  }
  await runGitWithInput(["fast-import", "--quiet"], root, stream + "done\n");
  const commits = (await git(root, "rev-list", "--reverse", `${base}..source`)).split("\n");
  assert.equal(commits.length, 80);
  return { ...fixture, base, commits, pr: { ...safetyPullRequest(commits.at(-1)!), commitHashes: commits } };
}

/** 준비 단계에서 시작한 Git 프로세스 수만 trace2로 세고 테스트 간 환경을 원복한다. */
async function tracePrepare<T>(file: string, run: () => Promise<T>): Promise<{ result: T; processes: number }> {
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  try {
    const result = await run();
    const events = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    return { result, processes: events.filter(event => event.event === "start").length };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
}

for (const contained of [0, 40, 80]) {
  test(`80-commit revert preparation counts ${80 - contained} outside commits with bounded Git processes`, async (t) => {
    const { root, directory, base, commits, pr } = await batchFixture(t);
    const head = contained ? commits[contained - 1] : base;
    await git(root, "reset", "--hard", head);
    const index = await git(root, "ls-files", "--stage", "-z");
    const { result, processes } = await tracePrepare(join(directory, "prepare-trace.jsonl"), () =>
      new PullRequestRevertPlanService(root).prepare(pr, "rebaseRevert", head));
    assert.equal(result.outsideCurrentBranch, 80 - contained);
    assert.deepEqual(result.commits.map(commit => commit.hash), [...commits].reverse());
    assert.equal(result.targetKind, "originalCommits");
    assert.ok(processes <= 12, `80 commits started ${processes} Git processes`);
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
    assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  });
}

test("80-commit squash result matching also batches linear parent verification", async (t) => {
  const { root, directory, base, commits, pr } = await batchFixture(t);
  const tree = await git(root, "rev-parse", "source^{tree}");
  const merged = await git(root, "commit-tree", tree, "-p", base, "-m", "squash result");
  await git(root, "reset", "--hard", merged);
  const { result, processes } = await tracePrepare(join(directory, "matching-trace.jsonl"), () =>
    new PullRequestRevertPlanService(root).prepare({ ...pr, state: "MERGED", mergeHash: merged }, "squashRevert", merged));
  assert.equal(result.targetKind, "mergedResult");
  assert.deepEqual(result.commits, [{ hash: merged, mainline: undefined }]);
  assert.equal(result.outsideCurrentBranch, 0);
  assert.ok(processes <= 18, `Range matching started ${processes} Git processes`);
  assert.equal(commits.length, 80);
});

test("batched parent validation still rejects an original merge commit", async (t) => {
  const { root, base, commits, pr } = await batchFixture(t);
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  const merge = await git(root, "commit-tree", tree, "-p", commits[0], "-p", commits[1], "-m", "original merge");
  await assert.rejects(new PullRequestRevertPlanService(root).prepare({ ...pr, headHash: merge, commitHashes: [merge] }, "rebaseRevert"), /contains merge commit/);
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
});

test("failed batched ancestry reads cannot become a misleading outside-branch count", async (t) => {
  const { root, directory, base, pr } = await batchFixture(t);
  const wrapper = join(directory, "failing-git");
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = "rev-list" ]; then\n  echo "fixture ancestry read failed" >&2\n  exit 128\nfi\nexec git "$@"\n', { mode: 0o755 });
  t.after(setGitExecutableResolver(() => wrapper));
  await assert.rejects(new PullRequestRevertPlanService(root).prepare(pr, "rebaseRevert"), /fixture ancestry read failed/);
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
});
