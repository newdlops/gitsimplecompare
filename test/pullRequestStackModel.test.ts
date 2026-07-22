import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPullRequestStacks,
  invalidPullRequestBaseBranches,
  pullRequestBaseCandidates,
  type PullRequestStacksSnapshot,
  type StackPullRequest,
} from "../src/git/pullRequestStackModel";

/** 테스트에서 관계 필드에 집중할 수 있도록 기본 PR 값을 채운다. */
function pr(
  number: number,
  headRefName: string,
  baseRefName: string,
  overrides: Partial<StackPullRequest> = {}
): StackPullRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    headRefName,
    baseRefName,
    author: "octocat",
    isDraft: false,
    ...overrides,
  };
}

/** 후보 계산 테스트에서 쓸 저장소 스냅샷을 만든다. */
function snapshot(pullRequests: StackPullRequest[]): PullRequestStacksSnapshot {
  return {
    repository: "example/repo",
    defaultBranch: "main",
    pullRequests,
    stacks: buildPullRequestStacks(pullRequests),
  };
}

test("base가 이전 PR head를 가리키는 선형 PR들을 한 stack으로 만든다", () => {
  const stacks = buildPullRequestStacks([
    pr(13, "feature/three", "feature/two"),
    pr(11, "feature/one", "main"),
    pr(12, "feature/two", "feature/one"),
  ]);

  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].rootBaseRefName, "main");
  assert.deepEqual(stacks[0].leafHeadRefNames, ["feature/three"]);
  assert.deepEqual(
    stacks[0].pullRequests.map((item) => ({
      number: item.number,
      depth: item.depth,
      parentNumber: item.parentNumber,
      children: item.childNumbers,
    })),
    [
      { number: 11, depth: 0, parentNumber: undefined, children: [12] },
      { number: 12, depth: 1, parentNumber: 11, children: [13] },
      { number: 13, depth: 2, parentNumber: 12, children: [] },
    ]
  );
});

test("한 PR 위에서 갈라진 child PR들을 같은 stack의 leaf로 보존한다", () => {
  const stacks = buildPullRequestStacks([
    pr(1, "feature/root", "main"),
    pr(2, "feature/left", "feature/root"),
    pr(3, "feature/right", "feature/root"),
  ]);

  assert.equal(stacks.length, 1);
  assert.deepEqual(stacks[0].leafHeadRefNames, ["feature/left", "feature/right"]);
  assert.deepEqual(
    stacks[0].pullRequests.map((item) => [item.number, item.depth]),
    [[1, 0], [2, 1], [3, 1]]
  );
});

test("독립 PR은 각각 한 항목짜리 stack으로 표시하고 최근 갱신 stack을 먼저 둔다", () => {
  const stacks = buildPullRequestStacks([
    pr(1, "feature/old", "main", { updatedAt: "2025-01-01T00:00:00Z" }),
    pr(2, "feature/new", "develop", { updatedAt: "2026-01-01T00:00:00Z" }),
  ]);

  assert.equal(stacks.length, 2);
  assert.deepEqual(stacks.map((stack) => stack.pullRequests[0].number), [2, 1]);
  assert.deepEqual(stacks.map((stack) => stack.pullRequests[0].depth), [0, 0]);
});

test("중복 head branch는 모호한 부모로 연결하지 않는다", () => {
  const stacks = buildPullRequestStacks([
    pr(1, "feature/shared", "main"),
    pr(2, "feature/shared", "develop"),
    pr(3, "feature/child", "feature/shared"),
  ]);

  assert.equal(stacks.length, 3);
  const child = stacks.flatMap((stack) => stack.pullRequests)
    .find((item) => item.number === 3);
  assert.equal(child?.parentNumber, undefined);
  assert.equal(child?.depth, 0);
});

test("fork PR head는 표시하되 같은 이름의 base 저장소 PR 관계에만 연결한다", () => {
  const stacks = buildPullRequestStacks([
    pr(1, "feature/shared", "main"),
    pr(2, "feature/shared", "main", {
      isCrossRepository: true,
      headRepositoryOwner: "contributor",
    }),
    pr(3, "feature/child", "feature/shared"),
  ]);
  const entries = stacks.flatMap((stack) => stack.pullRequests);

  assert.equal(entries.find((item) => item.number === 3)?.parentNumber, 1);
  assert.equal(entries.find((item) => item.number === 2)?.parentNumber, undefined);
  assert.deepEqual(pullRequestBaseCandidates(snapshot(entries), 3), [
    "feature/shared",
    "main",
  ]);
});

test("cycle 입력도 무한 순회하지 않고 모든 PR을 정확히 한 번 표시한다", () => {
  const stacks = buildPullRequestStacks([
    pr(1, "feature/a", "feature/b"),
    pr(2, "feature/b", "feature/a"),
  ]);
  const numbers = stacks.flatMap((stack) => stack.pullRequests.map((item) => item.number));

  assert.deepEqual(numbers.sort((a, b) => a - b), [1, 2]);
  assert.equal(new Set(numbers).size, 2);
});

test("base 변경 금지 후보는 자기 head와 모든 descendant head를 포함한다", () => {
  const pullRequests = [
    pr(1, "feature/one", "main"),
    pr(2, "feature/two", "feature/one"),
    pr(3, "feature/three", "feature/two"),
    pr(4, "other/root", "develop"),
  ];

  assert.deepEqual(
    Array.from(invalidPullRequestBaseBranches(pullRequests, 1)).sort(),
    ["feature/one", "feature/three", "feature/two"]
  );
  assert.deepEqual(
    Array.from(invalidPullRequestBaseBranches(pullRequests, 2)).sort(),
    ["feature/three", "feature/two"]
  );
});

test("base QuickPick 후보는 cycle branch를 빼고 다른 PR head와 root base를 중복 없이 남긴다", () => {
  const state = snapshot([
    pr(1, "feature/one", "main"),
    pr(2, "feature/two", "feature/one"),
    pr(3, "other/root", "develop"),
  ]);

  assert.deepEqual(
    pullRequestBaseCandidates(state, 1),
    ["other/root", "main", "develop"]
  );
  assert.deepEqual(
    pullRequestBaseCandidates(state, 2),
    ["feature/one", "other/root", "main", "develop"]
  );
});

test("잘못된 번호/head와 같은 번호의 오래된 응답을 정규화한다", () => {
  const stacks = buildPullRequestStacks([
    pr(0, "invalid/number", "main"),
    pr(1, "", "main"),
    pr(2, "feature/old", "main"),
    pr(2, " feature/new ", " main ", { title: "latest" }),
  ]);

  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].pullRequests.length, 1);
  assert.equal(stacks[0].pullRequests[0].headRefName, "feature/new");
  assert.equal(stacks[0].pullRequests[0].baseRefName, "main");
  assert.equal(stacks[0].pullRequests[0].title, "latest");
});
