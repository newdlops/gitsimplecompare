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

test("all local-only branches are derived from one topo-order rev-list", async () => {
  const calls: string[][] = [];
  const result = await loadLocalOnlyBranchMap(
    "/repo",
    [
      branch("main", "remote", "origin/main", 0),
      branch("feature", "feature", "origin/main", 1),
      branch("solo", "solo"),
    ],
    [{ name: "origin/main", hash: "remote" }],
    undefined,
    async (args) => {
      calls.push(args);
      return [
        "feature remote",
        "solo root",
        "remote root",
        "root",
      ].join("\n");
    }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["rev-list", "--topo-order", "--parents"]);
  assert.deepEqual([...result], [
    ["feature", ["feature"]],
    ["solo", ["solo"]],
  ]);
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
    async () => [
      "left shared",
      "right shared",
      "shared base-main base-release",
      "base-main root",
      "base-release root",
      "root",
    ].join("\n")
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
    return "next remote\nremote";
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
