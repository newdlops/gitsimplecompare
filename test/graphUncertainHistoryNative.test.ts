import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { commitText, safetyFixture } from "./helpers/gitSafetyFixture";

/** 자동 transaction이 끝날 때까지 실제 coordinator 상태를 관찰하고 미완료를 명확히 실패시킨다. */
async function settled(panel: any): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!(panel.refreshCoordinator as any).running && !panel.loading) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The automatic native graph transaction did not settle.");
}

test("an unreadable-size topology proof still refreshes real parents and branch membership with unchanged refs", { timeout: 120000 }, async t => {
  const f = await safetyFixture(t, "uncertain-native-graph"), second = await commitText(f.root, "second\n", "second");
  const shallow = join(f.root, ".git", "shallow");
  // Git이 허용하는 중복 shallow 경계로 증거 읽기 상한을 넘기되 실제 Git 조회는 계속 가능하게 한다.
  await writeFile(shallow, `${second}\n`.repeat(30000));
  const service = new GitLogService(f.root), { panel } = createOperationGraphPanel(t, service);
  // 조기 페이지의 remote-unknown 전환이 우연히 cache를 비워 주는 경로에도 의존하지 않는다.
  t.mock.method(service, "usesNativeBranchSnapshot", () => false);
  t.after(async () => { panel.dispose(); await disposeWorkingTreeSnapshots(); });
  await panel.runDirectGraph("ready");
  assert.equal(panel.commits.length, 1);
  const before = await readGraphRefreshSnapshot(f.root);
  assert.equal(before.historyUncertain, true);
  await writeFile(shallow, `${f.head}\n`.repeat(30000));
  const after = await readGraphRefreshSnapshot(f.root);
  assert.equal(after.fingerprint, before.fingerprint, "this regression requires identical refs and unavailable topology proofs");
  /** 자동 watcher 경로로 갱신한 전체 topology/ref/local-only 값을 독립적인 새 Git 서비스와 대조한다. */
  const reconcile = async () => {
    await panel.refreshCoordinator.request({ repoRoot: f.root, cause: "gitWatcher", mode: "none" }); await settled(panel);
    const fresh = new GitLogService(f.root);
    fresh.seedGraphBranchTips((await fresh.getLocalBranchSnapshot()).branches, []);
    const native = await fresh.getCommitPage(300, 0, [], true);
    const values = (commits: any[]) => commits.map(({ hash, parents, refs, localOnlyBranches }) => ({ hash, parents,
      refs: [...refs].sort(), localOnlyBranches: [...(localOnlyBranches || [])].sort() }));
    assert.deepEqual(values(panel.commits), values(native));
  };
  await reconcile();
  assert.equal(panel.commits.length, 2); assert.deepEqual(panel.commits[0].parents, [f.head]);
  await rm(shallow); await reconcile();
  assert.equal(panel.commits.length, 2); assert.deepEqual(panel.commits[0].parents, [f.head]);
});
