import assert from "node:assert/strict";
import test from "node:test";
import { GitBranchRefCache } from "../src/git/gitBranchRefCache";
import type { Commit } from "../src/graph/graphTypes";

const FS = "\x1f";

/** 테스트용 topo commit을 짧게 만든다. */
function commit(hash: string, parents: string[] = []): Commit {
  return { hash, parents, authorName: "", authorEmail: "", dateIso: "", refs: [], subject: "" };
}

/** for-each-ref 출력 레코드를 만들어 parser와 실제 명령 경계를 함께 검증한다. */
function ref(hash: string, current: string, name: string, full: string): string {
  return [hash, current, name, full].join(FS);
}

test("complete all-refs page reuses seeded tips and covered selections use no contains calls", async () => {
  const calls: string[][] = [];
  const cache = new GitBranchRefCache("/repo", FS, async (args) => {
    calls.push(args);
    if (args.includes("--contains")) throw new Error("covered commit must not fall back");
    return [ref("tip", "*", "main", "refs/heads/main"), ref("tip", "", "origin/main", "refs/remotes/origin/main")].join("\n");
  });
  cache.seedLocalBranches([{ name: "main", hash: "tip", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]);
  cache.seedRemoteBranches([{ name: "origin/main", hash: "tip" }]);
  await cache.indexPage({ commits: [commit("tip", ["base"]), commit("base")], skip: 0, allRefs: true });
  const [tip, base] = await Promise.all([cache.getBranchesContainingCommit("tip"), cache.getBranchesContainingCommit("base")]);
  assert.equal(calls.length, 0);
  assert.deepEqual(tip.map((item) => [item.name, item.tipHash]), [["main", "tip"], ["origin/main", "tip"]]);
  assert.deepEqual(base.map((item) => item.name), ["main", "origin/main"]);
});

test("merge and overlapping pagination propagate all parents, deduplicate, and exclude remote HEAD", async () => {
  const calls: string[][] = [];
  const cache = new GitBranchRefCache("/repo", FS, async (args) => {
    calls.push(args);
    return [ref("merge", "", "feature", "refs/heads/feature"), ref("merge", "", "origin/feature", "refs/remotes/origin/feature"), ref("merge", "", "origin/HEAD", "refs/remotes/origin/HEAD")].join("\n");
  });
  cache.seedLocalBranches([{ name: "feature", hash: "merge", current: false, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]);
  cache.seedRemoteBranches([{ name: "origin/feature", hash: "merge" }]);
  await cache.indexPage({ commits: [commit("merge", ["left", "right"]), commit("left")], skip: 0, allRefs: true });
  await cache.indexPage({ commits: [commit("left"), commit("right")], skip: 1, allRefs: true });
  const branches = await cache.getBranchesContainingCommit("right");
  assert.equal(calls.filter((args) => args.includes("--contains")).length, 0);
  assert.deepEqual(branches.map((item) => item.name), ["feature", "origin/feature"]);
  assert.equal(calls.length, 0);
});

test("partial windows use one cached correctness fallback and invalidation clears old tip snapshots", async () => {
  const calls: string[][] = [];
  const cache = new GitBranchRefCache("/repo", FS, async (args) => {
    calls.push(args);
    return ref("tip", "", "main", "refs/heads/main");
  });
  cache.seedLocalBranches([{ name: "main", hash: "tip", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]);
  cache.invalidate();
  cache.seedLocalBranches([{ name: "next", hash: "new", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]);
  await cache.indexPage({ commits: [commit("window")], skip: 20, allRefs: true });
  const [first, second] = await Promise.all([cache.getBranchesContainingCommit("missing"), cache.getBranchesContainingCommit("missing")]);
  assert.deepEqual(first, second);
  assert.equal(calls.filter((args) => args.includes("--contains")).length, 1);
  assert.deepEqual((await cache.getCurrentBranches()).map((branch) => branch.name), ["next"]);
  assert.equal(cache.getStats().incomplete, true);
});

test("cumulative generation budget stops a fifth sequential all-ref page and uses exact fallback", async () => {
  const calls: string[][] = [];
  const cache = new GitBranchRefCache("/repo", FS, async (args) => {
    calls.push(args);
    if (!args.includes("--contains")) throw new Error("only exact fallback is permitted");
    return ref("tip", "", "main", "refs/heads/main");
  });
  cache.seedLocalBranches([{ name: "main", hash: "tip", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]);
  for (let page = 0; page < 5; page++) {
    const commits = Array.from({ length: 300 }, (_, index) => commit(`${page}-${index}`));
    cache.indexPage({ commits, skip: page * 300, allRefs: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual((await cache.getBranchesContainingCommit("outside")).map((item) => item.name), ["main"]);
  assert.equal(calls.filter((args) => args.includes("--contains")).length, 1);
  assert.equal(cache.getStats().indexedPages, 4);
  assert.equal(cache.getStats().incomplete, true);
});
