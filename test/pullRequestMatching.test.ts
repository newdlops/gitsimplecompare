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
