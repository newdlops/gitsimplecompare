import assert from "node:assert/strict";
import test from "node:test";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { GraphRefreshLifecycleCoordinator, type GraphRefreshContext, type GraphRefreshRead } from "../src/webview/graphRefreshCoordinator";

/** 고정 sleep 없이 coordinator의 후속 promise와 publish를 처리한다. */
async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

/** lifecycle·오류 기록은 보존하고 필요한 reader/reload만 주입하는 테스트 경계다. */
function coordinator(read: () => Promise<string | GraphRefreshRead>, reload: (context: GraphRefreshContext) => Promise<void>) {
  return new GraphRefreshLifecycleCoordinator({ readFingerprint: read, reloadGraph: reload,
    publishAfterReload: async () => {}, invalidateReload: () => {}, info: () => {}, error: (_event, error) => { throw error; } });
}

test("a fingerprint whose topology cannot be read explicitly requires reconciliation", async () => {
  const root = "/fixture/gsc-missing-topology";
  const head = "a".repeat(40);
  const snapshot = await readGraphRefreshSnapshot(root, async args => args[0] === "for-each-ref"
    ? `refs/heads/main\x1f${head}\x1fmain\n`
    : `worktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\n`);
  assert.equal(snapshot.historyIdentity, undefined);
  assert.equal((snapshot as typeof snapshot & { historyUncertain?: boolean }).historyUncertain, true,
    "a readable ref list must not imply that unreadable topology stayed unchanged");
});

test("unchanged refs still reconcile while history is uncertain and return to idle skipping after recovery", async () => {
  let uncertain = true, reloads = 0;
  const c = coordinator(async () => ({ fingerprint: "same-refs", historyUncertain: uncertain,
    historyIdentity: uncertain ? undefined : "verified" }), async () => { reloads++; });
  try {
    await c.runDirect({ repoRoot: "/fixture", cause: "ready" });
    await c.request({ repoRoot: "/fixture", cause: "gitWatcher", mode: "none" }); await settle();
    assert.equal(reloads, 2, "unknown topology must not be treated as an unchanged successful graph");
    uncertain = false;
    await c.request({ repoRoot: "/fixture", cause: "gitWatcher", mode: "none", force: true }); await settle();
    const known = reloads;
    await c.request({ repoRoot: "/fixture", cause: "gitWatcher", mode: "none" }); await settle();
    assert.equal(reloads, known, "verified unchanged history must keep the existing idle optimization");
  } finally { c.dispose(); }
});

test("discarded watcher requests do not copy a large catalog while the selected reload retains isolated metadata", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let copies = 0, reads = 0, bursts = false;
  const count = 2000;
  const remoteTips = Array.from({ length: count }, (_, index) => ({ get name() { copies++; return `origin/branch-${index}`; },
    kind: "remote" as const, fullRef: `refs/remotes/origin/branch-${index}`, hash: "a".repeat(40) }));
  const selected: GraphRefreshContext[] = [];
  const c = coordinator(async () => {
    reads++;
    if (!bursts) return { fingerprint: "before" };
    await gate;
    return { fingerprint: "after", remoteTips, historyIdentity: "verified" };
  }, async context => { selected.push(context); });
  try {
    await c.runDirect({ repoRoot: "/fixture", cause: "ready" }); selected.length = 0; reads = 0;
    bursts = true;
    const requests = Array.from({ length: 20 }, () => c.request({ repoRoot: "/fixture", cause: "gitWatcher", mode: "none" }));
    release(); await Promise.all(requests); await settle();
    assert.ok(reads <= 2, "watcher bursts must share at most one active and one latest follow-up read");
    assert.equal(selected.length, 1); assert.equal(selected[0].remoteTips?.length, count);
    assert.ok(copies <= count * 2, `discarded consumers copied ${copies} ref objects for one ${count}-row reload`);
    t.diagnostic(JSON.stringify({ notifications: 20, catalogRows: count, copiedRefObjects: copies, fingerprintReads: reads, publishedReloads: selected.length }));
    (selected[0].remoteTips![0] as { name: string }).name = "consumer-owned change";
    assert.equal(remoteTips[0].name, "origin/branch-0", "the selected reload must not mutate the shared reader result");
  } finally { release(); c.dispose(); }
});
