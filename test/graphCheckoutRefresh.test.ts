import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { GitLogService } from "../src/git/gitLogService";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";

/** 실제 HEAD 이동과 느린 보조 조회를 production status 수명 관리자에 연결해 재현한다. */
function fixture(t: TestContext, stage?: string) {
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  /** 단계 진입을 기록하고 지정한 조회만 수동 해제까지 중단한다. */
  const step = async (name: string) => { events.push(name); if (name === stage) { entered(); await paused; } };
  const commits: Commit[] = ["a".repeat(40), "b".repeat(40)].map((hash, index) => ({ hash, parents: [], refs: index ? ["topic"] : ["HEAD", "main"],
    subject: hash, authorName: "Fixture", authorEmail: "fixture@example.invalid", dateIso: "" }));
  const branches: LocalBranchStatus[] = commits.map((commit, index) => ({ name: index ? "topic" : "main", hash: commit.hash,
    current: !!index, ahead: 0, behind: 0, gone: false, subject: commit.subject, dateIso: "" }));
  const service = { repoRoot: "/first", getVirtualCommits: async () => { await step("virtual"); return []; },
    resetGraphBranchIndex: () => undefined,
    cancelGraphBranchContainment: () => undefined, seedGraphBranchTips: () => undefined,
    reindexGraphBranchContainment: () => step("containment") };
  const references = branches.map(branch => ({ name: branch.name, hash: branch.hash, fullRef: `refs/heads/${branch.name}` }));
  const fingerprint = (head: string) => [head, "branch", ...references.map(tip => `${tip.fullRef} ${tip.hash}`), "--worktrees--"].join("\n");
  const context = { repoRoot: service.repoRoot, cause: "checkout", generation: 1, remoteTips: [], references, historyIdentity: "same-topology",
    fingerprint: fingerprint(commits[1].hash), previous: { fingerprint: fingerprint(commits[0].hash), references, historyIdentity: "same-topology" } };
  // 실제 constructor가 tag/detail/read 수명을 구성하게 해 prototype만 복사한 오래된 fixture를 피한다.
  const { panel } = createOperationGraphPanel(t, service as unknown as GitLogService);
  Object.assign(panel, {
    logService: service, loadGeneration: 7, disposed: false, commits, virtualCommits: [], rangeStartIndex: 0,
    branchFilter: { mode: "all" }, invalidLocalRefs: [], lastBranchRefs: references.map(tip => ({ name: tip.name, kind: "local" })),
    readBranches: async () => { await step("branches"); return { branches, invalidRefs: [], worktrees: [] }; },
    publishBranches: () => branches,
    currentBranchFilter: () => ({ mode: "all", visibleRefs: new Set(["main", "topic"]), refs: [] }),
    postGraph: () => { events.push("post"); }, postLoadState: () => { events.push("state"); },
    runDirectGraph: async () => { events.push("fallback"); return true; },
    postBranchFilterOptions: () => undefined, attachLocalOnlyMarkers: () => undefined,
    resetLoadedGraph: () => { events.push("reset"); }, reloadGraph: async () => { events.push("fallback"); },
  });
  t.after(() => { release(); panel.workingTree.cancel("cleanup"); panel.dispose(); });
  return { panel, service, commits, context, events, release, reached };
}

/** Promise 연결을 모두 소비하고 실제 시간 기반 sleep은 피한다. */
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

for (const stage of ["virtual", "containment"]) {
  test(`checkout publishes the new HEAD before a suspended ${stage} read finishes`, { timeout: 5000 }, async t => {
    const f = fixture(t, stage);
    t.after(() => { f.release(); f.panel.workingTree.cancel("cleanup"); });
    let finished = false;
    const reading = f.panel.refreshGraphReferences(f.context).then(() => { finished = true; });
    await f.reached; await settle();
    assert.ok(f.events.includes("post"), "HEAD publication must not wait for secondary reads");
    assert.equal(finished, true, "a completed checkout must release the queue for subsequent graph operations");
    assert.equal(f.commits[1].refs[0], "HEAD"); assert.ok(!f.commits[0].refs.includes("HEAD"));
    f.release(); await reading;
  });
}

for (const change of ["repository", "generation", "dispose"]) {
  test(`checkout cannot publish after ${change} during branch loading`, { timeout: 5000 }, async t => {
    const f = fixture(t, "branches"); t.after(f.release);
    const reading = f.panel.refreshGraphReferences(f.context); await f.reached;
    if (change === "repository") f.panel.logService = { ...f.service, repoRoot: "/second" };
    else if (change === "generation") f.panel.loadGeneration++;
    else f.panel.disposed = true;
    f.release(); await reading;
    assert.deepEqual(f.events, ["branches"]);
    assert.equal(f.commits[0].refs[0], "HEAD");
  });
  test(`a late checkout status cannot overwrite the graph after ${change}`, { timeout: 5000 }, async t => {
    const f = fixture(t, "virtual"); t.after(f.release);
    await f.panel.refreshGraphReferences(f.context); await f.reached;
    const count = f.events.length, latest = [{ hash: "new display" }];
    if (change === "repository") f.panel.logService = { ...f.service, repoRoot: "/second" };
    else if (change === "generation") f.panel.loadGeneration++;
    else f.panel.disposed = true;
    f.panel.virtualCommits = latest;
    f.release(); await settle();
    assert.equal(f.events.length, count); assert.equal(f.panel.virtualCommits, latest);
  });
}

test("an unloaded new HEAD uses a complete graph reload without starting obsolete status", async t => {
  const f = fixture(t); f.panel.commits = [f.commits[0]];
  await f.panel.refreshGraphReferences(f.context);
  assert.deepEqual(f.events, ["reset", "fallback"]);
});
