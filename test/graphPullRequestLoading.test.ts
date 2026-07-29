import assert from "node:assert/strict";
import test from "node:test";
import { fetchRemainingReviewThreadCommentCounts } from "../src/git/pullRequestCommentCounts";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { GraphVisibilityRefreshCoalescer } from "../src/webview/graphPanelMessageRouter";
import { GraphPullRequestPager, sendGraphPullRequestStacks } from "../src/webview/graphPullRequests";

/** refresh A/B의 취소를 재현할 수 있도록 signal 해제 전까지 대기하는 overview를 만든다. */
function abortableOverview(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
}

test("graph pull request latest refresh aborts stale overview without unavailable UI", async () => {
  const original = PullRequestService.prototype.getOverview;
  const posted: unknown[] = [];
  let calls = 0;
  PullRequestService.prototype.getOverview = async (_branches, _cursor, signal) => {
    calls++;
    if (calls === 1) return abortableOverview(signal!);
    return { available: true, repository: "owner/repo", defaultBranch: "main", hasMore: false, pullRequests: [] };
  };
  try {
    const pager = new GraphPullRequestPager();
    const first = pager.refresh("/repo", [], "first", (message) => posted.push(message));
    await Promise.resolve();
    const second = pager.refresh("/repo", [], "second", (message) => posted.push(message));
    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.equal(calls, 2);
    assert.equal(posted.filter((message: any) => message.type === "pullRequestOverview" && message.overview.available === false).length, 0);
    assert.equal(posted.filter((message: any) => message.type === "pullRequestOverview").length, 1);
  } finally {
    PullRequestService.prototype.getOverview = original;
  }
});

test("graph pull request abort prevents review pagination and forwards complete metadata hints", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchRemainingReviewThreadCommentCounts("/repo", "owner", "repo", [{ number: 1, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "next" } } }], controller.signal), /cancelled/);

  const original = PullRequestStackService.prototype.getGraphSnapshot;
  let received: unknown[] = [];
  PullRequestStackService.prototype.getGraphSnapshot = async (...args: unknown[]) => {
    received = args;
    return { repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] };
  };
  try {
    const posted: unknown[] = [];
    await sendGraphPullRequestStacks("/repo", [], "owner/repo", "main", undefined, (message) => posted.push(message));
    assert.deepEqual(received.slice(1, 3), ["owner/repo", "main"]);
    assert.equal((posted[0] as { type: string }).type, "pullRequestStackSnapshot");
  } finally {
    PullRequestStackService.prototype.getGraphSnapshot = original;
  }
});

test("graph visibility coalesces hidden refreshes and preserves the stronger PR reason", () => {
  const coalescer = new GraphVisibilityRefreshCoalescer();
  let localGraphLoads = 0;
  let pullRequestLoads = 0;
  assert.equal(coalescer.defer("/repo", "stableMetadata", false), "deferred");
  assert.equal(coalescer.defer("/repo", "stackSubmitted", true), "coalesced");
  assert.equal(localGraphLoads, 0);
  assert.equal(pullRequestLoads, 0);
  const pending = coalescer.take("/repo");
  assert.deepEqual(pending, { repoRoot: "/repo", reason: "stackSubmitted", refreshPullRequests: true });
  if (pending) {
    localGraphLoads++;
    pullRequestLoads++;
  }
  assert.equal(localGraphLoads, 1);
  assert.equal(pullRequestLoads, 1);
  assert.equal(coalescer.take("/repo"), undefined);
});

test("graph stack reuses complete metadata hints and falls back when hints are incomplete", async () => {
  const originalBranches = PullRequestStackMetadataService.prototype.listBranches;
  const originalRepositoryInfo = (PullRequestStackService.prototype as any).repositoryInfo;
  let repositoryInfoCalls = 0;
  PullRequestStackMetadataService.prototype.listBranches = async () => [];
  (PullRequestStackService.prototype as any).repositoryInfo = async () => {
    repositoryInfoCalls++;
    return { nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } };
  };
  try {
    const service = new PullRequestStackService("/repo");
    const reused = await service.getGraphSnapshot([], "owner/repo", "main");
    assert.equal(repositoryInfoCalls, 0);
    assert.deepEqual([reused.repository, reused.defaultBranch], ["owner/repo", "main"]);
    const fallback = await service.getGraphSnapshot([], "owner/repo", "");
    assert.equal(repositoryInfoCalls, 1);
    assert.deepEqual([fallback.repository, fallback.defaultBranch], ["owner/repo", "main"]);
  } finally {
    PullRequestStackMetadataService.prototype.listBranches = originalBranches;
    (PullRequestStackService.prototype as any).repositoryInfo = originalRepositoryInfo;
  }
});
