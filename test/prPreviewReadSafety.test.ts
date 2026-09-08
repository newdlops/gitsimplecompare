import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadCache } from "../src/git/githubReadCache";
import { PullRequestService, type StagedPullRequestPreview } from "../src/git/pullRequestService";
import { PullRequestPreviewLazyReads } from "../src/webview/pullRequestPreviewLazyReads";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

test("40-commit previews share three initial reads, omit patch/timeline calls and reuse comment reads", async t => {
  const { root, pr } = await prSafetyFixture(t);
  const hashes = Array.from({ length: 39 }, (_, n) => (n + 1).toString(16).padStart(40, "0")).concat(pr.headHash!);
  const requests: string[][] = [];
  const cache = new GitHubReadCache(async (args, _root, options) => {
    requests.push([...args]); assert.ok(options.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(args[0], "repo"); assert.notEqual(args[0], "pr");
    if (args.includes("graphql")) return JSON.stringify({ data: { repository: { nameWithOwner: "fixture/repo", pullRequest: {
      title: "PR", body: "body", headRefOid: pr.headHash, commits: { nodes: hashes.map(oid => ({ commit: { oid, messageHeadline: `Commit ${oid}` } })), pageInfo: { hasNextPage: false } },
    } } } });
    if (args.some(arg => arg.includes("/files?"))) return JSON.stringify([{ filename: "tracked.txt", status: "modified", additions: 1, deletions: 1 }]);
    return "[]";
  });
  const service = new PullRequestService(root, (_root, snapshot, signal) => (args, cwd, options) =>
    cache.read(args, cwd, { ...options, signal, version: snapshot?.headHash, ttlMs: 30_000 }));
  const previews = await Promise.all(Array.from({ length: 3 }, () => service.getStagedPreview("main", { ...pr, commitHashes: hashes }, "source")));
  assert.equal(requests.length, 3);
  assert.equal(previews[0].title, "PR"); assert.equal(previews[0].body, "body");
  assert.equal(previews[0].previewCommits.length, 40);
  assert.equal(previews[0].previewFiles.length, 1);
  assert.equal(previews[0].conversationLoaded, false);
  assert.ok(requests.every(args => !args.some(arg => arg.includes("/commits/") || arg.includes("/timeline?"))));
  await service.getStagedPreview("main", pr, "source");
  assert.equal(requests.length, 3);
  await service.getPreviewConversation(previews[0]);
  assert.equal(requests.length, 5);
  assert.equal(requests.filter(args => args.some(arg => arg.includes("pulls/42/comments?"))).length, 1);
});

test("lazy reads discard old preview responses and keep error separate from successful empty files", async () => {
  let finish!: (value: any[]) => void;
  let failure = false;
  const service = { getPreviewCommitFiles: async () => {
    if (failure) throw new Error("temporary GitHub error");
    return new Promise<any[]>(resolve => { finish = resolve; });
  } } as unknown as PullRequestService;
  const posted: any[] = [];
  const reads = new PullRequestPreviewLazyReads(service, message => posted.push(message));
  const first = { requestId: 1, previewCommits: [{ hash: "a", files: [] }] } as unknown as StagedPullRequestPreview;
  const signal = new AbortController(); reads.setPreview(first, signal.signal);
  const old = reads.loadCommit("a", 1);
  signal.abort(); reads.setPreview({ ...first, requestId: 2 }, new AbortController().signal);
  finish([]); await old; assert.deepEqual(posted, []);
  failure = true; await reads.loadCommit("a", 2);
  assert.equal(posted[0].error, "temporary GitHub error"); assert.equal(posted[0].files, undefined);
  failure = false; const retry = reads.loadCommit("a", 2); finish([]); await retry;
  assert.deepEqual(posted[1], { type: "commitFiles", requestId: 2, hash: "a", files: [] });
  await reads.loadCommit("unlisted", 2); assert.equal(posted.length, 2);
});
