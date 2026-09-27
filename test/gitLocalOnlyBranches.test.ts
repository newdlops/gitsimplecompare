import assert from "node:assert/strict";
import test from "node:test";
import type { LocalBranchStatus } from "../src/graph/graphTypes";
import {
  GitLocalOnlyBranchCache,
  loadLocalOnlyBranchMap,
} from "../src/git/gitLocalOnlyBranches";

/** local-only fixture에 필요한 최소 LocalBranchStatus를 만든다. */
function branch(
  name: string,
  hash: string,
  upstream?: string,
  ahead = 0,
  gone = false
): LocalBranchStatus {
  return {
    name, hash, upstream, ahead, gone,
    behind: 0, current: name === "main", dateIso: "", subject: "",
  };
}

/**
 * `git rev-list --topo-order --parents [--stdin]` 를 작은 DAG 로 흉내 내는 테스트 runner 를 만든다.
 * - stdin(또는 argv)의 revision 중 `^hash` 는 제외, 나머지는 포함으로 보고, 포함 tip 에서 도달 가능한
 *   커밋 중 제외 tip 에서 도달 가능한 커밋을 뺀 뒤 자식이 부모보다 먼저 오도록 출력한다.
 * @param dag 커밋 hash → 부모 hash 목록
 * @param calls 호출 인자와 stdin 을 기록할 배열
 */
function revListRunner(
  dag: Record<string, string[]>,
  calls: Array<{ args: string[]; input?: string }>
) {
  const reach = (starts: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length) {
      const hash = stack.pop()!;
      if (seen.has(hash) || !(hash in dag)) continue;
      seen.add(hash);
      stack.push(...dag[hash]);
    }
    return seen;
  };
  return async (args: string[], _root: string, options?: { signal?: AbortSignal; input?: string }) => {
    calls.push({ args, input: options?.input });
    const revisions = options?.input !== undefined
      ? options.input.split("\n").filter(Boolean)
      : args.filter((arg) => !arg.startsWith("-") && arg !== "rev-list");
    const excluded = reach(revisions.filter((rev) => rev.startsWith("^")).map((rev) => rev.slice(1)));
    const included = [...reach(revisions.filter((rev) => !rev.startsWith("^")))].filter((hash) => !excluded.has(hash));
    const set = new Set(included);
    const children = new Map<string, number>(included.map((hash) => [hash, 0]));
    for (const hash of included) for (const parent of dag[hash]) if (set.has(parent)) children.set(parent, children.get(parent)! + 1);
    const queue = included.filter((hash) => children.get(hash) === 0).sort();
    const lines: string[] = [];
    while (queue.length) {
      const hash = queue.shift()!;
      lines.push(args.includes("--parents") ? [hash, ...dag[hash]].join(" ") : hash);
      for (const parent of dag[hash]) {
        if (!set.has(parent)) continue;
        children.set(parent, children.get(parent)! - 1);
        if (children.get(parent) === 0) queue.push(parent);
      }
    }
    return lines.join("\n");
  };
}

test("local-only branches come from one rev-list that excludes every remote tip via stdin", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const result = await loadLocalOnlyBranchMap(
    "/repo",
    [
      branch("main", "remote", "origin/main", 0),
      branch("feature", "feature", "origin/main", 1),
      branch("solo", "solo"),
    ],
    [{ name: "origin/main", hash: "remote" }],
    undefined,
    revListRunner({ feature: ["remote"], solo: ["root"], remote: ["root"], root: [] }, calls)
  );

  assert.equal(calls.length, 1, "정확한 빠른 경로는 전체 이력을 다시 읽지 않는다");
  assert.deepEqual(calls[0].args, ["rev-list", "--topo-order", "--parents", "--stdin"]);
  assert.equal(calls[0].input, "feature\nsolo\n^remote\n");
  assert.deepEqual([...result].sort(), [
    ["feature", ["feature"]],
    ["solo", ["solo"]],
  ]);
});

test("a mismatched upstream branch is recomputed alone with its own upstream..local range", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  // feature 는 origin/feature 를 추적하지만 origin/main 의 커밋(main-work)을 병합했다(아직 push 전).
  const dag = {
    feature: ["merge"],
    merge: ["feature-base", "main-work"],
    "main-work": ["root"],
    "feature-base": ["root"],
    solo: ["root"],
    root: [],
  };
  const result = await loadLocalOnlyBranchMap(
    "/repo",
    [branch("feature", "feature", "origin/feature", 3), branch("solo", "solo")],
    [
      { name: "origin/feature", hash: "feature-base" },
      { name: "origin/main", hash: "main-work" },
    ],
    undefined,
    revListRunner(dag, calls)
  );

  assert.equal(calls.length, 2, "ahead 수와 다른 브랜치만 좁은 rev-list 로 다시 읽는다");
  assert.deepEqual(calls[1].args, ["rev-list", "--stdin"]);
  assert.equal(calls[1].input, "feature\n^feature-base\n");
  assert.deepEqual(result.get("main-work"), ["feature"]);
  assert.deepEqual(result.get("merge"), ["feature"]);
  assert.deepEqual(result.get("feature"), ["feature"]);
  assert.deepEqual(result.get("solo"), ["solo"], "빠른 경로가 맞은 브랜치 결과는 그대로 유지한다");
  assert.equal(result.has("feature-base"), false);
});

