import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";
import { syncGraphLocalRefs } from "../src/webview/graphLocalRefs";

/** @param hash 커밋 OID @param refs 화면에 있던 ref @returns ref 갱신에 필요한 실제 Commit 형태 */
function commit(hash: string, refs: string[] = []): Commit {
  return { hash, refs, parents: [], subject: hash, authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-17T00:00:00Z" };
}

/** @param name 브랜치 이름 @param hash tip OID @param current 현재 체크아웃 여부 @returns 표시용 전체 브랜치 상태 */
function branch(name: string, hash: string, current = false): LocalBranchStatus {
  return { name, hash, current, ahead: 0, behind: 0, gone: false, subject: name, dateIso: "2026-10-17T00:00:00Z" };
}

test("checkout ref synchronization preserves unrelated refs and branch order at a shared first tip", () => {
  const commits = [commit("one", ["HEAD", "main", "origin/main", "tag:v1"]), commit("two", ["topic"]), commit("two", ["duplicate-marker"])];
  const branches = [branch("main", "two", true), branch("topic", "two")];
  assert.equal(syncGraphLocalRefs(commits, branches, new Set(["main", "topic"])), true);
  assert.deepEqual(commits.map(item => item.refs), [["origin/main", "tag:v1"], ["HEAD", "main", "topic"], ["duplicate-marker"]]);
});

test("an unloaded visible current branch requests reload but a hidden current branch keeps the graph", () => {
  const branches = [branch("main", "outside", true), branch("topic", "loaded")];
  assert.equal(syncGraphLocalRefs([commit("loaded", ["HEAD"])], branches, new Set(["main", "topic"])), false);
  const commits = [commit("loaded", ["HEAD", "main", "tag:v1"])];
  assert.equal(syncGraphLocalRefs(commits, branches, new Set(["topic"])), true);
  assert.deepEqual(commits[0].refs, ["tag:v1", "topic"]);
});

test("checkout ref synchronization does not repeatedly scan a large graph for every local branch", t => {
  let hashReads = 0;
  const count = 5000, branchCount = 1000;
  const commits = Array.from({ length: count }, (_, index) => {
    const value = commit(`hash-${index}`);
    Object.defineProperty(value, "hash", { get: () => { hashReads++; return `hash-${index}`; }, enumerable: true });
    return value;
  });
  const branches = Array.from({ length: branchCount }, (_, index) => branch(`branch-${index}`, `hash-${count - index - 1}`, index === 0));
  const start = performance.now();
  assert.equal(syncGraphLocalRefs(commits, branches, new Set(branches.map(item => item.name))), true);
  t.diagnostic(JSON.stringify({ commits: count, branches: branchCount, hashReads, elapsedMs: +(performance.now() - start).toFixed(1) }));
  assert.deepEqual(commits.at(-1)!.refs, ["HEAD", "branch-0"]);
  assert.deepEqual(commits[count - branchCount].refs, [`branch-${branchCount - 1}`]);
  assert.ok(hashReads <= 2 * count + branchCount, `checkout display read ${hashReads} commit hashes`);
});
