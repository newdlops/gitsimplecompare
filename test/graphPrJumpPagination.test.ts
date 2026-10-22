import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 깊은 PR 대상과 실제 checkout 후 ref-only 갱신을 한 번의 Native 이력 생성으로 준비한다. */
async function historyFixture(t: TestContext) {
  const f = await safetyFixture(t, "pr-jump-pagination");
  const records = Array.from({ length: 1799 }, (_, index) => {
    const subject = `History ${index}`;
    return `commit refs/heads/main\ncommitter Fixture <fixture@example.test> ${1700000000 + index} +0000\n` +
      `data ${Buffer.byteLength(subject)}\n${subject}\n${index === 0 ? `from ${f.head}\n` : ""}\n`;
  });
  await runGitWithInput(["fast-import", "--quiet"], f.root, records.join("") + "done\n");
  await git(f.root, "branch", "topic", "HEAD~1");
  const target = await git(f.root, "rev-parse", "HEAD~800");
  const pr = pullRequestInfoFromGraphQl({ number: 42, title: "An older pull request", state: "OPEN",
    headRefOid: target, headRefName: "old-pr", baseRefName: "main" });
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true,
    repository: "owner/repo", defaultBranch: "main", hasMore: false, pullRequests: [pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () => ({
    repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  const service = new GitLogService(f.root), h = createOperationGraphPanel(t, service);
  t.after(() => h.panel.dispose());
  await h.receiveMessage({ type: "ready" });
  await service.checkoutLocalBranch("topic");
  await h.panel.refreshAfterCheckoutAction();
  assert.equal(h.panel.reconcilePageOrder, true, "the actual checkout refresh must defer page-order reconciliation");
  await writeFile(join(f.root, "tracked.txt"), "Keep the user's local edit.\n");
  return { ...f, ...h, target };
}

for (const direction of ["newer", "older"] as const) test(`a PR jump after checkout survives ${direction} pagination`, async t => {
  const f = await historyFixture(t);
  /** Graph 이동·페이지 조회가 원본 HEAD·index·config·작업 파일을 쓰지 않았는지 원문으로 확인한다. */
  const protectedState = async () => ({ head: await git(f.root, "rev-parse", "HEAD"),
    index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")),
    tracked: await readFile(join(f.root, "tracked.txt")) });
  const before = await protectedState();
  await f.receiveMessage({ type: "ensureCommitVisible", requestId: "deep-pr-after-checkout",
    hashes: [f.target], pullRequestNumber: 42 });
  assert.deepEqual(f.messages.filter(message => message.type === "commitVisibility"), [{
    type: "commitVisibility", requestId: "deep-pr-after-checkout", found: true, hash: f.target,
  }]);
  assert.ok(f.panel.commits.some((commit: { hash: string }) => commit.hash === f.target));
  const rangeStart = f.panel.rangeStartIndex;
  assert.ok(rangeStart > 600);
  await f.receiveMessage({ type: "loadMore", direction });
  assert.ok(f.panel.commits.some((commit: { hash: string }) => commit.hash === f.target),
    "the first page event after a successful jump must not replace its target with the beginning of history");
  assert.equal(f.panel.rangeStartIndex, direction === "newer" ? Math.max(0, rangeStart - 300) : rangeStart);
  const native = await git(f.root, "rev-list", "--topo-order", "--branches", "--remotes", "--tags",
    `--skip=${f.panel.rangeStartIndex}`, `--max-count=${f.panel.commits.length}`);
  assert.deepEqual(f.panel.commits.map((commit: { hash: string }) => commit.hash), native.split("\n"),
    "pagination must remain contiguous in Native topo order, without duplicate or missing commits");
  assert.deepEqual(await protectedState(), before);
});

test("an unsuccessful PR jump keeps reconciliation for the original graph", async t => {
  const f = await historyFixture(t), before = f.panel.commits.map((commit: { hash: string }) => commit.hash);
  await f.receiveMessage({ type: "ensureCommitVisible", requestId: "missing-pr", hashes: ["1".repeat(40)] });
  assert.deepEqual(f.messages.filter(message => message.type === "commitVisibility"), [{
    type: "commitVisibility", requestId: "missing-pr", found: false, hash: undefined,
  }]);
  assert.equal(f.panel.reconcilePageOrder, true);
  assert.deepEqual(f.panel.commits.map((commit: { hash: string }) => commit.hash), before);
});
