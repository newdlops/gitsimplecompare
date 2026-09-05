import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitBranchRefCache } from "../src/git/gitBranchRefCache";
import { runGit } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";

const FS = "\x1f";

/** 테스트용 topo commit을 짧게 만든다. */
function commit(hash: string, parents: string[] = []): Commit {
  return { hash, parents, authorName: "", authorEmail: "", dateIso: "", refs: [], subject: "" };
}

/** for-each-ref 출력 레코드를 만들어 parser와 실제 명령 경계를 함께 검증한다. */
function ref(hash: string, current: string, name: string, full: string): string {
  return [hash, current, name, full].join(FS);
}

/** 이름과 tip으로 로컬 snapshot을 만들며, 생략한 상태 값은 containment와 무관한 기본값이다. */
function branch(name: string, hash: string, current = false): LocalBranchStatus {
  return { name, hash, current, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" };
}

/** Git 조회의 완료/실패 순서를 직접 제어해 캐시 교체와 이전 요청의 경쟁을 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectError) => {
    resolve = resolveValue;
    reject = rejectError;
  });
  return { promise, resolve, reject };
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

test("an unindexed parent uses Git until all of its children have been traversed", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => {
    calls++;
    return [ref("left", "", "left", "refs/heads/left"), ref("right", "", "right", "refs/heads/right")].join("\n");
  });
  cache.seedLocalBranches([branch("left", "left"), branch("right", "right")]);
  cache.seedRemoteBranches([]);
  cache.indexPage({ commits: [commit("left", ["base"])], skip: 0, allRefs: true });

  assert.deepEqual((await cache.getBranchesContainingCommit("base")).map((item) => item.name), ["left", "right"]);
  assert.equal(calls, 1, "아직 방문하지 않은 부모의 부분 membership은 완전한 결과가 아니다");
  cache.indexPage({ commits: [commit("right", ["base"]), commit("base")], skip: 1, allRefs: true });
  assert.deepEqual((await cache.getBranchesContainingCommit("base")).map((item) => item.name), ["left", "right"]);
  assert.equal(calls, 1, "모든 자식을 방문한 뒤에는 DAG 색인을 다시 사용한다");
});

test("missing branch catalogs cannot make a covered commit look branchless", async () => {
  for (const seeded of ["none", "local", "remote"] as const) {
    let calls = 0;
    const cache = new GitBranchRefCache("/repo", FS, async () => {
      calls++;
      return [ref("tip", "*", "main", "refs/heads/main"), ref("tip", "", "origin/main", "refs/remotes/origin/main")].join("\n");
    });
    if (seeded === "local") cache.seedLocalBranches([branch("main", "tip", true)]);
    if (seeded === "remote") cache.seedRemoteBranches([{ name: "origin/main", hash: "tip" }]);
    cache.indexPage({ commits: [commit("tip")], skip: 0, allRefs: true });
    assert.deepEqual((await cache.getBranchesContainingCommit("tip")).map((item) => item.name), ["main", "origin/main"], seeded);
    assert.equal(calls, 1);
  }
});

test("explicitly empty catalogs permit an indexed branchless commit without extra Git work", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => { calls++; return ""; });
  cache.seedLocalBranches([]);
  cache.seedRemoteBranches([]);
  cache.indexPage({ commits: [commit("tagged")], skip: 0, allRefs: true });
  assert.deepEqual(await cache.getBranchesContainingCommit("tagged"), []);
  assert.equal(calls, 0);
});

test("local and remote snapshot replacement evicts completed fallback results", async () => {
  let calls = 0;
  let output = ref("old", "", "feature", "refs/heads/feature");
  const cache = new GitBranchRefCache("/repo", FS, async () => { calls++; return output; });
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0].tipHash, "old");

  output = ref("new", "*", "main", "refs/heads/main");
  cache.seedLocalBranches([branch("main", "new", true)]);
  assert.deepEqual(await cache.getBranchesContainingCommit("outside"), [
    { name: "main", tipHash: "new", kind: "local", current: true },
  ]);

  output = "";
  cache.seedRemoteBranches([]);
  assert.deepEqual(await cache.getBranchesContainingCommit("outside"), []);
  assert.equal(calls, 3);
});

test("a moved branch outside the loaded DAG cannot reuse old containment", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => {
    calls++;
    return ref("new", "*", "main", "refs/heads/main");
  });
  cache.seedLocalBranches([branch("main", "old", true)]);
  cache.seedRemoteBranches([]);
  cache.indexPage({ commits: [commit("old", ["base"]), commit("base")], skip: 0, allRefs: true });
  assert.equal((await cache.getBranchesContainingCommit("base"))[0].tipHash, "old");
  assert.equal(calls, 0);

  cache.seedLocalBranches([branch("main", "new", true)]);
  assert.equal((await cache.getBranchesContainingCommit("base"))[0]?.tipHash, "new");
  assert.equal(calls, 1, "새 tip과 기존 페이지의 연결 관계는 Git으로 확인한다");
});

test("snapshot replacement prevents coalescing with an old in-flight fallback", async () => {
  const pending = [deferred<string>(), deferred<string>()];
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, () => pending[calls++].promise);
  const previous = cache.getBranchesContainingCommit("outside");
  await Promise.resolve();
  cache.seedLocalBranches([branch("main", "new", true)]);
  const current = cache.getBranchesContainingCommit("outside");
  await Promise.resolve();
  pending[1].resolve(ref("new", "*", "main", "refs/heads/main"));
  pending[0].resolve(ref("old", "", "removed", "refs/heads/removed"));
  assert.equal((await current)[0].tipHash, "new");
  await previous;
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0].tipHash, "new");
  assert.equal(calls, 2);
});

test("checkout on known tips rebuilds current branch ordering without extra Git work", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => { calls++; return ""; });
  cache.seedLocalBranches([branch("main", "tip", true), branch("feature", "tip")]);
  cache.seedRemoteBranches([]);
  cache.indexPage({ commits: [commit("tip", ["base"]), commit("base")], skip: 0, allRefs: true });
  assert.equal((await cache.getBranchesContainingCommit("base"))[0].name, "main");

  cache.seedLocalBranches([branch("main", "tip"), branch("feature", "tip", true)]);
  const result = await cache.getBranchesContainingCommit("base");
  assert.deepEqual(result.map((item) => [item.name, item.current]), [["feature", true], ["main", false]]);
  assert.equal(calls, 0);
});

test("invalidation requires new catalogs before the next complete page can use the index", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => {
    calls++;
    return ref("tip", "*", "main", "refs/heads/main");
  });
  cache.seedLocalBranches([branch("main", "tip", true)]);
  cache.seedRemoteBranches([]);
  cache.indexPage({ commits: [commit("tip")], skip: 0, allRefs: true });
  await cache.getBranchesContainingCommit("tip");
  cache.invalidate();
  cache.indexPage({ commits: [commit("tip")], skip: 0, allRefs: true });
  assert.equal((await cache.getBranchesContainingCommit("tip"))[0]?.name, "main");
  assert.equal(calls, 1);
});

test("hiding the graph discards fallback results from the previous lifecycle", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async () => {
    calls++;
    return ref(`tip-${calls}`, "*", "main", "refs/heads/main");
  });
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0].tipHash, "tip-1");
  cache.cancelWarmup("hidden");
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0].tipHash, "tip-2");
  assert.equal(calls, 2);
});

test("a transient Git failure is shared but retried on the next selection", async () => {
  const failed = deferred<string>();
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, () => {
    calls++;
    return calls === 1 ? failed.promise : Promise.resolve(ref("tip", "*", "main", "refs/heads/main"));
  });
  const first = cache.getBranchesContainingCommit("outside");
  const second = cache.getBranchesContainingCommit("outside");
  await Promise.resolve();
  failed.reject(new Error("temporary Git failure"));
  assert.deepEqual(await Promise.all([first, second]), [[], []]);
  assert.equal(calls, 1);
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0]?.name, "main");
  assert.equal(calls, 2);
});

test("an old failed fallback cannot evict the new snapshot's successful result", async () => {
  const failed = deferred<string>();
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, () => {
    calls++;
    return calls === 1 ? failed.promise : Promise.resolve(ref("new", "*", "main", "refs/heads/main"));
  });
  const previous = cache.getBranchesContainingCommit("outside");
  await Promise.resolve();
  cache.seedRemoteBranches([]);
  const current = cache.getBranchesContainingCommit("outside");
  await Promise.resolve();
  failed.reject(new Error("old read failed"));
  await previous;
  assert.equal((await current)[0]?.tipHash, "new");
  assert.equal((await cache.getBranchesContainingCommit("outside"))[0]?.tipHash, "new");
  assert.equal(calls, 2);
});

test("a successful empty fallback stays cached and result mutations remain isolated", async () => {
  let calls = 0;
  const cache = new GitBranchRefCache("/repo", FS, async (args) => {
    calls++;
    return args.includes("branchless") ? "" : ref("tip", "*", "main", "refs/heads/main");
  });
  assert.deepEqual(await cache.getBranchesContainingCommit("branchless"), []);
  assert.deepEqual(await cache.getBranchesContainingCommit("branchless"), []);
  const result = await cache.getBranchesContainingCommit("outside");
  result[0].name = "changed by caller";
  result.push({ name: "extra", kind: "local", current: false });
  assert.deepEqual((await cache.getBranchesContainingCommit("outside")).map((item) => item.name), ["main"]);
  assert.equal(calls, 2);
});

test("direct GitLogService details agree with Git before and after loading a page", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-branch-containment-"));
  try {
    await runGit(["init", "-b", "main"], root);
    await runGit(["config", "user.name", "Containment Test"], root);
    await runGit(["config", "user.email", "containment@example.test"], root);
    await runGit(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
    const hash = (await runGit(["rev-parse", "HEAD"], root)).trim();
    await runGit(["branch", "feature"], root);
    await runGit(["update-ref", "refs/remotes/origin/main", hash], root);
    const expected = (await runGit(["for-each-ref", "--contains", hash, "--format=%(refname:short)", "refs/heads", "refs/remotes"], root)).trim().split("\n").sort();
    const service = new GitLogService(root);

    assert.deepEqual((await service.getCommitDetail(hash)).branches.map((item) => item.name).sort(), expected);
    await service.getCommitPage(1, 0, [], false);
    assert.deepEqual((await service.getCommitDetail(hash)).branches.map((item) => item.name).sort(), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
