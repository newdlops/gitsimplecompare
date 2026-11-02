import assert from "node:assert/strict";
import test from "node:test";
import { completeSearchPullRequests } from "../src/git/pullRequestSearchReads";

/** 두 후속 연결이 모두 존재하는 PR로 순차 대기나 부분 성공 게시를 검출한다. */
function node(): any {
  return { number: 1, title: "PR", state: "OPEN", url: "https://github.com/o/r/pull/1", headRefName: "topic", baseRefName: "main",
    headRefOid: "head", baseRefOid: "base", files: { totalCount: 1 }, comments: { totalCount: 1 },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "reviews" } },
    commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Head" } }], pageInfo: { hasNextPage: true, endCursor: "commits" } } };
}

/** 네트워크 대역의 응답만 만들며 실제 connection 완성·DTO 처리는 제품 함수를 통과한다. */
function response(review: boolean): string {
  return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head", baseRefOid: "base",
    ...(review ? { reviewThreads: { nodes: [{ comments: { totalCount: 2 } }], pageInfo: { hasNextPage: false } } }
      : { commits: { nodes: [{ commit: { oid: "tail", messageHeadline: "Tail" } }], pageInfo: { hasNextPage: false } } }) } } } });
}

test("search starts commit pagination while review pagination is still pending", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started: string[] = [];
  const pending = completeSearchPullRequests("/repo", "o", "r", [node()], async (_args, _root, options) => {
    const review = options.operation.includes("review"); started.push(review ? "review" : "commit");
    if (review) await gate;
    return response(review);
  });
  try { await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, ["review", "commit"]); }
  finally { release(); }
  const [value] = await pending;
  assert.equal(value.commentCount, 3); assert.equal(value.commentCountComplete, true);
  assert.deepEqual(value.commitHashes, ["head", "tail"]); assert.equal(value.commitHashesComplete, true);
});

for (const failed of ["review", "commit"]) {
  test(`${failed} continuation failure cancels and closes its pending sibling`, async () => {
    let first!: () => void, closed = false;
    const bothStarted = new Promise<void>(resolve => { first = resolve; }); let started = 0;
    setImmediate(() => { if (started < 2) first(); });
    const failure = new Error(`${failed} failed`);
    const pending = completeSearchPullRequests("/repo", "o", "r", [node()], async (_args, _root, options) => {
      const kind = options.operation.includes("review") ? "review" : "commit";
      if (++started === 2) first();
      if (kind === failed) { await bothStarted; throw failure; }
      return new Promise<string>((resolve, reject) => {
        const abort = () => { setImmediate(() => { closed = true; reject(new DOMException("cancelled", "AbortError")); }); };
        options.signal?.addEventListener("abort", abort, { once: true });
        // 순차 구현도 테스트 프로세스를 영구 대기시키지 않고 정상 결과를 내게 한다.
        setImmediate(() => { if (started === 1) { resolve(response(kind === "review")); first(); } });
      });
    });
    await assert.rejects(pending, error => error === failure);
    assert.equal(closed, true); assert.equal(started, 2);
  });
}
