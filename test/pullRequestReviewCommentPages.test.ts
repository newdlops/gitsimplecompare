import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestReviewCommentService } from "../src/git/pullRequestReviewComments";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
import type { GhExecute } from "../src/git/ghRunner";

/** REST 항목은 실제 정규화/답글 위치 상속을 통과시키며 원격 경계만 대체한다. */
const item = (id: number) => ({ id, path: "file.ts", body: `body ${id}`, line: 1, user: { login: "reviewer" } });

for (const count of [0, 99, 100, 101, 200, 1000, 1001]) {
  test(`review comments consume ${count} items using validated Link pages without an empty exact-multiple tail`, async () => {
    let calls = 0;
    const execute: GhExecute = async (args, _root, options) => {
      calls++; const route = args.at(-1)!;
      assert.equal(options.request?.kind, "rest");
      if (options.request?.kind !== "rest") throw new Error("typed REST required");
      assert.equal(options.request.responseMode, "page"); assert.equal(options.request.accept, "application/vnd.github-commitcomment.full+json");
      const page = Number(new URL("https://api.github.com/" + route).searchParams.get("page"));
      const values = Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, index) => item((page - 1) * 100 + index + 1));
      const link = page * 100 < count ? `<https://api.github.com/repos/owner/repo/pulls/7/comments?per_page=100&page=${page + 1}>; rel="next"` : undefined;
      return encodeRestPage(JSON.stringify(values), restPageMetadata(200, { link }));
    };
    const service: any = new PullRequestReviewCommentService("/repo", {}, execute);
    const result = service.readReviewComments("owner", "repo", 7, execute, "https://api.github.com");
    if (count > 1000) await assert.rejects(result, /limit|complete/i);
    else { const values = await result; assert.equal(values.length, count); assert.equal(values.at(-1)?.id, count ? String(count) : undefined); }
    assert.equal(calls, Math.min(10, Math.max(1, Math.ceil(count / 100))));
  });
}

test("review comment pages retain Enterprise API prefixes and reject an unrelated next endpoint", async () => {
  let calls = 0;
  const execute: GhExecute = async (_args, _root, options) => {
    calls++; assert.equal(options.request?.kind, "rest");
    return encodeRestPage(JSON.stringify([item(calls)]), restPageMetadata(200, calls === 1
      ? { link: '<https://ghe.example/api/v3/repos/owner/repo/pulls/7/comments?per_page=100&page=2>; rel="next"' } : {}));
  };
  const service: any = new PullRequestReviewCommentService("/repo", {}, execute);
  assert.equal((await service.readReviewComments("owner", "repo", 7, execute, "https://ghe.example/api/v3")).length, 2);
  assert.equal(calls, 2);
});
