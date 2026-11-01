// 전체 pagination은 30초를 넘을 수 있지만 개별 요청 예산과 사용자 취소는 유지한다.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPullRequestConversation } from "../src/git/pullRequestPreviewConversation";
import { encodeRestPage, restPageMetadata } from "../src/git/githubRestPages";
import { captureGitHubRequestContext } from "../src/git/githubReadSession";

/** 실제 35초를 기다리지 않고 native timer를 진행시켜 일곱 페이지의 완전한 결과를 확인한다. */
test("seven successful five-second API pages may complete beyond thirty seconds total", async t => {
  const realTimeout = setTimeout;
  const root = await mkdtemp(join(tmpdir(), "gsc-api-budget-")); t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-c", "init.templateDir=", "init", "-q", root]);
  // Git의 실제 .unref()/process-close timer는 가상화하지 않는다. 설정 발견을 먼저 완료한다.
  await new Promise(resolve => realTimeout(resolve, 5));
  await captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  if (Number(process.versions.node.split(".")[0]) === 18) (t.mock.timers as any).enable(["setTimeout"]);
  else t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = 0, settled = false;
  const loading = buildPullRequestConversation(root, "owner/repo", { number: 7 }, "opening", "author", async (_args, _root, options) => {
    assert.equal(options.request?.kind, "rest"); if (options.request?.kind !== "rest") throw Error("typed REST fixture required");
    started++;
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const url = new URL(options.request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
    const timeline = url.pathname.endsWith("/timeline");
    const items = timeline ? Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1,
      event: "commented", body: `page ${page}`, html_url: `https://github.com/owner/repo/issues/7#issuecomment-${(page - 1) * 100 + index + 1}`,
      user: { login: "author" } })) : [];
    url.searchParams.set("page", String(page + 1));
    return encodeRestPage(JSON.stringify(items), restPageMetadata(200, timeline && page < 7 ? { link: `<${url}>; rel="next"` } : {}));
  });
  // rejection은 즉시 구독하고, timer 진행 사이 실제 fs/context 작업도 완료되게 한다.
  const outcome = loading.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    for (const expected of [3, 4, 5, 6, 7, 8, 9]) {
      const deadline = Date.now() + 2_000;
      while (started < expected && !settled) { assert(Date.now() < deadline, JSON.stringify({ expected, started, settled })); await new Promise(resolve => realTimeout(resolve, 2)); }
      t.mock.timers.tick(5_000);
    }
    const result = await outcome;
    if ("error" in result) throw result.error;
    assert.equal(result.value.length, 701); assert.equal(started, 9);
  } finally { t.mock.timers.reset(); }
});
