import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  PULL_REQUEST_INFO_QUERY,
  pullRequestInfoFromGraphQl,
} from "../src/git/pullRequestInfo";
import { pullRequestCommitHashQuery } from "../src/git/pullRequestSearchService";
import { openGraphPullRequest, openStagedPullRequestPreview } from "../src/webview/graphPullRequests";
import { PullRequestPreviewPanel } from "../src/webview/pullRequestPreviewPanel";
import * as vscodeMock from "./helpers/vscodeMock";

interface GraphPrMatchingApi {
  matchingHashes(pr: object): string[];
  rowHashes(pr: object): string[];
}

/**
 * webview의 PR matching 모듈을 격리된 VM에서 로드한다.
 * - hash 계산은 DOM에 의존하지 않으므로 최소 window 객체만 제공해 브라우저 번들 자체를 검증한다.
 * @returns graphPrMatching.js가 window에 공개한 hash 계산 API
 */
function loadGraphPrMatching(): GraphPrMatchingApi {
  const source = readFileSync(
    path.resolve("media", "graph", "graphPrMatching.js"),
    "utf8"
  );
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: "graphPrMatching.js" });
  return (context.window as { GscGraphPrMatching: GraphPrMatchingApi })
    .GscGraphPrMatching;
}

test("PR 응답에서 merge commit을 작업 commit과 분리해 정규화한다", () => {
  const first = "1111111111111111111111111111111111111111";
  const head = "2222222222222222222222222222222222222222";
  const merged = "3333333333333333333333333333333333333333";
  const result = pullRequestInfoFromGraphQl({
    number: 42,
    title: "Merged pull request",
    state: "MERGED",
    headRefOid: head,
    mergeCommit: { oid: merged },
    commits: {
      nodes: [
        { commit: { oid: first } },
        { commit: { oid: head } },
        { commit: { oid: first } },
      ],
    },
  });

  assert.equal(result.mergeHash, merged);
  assert.deepEqual(result.commitHashes, [first, head]);
  assert.equal(result.commitHashes.includes(merged), false);
});

test("공통 PR GraphQL selection이 merge 결과 commit OID를 요청한다", () => {
  assert.match(PULL_REQUEST_INFO_QUERY, /mergeCommit\s*\{\s*oid\s*\}/);
});

test("PR 검색은 단독 7~40자리 commit hash를 대소문자와 공백에 무관하게 인식한다", () => {
  assert.equal(pullRequestCommitHashQuery("  A1B2C3D  "), "a1b2c3d");
  assert.equal(
    pullRequestCommitHashQuery("A".repeat(40)),
    "a".repeat(40)
  );
  assert.equal(pullRequestCommitHashQuery("a1b2c3"), undefined);
  assert.equal(pullRequestCommitHashQuery("a1b2c3g"), undefined);
  assert.equal(pullRequestCommitHashQuery("commit a1b2c3d"), undefined);
});

test("Graph PR 매칭은 merged commit을 포함하고 대표 이동 대상으로 우선한다", () => {
  const matching = loadGraphPrMatching();
  const first = "1111111111111111111111111111111111111111";
  const head = "2222222222222222222222222222222222222222";
  const merged = "3333333333333333333333333333333333333333";
  const pr = {
    commitHashes: [first, head],
    headHash: head,
    mergeHash: merged,
  };

  assert.deepEqual(Array.from(matching.matchingHashes(pr)), [first, head, merged]);
  assert.deepEqual(Array.from(matching.rowHashes(pr)), [merged, head, first]);
});

test("Graph PR은 검증된 외부 URL만 열고 실패에는 성공 로그를 남기지 않는다", async () => {
  vscodeMock.__resetOutputLines();
  vscodeMock.__resetWindowMessages();
  await openGraphPullRequest("/repo", [{ number: 7, url: "https://example.test/pr/7" } as any], 7);
  assert.equal(vscodeMock.__externalUris.length, 1);
  assert.deepEqual(vscodeMock.__warningMessages, []);
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes("graph pull request opened in browser")));
  vscodeMock.__resetWindowMessages();
  await openGraphPullRequest("/repo", [], 7);
  assert.deepEqual(vscodeMock.__warningMessages, ["Pull request #7 is not loaded."]);
  assert.equal(vscodeMock.__externalUris.length, 0);
  vscodeMock.__resetWindowMessages();
  await openGraphPullRequest("/repo", [{ number: 7, url: "" } as any], 7);
  assert.deepEqual(vscodeMock.__warningMessages, ["Unable to open Pull Request #7 on GitHub."]);
  assert.equal(vscodeMock.__externalUris.length, 0);
  vscodeMock.__resetWindowMessages();
  vscodeMock.__setOpenExternalResult(false);
  await assert.rejects(() => openGraphPullRequest("/repo", [{ number: 7, url: "https://example.test/pr/7" } as any], 7), /Unable to open Pull Request #7/);
  vscodeMock.__resetWindowMessages();
  vscodeMock.__setOpenExternalResult(new Error("browser unavailable"));
  await assert.rejects(() => openGraphPullRequest("/repo", [{ number: 7, url: "https://example.test/pr/7" } as any], 7), /browser unavailable/);
  assert.equal(vscodeMock.__outputLines.filter((line) => line.includes("opened in browser")).length, 1);
});

test("번호 없는 staged Preview는 pager 상태와 무관하게 repository service로 연다", () => {
  const original = PullRequestPreviewPanel.createOrShow;
  const calls: unknown[][] = [];
  const extensionUri = { path: "/extension" } as any;
  (PullRequestPreviewPanel as any).createOrShow = (...args: unknown[]) => calls.push(args);
  try {
    openStagedPullRequestPreview(extensionUri, "/exact-repo");
    assert.equal(calls.length, 1);
    assert.equal((calls[0][1] as { repoRoot: string }).repoRoot, "/exact-repo");
    assert.equal(calls[0][0], extensionUri);
    assert.deepEqual(calls[0].slice(2), [undefined, undefined]);
  } finally { (PullRequestPreviewPanel as any).createOrShow = original; }
});
