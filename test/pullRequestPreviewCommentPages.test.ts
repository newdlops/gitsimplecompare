// Files changed의 comment tail은 파일 API의 별도 3,000개 상한과 섞지 않는다.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequestPreviewFiles } from "../src/git/pullRequestPreviewFiles";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
import type { GhExecute } from "../src/git/ghRunner";

/** 외부 REST만 통제하고 metadata pagination·전체 comment DTO 변환은 실제로 실행한다. */
function fixture(count: number) {
  let comments = 0;
  const execute: GhExecute = async (_args, _root, options) => {
    if (options.request?.kind !== "rest") throw new Error("typed REST fixture required");
    const url = new URL(options.request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/files")) return JSON.stringify([{ filename: "file.ts", status: "modified", additions: 1, deletions: 0 }]);
    comments++;
    assert.equal(options.request.accept, "application/vnd.github-commitcomment.full+json");
    assert.equal(options.request.responseMode, "page");
    const start = (page - 1) * 100;
    const values = Array.from({ length: Math.max(0, Math.min(100, count - start)) }, (_, index) => ({ id: start + index + 1,
      path: "file.ts", line: 1, body: `body ${start + index + 1}`, body_text: "full text", body_html: "<p>full HTML</p>", user: { login: "reviewer" } }));
    const next = new URL(url); next.searchParams.set("page", String(page + 1));
    return encodeRestPage(JSON.stringify(values), restPageMetadata(200, start + values.length < count ? { link: `<${next}>; rel="next"` } : {}));
  };
  return { execute, calls: () => comments };
}

for (const count of [0, 99, 100, 101, 200, 1000, 1001, 3001]) {
  test(`Preview Files retains ${count} review comments or rejects the real remaining tail`, async () => {
    const f = fixture(count), result = fetchPullRequestPreviewFiles("/repo", "owner/repo", 7, f.execute);
    if (count > 1000) await assert.rejects(result, /complete|limit/i);
    else {
      const files = await result; assert.equal(files[0].comments.length, count);
      if (count) { assert.equal(files[0].comments.at(-1)?.body, `body ${count}`); assert.equal(files[0].comments[0].bodyHtml, "<p>full HTML</p>"); }
    }
    assert.equal(f.calls(), Math.min(10, Math.max(1, Math.ceil(count / 100))));
  });
}

test("the changed-files path still reads all thirty pages independently of the comment limit", async () => {
  let filesRead = 0;
  const files = await fetchPullRequestPreviewFiles("/repo", "owner/repo", 7, async (_args, _root, options) => {
    if (options.request?.kind !== "rest") throw new Error("typed REST fixture required");
    if (options.request.path.includes("/comments?")) return encodeRestPage("[]", restPageMetadata(200, {}));
    const page = ++filesRead;
    return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ filename: `file-${(page - 1) * 100 + index}.ts`, status: "modified" })));
  });
  assert.equal(filesRead, 30); assert.equal(files.length, 3000); assert.equal(files.at(-1)?.path, "file-2999.ts");
});

for (const count of [100, 200]) {
  test(`Preview files stop at the known final page for ${count} files`, async () => {
    let reads = 0;
    const files = await fetchPullRequestPreviewFiles("/repo", "owner/repo", 7, async (_args, _root, options) => {
      if (options.request?.kind !== "rest") throw new Error("typed REST required");
      const url = new URL(options.request.path, "https://api.github.com");
      if (url.pathname.endsWith("/comments")) return encodeRestPage("[]", restPageMetadata(200, {}));
      reads++;
      const page = Number(url.searchParams.get("page"));
      const values = Array.from({ length: 100 }, (_, index) => ({ filename: `file-${(page - 1) * 100 + index}.ts`, status: "modified" }));
      const next = new URL(url); next.searchParams.set("page", String(page + 1));
      return encodeRestPage(JSON.stringify(values), restPageMetadata(200, page * 100 < count ? { link: `<${next}>; rel="next"` } : {}));
    });
    assert.equal(files.length, count);
    assert.equal(files.at(-1)?.path, `file-${count - 1}.ts`);
    assert.equal(reads, count / 100);
  });
}
