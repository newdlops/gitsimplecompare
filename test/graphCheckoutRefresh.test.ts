import assert from "node:assert/strict";
import test from "node:test";
import { GitGraphPanel } from "../src/webview/graphPanel";

/**
 * 실제 panel의 checkout 후속 메서드에 조회/게시 경계만 주입해 느린 단계의 무효화를 재현한다.
 * @param stage 수동 정지할 표시 조회 단계 @returns panel, 실행 순서, 단계 진입/해제 경계
 */
function fixture(stage?: string) {
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  /** @param name 조회 단계 이름 @returns 해당 단계가 시험 대상일 때만 해제까지 대기한다. */
  const step = async (name: string) => { events.push(name); if (name === stage) { entered(); await paused; } };
  const service = { repoRoot: "/first", reindexGraphBranchContainment: () => step("containment") };
  const panel: any = Object.assign(Object.create(GitGraphPanel.prototype), {
    logService: service, loadGeneration: 7, disposed: false, commits: [], virtualCommits: [], rangeStartIndex: 0,
    workingTree: { cancel: () => undefined },
    sendBranches: async () => { await step("branches"); return []; },
    graphReads: { run: async () => { await step("virtual"); return { reused: true, virtualCommits: [] }; } },
    currentBranchFilter: () => ({ visibleRefs: [], refs: [] }),
    postGraph: () => { events.push("post"); },
    runDirectGraph: () => { throw new Error("Unexpected fallback read"); },
  });
  return { panel, service, events, release, reached };
}

test("a current checkout refresh publishes once after branch, virtual and containment reads", async () => {
  const { panel, events } = fixture();
  await panel.refreshAfterCheckoutAction();
  assert.deepEqual(events, ["branches", "virtual", "containment", "post"]);
});

for (const stage of ["branches", "virtual", "containment"]) {
  for (const change of ["repository", "generation", "dispose"]) {
    test(`checkout display does not continue or publish after ${change} during ${stage}`, { timeout: 5000 }, async t => {
      const { panel, events, release, reached } = fixture(stage);
      t.after(release);
      const reading = panel.refreshAfterCheckoutAction();
      await reached;
      if (change === "repository") panel.logService = { repoRoot: "/second" };
      else if (change === "generation") panel.loadGeneration++;
      else panel.disposed = true;
      const latestVirtual = [{ hash: "new display" }];
      panel.virtualCommits = latestVirtual;
      release(); await reading;
      assert.deepEqual(events, ["branches", "virtual", "containment"].slice(0, ["branches", "virtual", "containment"].indexOf(stage) + 1));
      assert.equal(panel.virtualCommits, latestVirtual);
    });
  }
}