test("a branch tracking a local upstream never trusts the remote-excluding count check", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  // main 에 push 전 커밋 M, feature 는 local main 을 추적하며 origin/other 의 X 를 병합했다.
  // 원격 제외 결과 {F, merge, M} 도 개수 3 이라 ahead 3 과 같지만, 올바른 답은 {F, merge, X} 다.
  const dag = { F: ["merge"], merge: ["M", "X"], M: ["R"], X: ["R"], R: ["root"], root: [] };
  const result = await loadLocalOnlyBranchMap(
    "/repo",
    [branch("main", "M", "origin/main", 1), branch("feature", "F", "main", 3)],
    [
      { name: "origin/main", hash: "R" },
      { name: "origin/other", hash: "X" },
    ],
    undefined,
    revListRunner(dag, calls)
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].input, "F\n^M\n", "로컬 upstream 브랜치는 upstream..local 로 따로 계산한다");
  assert.deepEqual(result.get("X"), ["feature"]);
  assert.deepEqual(result.get("merge"), ["feature"]);
  assert.deepEqual(result.get("F"), ["feature"]);
  assert.deepEqual(result.get("M"), ["main"], "M 은 main 에만 local-only 이고 feature 의 upstream 에는 포함된다");
});

test("many mismatched upstream branches share one full-DAG pass limited to those branches", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const dag: Record<string, string[]> = { "main-work": ["root"], root: [] };
  const branches = [];
  const remoteTips = [{ name: "origin/main", hash: "main-work" }];
  for (let index = 0; index < 20; index++) {
    // 각 브랜치 tip 이 이미 origin/main 에 병합돼, 원격 전체 제외로는 ahead 1 과 어긋난다.
    dag[`base${index}`] = ["root"];
    dag[`tip${index}`] = [`base${index}`];
    dag["main-work"].push(`tip${index}`);
    branches.push(branch(`b${index}`, `tip${index}`, `origin/b${index}`, 1));
    remoteTips.push({ name: `origin/b${index}`, hash: `base${index}` });
  }
  const result = await loadLocalOnlyBranchMap("/repo", branches, remoteTips, undefined, revListRunner(dag, calls));

  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("--parents"));
  assert.equal(calls[1].input?.includes("^"), false);
  for (let index = 0; index < 20; index++) assert.deepEqual(result.get(`tip${index}`), [`b${index}`]);
  assert.equal(result.size, 20);
});

test("branch memberships share commits while each upstream exclusion remains independent", async () => {
  const result = await loadLocalOnlyBranchMap(
    "/repo",
    [
      branch("left", "left", "origin/main", 2),
      branch("right", "right", "origin/release", 2),
    ],
    [
      { name: "origin/main", hash: "base-main" },
      { name: "origin/release", hash: "base-release" },
    ],
    undefined,
    revListRunner({
      left: ["shared"],
      right: ["shared"],
      shared: ["base-main", "base-release"],
      "base-main": ["root"],
      "base-release": ["root"],
      root: [],
    }, [])
  );
  assert.deepEqual(result.get("left"), ["left"]);
  assert.deepEqual(result.get("right"), ["right"]);
  assert.deepEqual(result.get("shared"), ["left", "right"]);
  assert.equal(result.has("root"), false);
});

test("snapshot cache reuses one result and aborts an in-flight rev-list when refs change", async () => {
  let calls = 0;
  let aborts = 0;
  let release: ((value: string) => void) | undefined;
  const cache = new GitLocalOnlyBranchCache("/repo", async (_args, _root, options) => {
    calls++;
    if (calls === 1) {
      return new Promise<string>((resolve, reject) => {
        release = resolve;
        options?.signal?.addEventListener("abort", () => {
          aborts++;
          reject(new Error("cancelled"));
        }, { once: true });
      });
    }
    return revListRunner({ next: ["remote"], remote: [] }, [])(_args, _root, options);
  });
  cache.setLocalBranches([branch("feature", "feature", "origin/main", 1)]);
  cache.setRemoteTips([{ name: "origin/main", hash: "remote" }]);
  const stale = cache.getMap();
  cache.setLocalBranches([branch("feature", "next", "origin/main", 1)]);
  await assert.rejects(stale, /cancelled/);
  assert.equal(aborts, 1);

  const current = await cache.getMap();
  assert.deepEqual(current.get("next"), ["feature"]);
  assert.deepEqual(await cache.getMap(), current);
  assert.equal(calls, 2, "완료 snapshot은 추가 Git 프로세스 없이 재사용한다");
  release?.("");
});
