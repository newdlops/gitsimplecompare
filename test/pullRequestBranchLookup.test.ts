import assert from "node:assert/strict";
import test from "node:test";
import { findPullRequestsForBranches } from "../src/git/pullRequestBranchLookup";
import { resolveCurrentPullRequestSelector, type BranchSelectorGit } from "../src/git/pullRequestBranchSelector";
import type { GhExecute } from "../src/git/ghRunner";
import { GitHubApiError } from "../src/git/githubApiError";

/** GitHub branch query가 반환할 필수 filter/표시 필드를 갖는 원본 node다. */
function node(number: number, headRefName: string, state = "MERGED", extra: Record<string, unknown> = {}) {
  return { number, headRefName, state, baseRefName: "main", title: `PR ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`, isCrossRepository: false,
    headRepositoryOwner: { login: "owner" }, ...extra };
}

/** 실제 typed query 변수에 맞는 연결만 반환하며 네트워크·계정·Git 쓰기는 사용하지 않는다. */
function api(nodes: Record<string, ReturnType<typeof node>[]>) {
  let calls = 0;
  const execute: GhExecute = async (_args, _root, options) => {
    calls++;
    assert.equal(options.request?.kind, "graphql");
    const request = options.request!;
    if (request.kind !== "graphql") throw new Error("Expected GraphQL fixture");
    const repository: Record<string, unknown> = { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" } };
    for (const [key, value] of Object.entries(request.variables)) {
      if (key.startsWith("head")) repository[`p${key.slice(4)}`] = { nodes: nodes[String(value)] ?? [] };
      if (key.startsWith("number")) repository[`p${key.slice(6)}`] = Object.values(nodes).flat().find(item => item.number === value);
    }
    return JSON.stringify({ data: { repository } });
  };
  return { execute, count: () => calls };
}

for (const fixture of [{ heads: 1, calls: 1 }, { heads: 8, calls: 1 }, { heads: 21, calls: 2 }, { heads: 40, calls: 2 }]) {
  test(`${fixture.heads} branch selections use ${fixture.calls} bounded GraphQL reads`, async () => {
    const names = Array.from({ length: fixture.heads }, (_, index) => `topic-${index}`);
    const f = api(Object.fromEntries(names.map((name, index) => [name, [node(index + 1, name)]])));
    const result = await findPullRequestsForBranches("/repo", names, {}, f.execute);
    assert.equal(result.size, fixture.heads);
    assert.deepEqual([...result.values()].map(value => value?.number), names.map((_, index) => index + 1));
    assert.equal(f.count(), fixture.calls);
  });
}

test("OPEN wins over a newer closed PR while same-name fork and default-branch closed PRs remain excluded", async () => {
  const f = api({ topic: [node(3, "topic", "CLOSED"), node(2, "topic", "OPEN"), node(1, "topic")],
    fork: [node(5, "fork", "OPEN", { isCrossRepository: true, headRepositoryOwner: { login: "alice" } })],
    main: [node(8, "main")], empty: [] });
  const result = await findPullRequestsForBranches("/repo", ["topic", "fork", "alice:fork", "main", "empty"], {}, f.execute);
  assert.equal(result.get("topic")?.number, 2);
  assert.equal(result.get("fork"), undefined); assert.equal(result.get("alice:fork")?.number, 5);
  assert.equal(result.get("main"), undefined); assert.equal(result.get("empty"), undefined);
});

test("current-branch remote identity and base disambiguation select the right fork PR", async () => {
  const f = api({ topic: [node(9, "topic", "OPEN", { baseRefName: "other", isCrossRepository: true, headRepositoryOwner: { login: "alice" } }),
    node(7, "topic", "OPEN", { isCrossRepository: true, headRepositoryOwner: { login: "alice" } })] });
  const result = await findPullRequestsForBranches("/repo", [{ key: "local", headRefName: "topic", baseRefName: "main",
    headRepository: { host: "github.com", owner: "alice", name: "fork" } }], {}, f.execute);
  assert.equal(result.get("local")?.number, 7);
});

test("only selected PR numbers fetch current body data in the optional second phase", async () => {
  const f = api({ topic: [node(7, "topic", "OPEN", { body: "current body" })] });
  const result = await findPullRequestsForBranches("/repo", ["topic"], { includeBody: true }, f.execute);
  assert.equal(result.get("topic")?.body, "current body"); assert.equal(f.count(), 2);
});

test("GraphQL variables keep quoted branch names out of the document", async () => {
  let variables: unknown, query = "";
  await findPullRequestsForBranches("/repo", ['feature"quote'], {}, async (_args, _root, options) => {
    if (options.request?.kind === "graphql") { variables = options.request.variables.head0; query = options.request.query; }
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" }, p0: { nodes: [] } } } });
  });
  assert.equal(variables, 'feature"quote'); assert(!query.includes('feature"quote'));
});

test("auth, rate-limit, timeout and cancellation failures never fan out into retries", async () => {
  for (const kind of ["auth", "permission", "rate-limit", "timeout", "network"] as const) {
    let calls = 0;
    await assert.rejects(findPullRequestsForBranches("/repo", ["one", "two"], {}, async () => {
      calls++; throw new GitHubApiError(kind, "fixture");
    }), error => (error as { kind?: string }).kind === kind);
    assert.equal(calls, 1);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(findPullRequestsForBranches("/repo", ["one"], { signal: controller.signal }, async () => {
    assert.fail("pre-cancelled branch lookup must not execute");
  }), { name: "AbortError" });
});

test("an affected alias retries alone without discarding a complete sibling", async () => {
  let calls = 0;
  const result = await findPullRequestsForBranches("/repo", ["bad", "good"], { allowPartialFailures: true }, async (_args, _root, options) => {
    calls++;
    const repository = { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" },
      p0: null, ...(calls === 1 ? { p1: { nodes: [node(7, "good")] } } : {}) };
    throw new GitHubApiError("graphql", options.operation, 200, undefined,
      { data: { repository }, errors: [{ type: "INTERNAL", path: ["repository", "p0"] }] });
  });
  assert.equal(result.get("bad"), undefined); assert.equal(result.get("good")?.number, 7); assert.equal(calls, 2);
});

test("a write prerequisite never turns an unresolved alias into an absent PR", async () => {
  let calls = 0;
  await assert.rejects(findPullRequestsForBranches("/repo", ["bad"], {}, async () => {
    calls++;
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", p0: null } },
      errors: [{ type: "INTERNAL", path: ["repository", "p0"] }] });
  }), /Cannot read complete/);
  assert.equal(calls, 2);
});

/** Git 자체의 설정 출력은 고정하되 production snapshot 파서와 선택 순서는 그대로 실행한다. */
function localGit(config: string, push = "", url = "git@github.com:alice/fork.git"): BranchSelectorGit {
  return async args => {
    if (args[0] === "config") return config;
    if (args[0] === "for-each-ref") return push;
    if (args[0] === "remote") return url;
    throw new Error("Unexpected Git fixture operation");
  };
}

test("current branch push tracking takes precedence over fallback configuration", async () => {
  const git = localGit("branch.topic.remote\nother\0push.default\nupstream\0branch.topic.merge\nrefs/heads/old\0",
    "refs/heads/topic\0origin\0refs/heads/pushed\n");
  assert.deepEqual(await resolveCurrentPullRequestSelector("/repo", "topic", undefined, git), {
    key: "topic", headRefName: "pushed", headRepository: { host: "github.com", owner: "alice", name: "fork" } });
});

test("upstream fallback and PR-ref tracking retain gh current-branch semantics", async () => {
  const git = localGit("branch.topic.remote\norigin\0branch.topic.merge\nrefs/heads/renamed\0push.default\nupstream\0");
  assert.equal((await resolveCurrentPullRequestSelector("/repo", "topic", undefined, git)).headRefName, "renamed");
  assert.deepEqual(await resolveCurrentPullRequestSelector("/repo", "topic", undefined,
    localGit("branch.topic.merge\nrefs/pull/17/head\0")), { key: "topic", number: 17 });
});

test("fallback push remote priority and current push mode preserve the local head", async () => {
  for (const [extra, expected] of [["branch.topic.pushremote\npreferred\0remote.pushdefault\nfallback\0", "preferred"],
    ["remote.pushdefault\nfallback\0", "fallback"], ["", "origin"]]) {
    const basic = localGit(`branch.topic.remote\norigin\0branch.topic.merge\nrefs/heads/renamed\0push.default\ncurrent\0${extra}`);
    let selected = "";
    const runner: BranchSelectorGit = async (args, root, options) => {
      if (args[0] === "remote") selected = args[2];
      return basic(args, root, options);
    };
    const result = await resolveCurrentPullRequestSelector("/repo", "topic", undefined, runner);
    assert.equal(result.headRefName, "topic"); assert.equal(selected, expected);
  }
});

test("an SSH host alias selects the same-repository PR after native hostname translation", async () => {
  const git = localGit("branch.topic.remote\norigin\0", "refs/heads/topic\0origin\0refs/heads/topic\n", "git@github-work:owner/repo.git");
  const selector = await resolveCurrentPullRequestSelector("/repo", "topic", undefined, git, undefined,
    async () => "github.com");
  const f = api({ topic: [node(7, "topic", "OPEN")] });
  const result = await findPullRequestsForBranches("/repo", [selector], {}, f.execute);
  assert.equal(result.get("topic")?.number, 7);
});

test("a different or unresolved SSH host cannot select an unrelated same-owner fork PR", async () => {
  const f = api({ topic: [node(9, "topic", "OPEN", { isCrossRepository: true })] });
  await assert.rejects(findPullRequestsForBranches("/repo", [{ key: "topic", headRefName: "topic",
    headRepository: { host: "unresolved-github-work", owner: "owner", name: "repo" } }], {}, f.execute), /Cannot read complete/);
});

test("body enrichment receives its own request budget after a slow successful selection", async t => {
  let now = Date.now(), calls = 0; const budgets: number[] = [];
  t.mock.method(Date, "now", () => now);
  const value = node(7, "topic", "OPEN", { body: "latest user body" });
  const result = await findPullRequestsForBranches("/repo", ["topic"], { includeBody: true }, async (_args, _root, options) => {
    const remaining = options.deadline! - now; budgets.push(remaining);
    const duration = ++calls === 1 ? 20_000 : 15_000;
    assert(duration <= remaining, "a successful prior request must not consume this request's budget");
    now += duration;
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" },
      p0: calls === 1 ? { nodes: [value] } : value } } });
  });
  assert.equal(result.get("topic")?.body, "latest user body"); assert.deepEqual(budgets, [30_000, 30_000]);
});
