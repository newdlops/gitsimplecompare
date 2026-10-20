import assert from "node:assert/strict";
import test from "node:test";
import { GraphRefreshLifecycleCoordinator, type GraphRefreshContext } from "../src/webview/graphRefreshCoordinator";

/** 첫 직접 조회/로드를 잡아 두고 늦은 완료를 결정적으로 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

/** 자동 reconcile의 promise 연결을 소비하되 고정 sleep에 의존하지 않는다. */
async function settle(): Promise<void> { for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

for (const lifecycle of ["visibility", "focus"] as const) for (const stage of ["fingerprint", "reload"] as const) {
  test(`a completed mutation's direct refresh survives ${lifecycle} loss during ${stage} and publishes the newest state once`, async () => {
    const entered = deferred<void>(), readGate = deferred<string>(), reloadGate = deferred<void>();
    const contexts: GraphRefreshContext[] = [], published: string[] = [];
    let fingerprint = "base", held = false;
    const coordinator = new GraphRefreshLifecycleCoordinator({
      readFingerprint: async () => {
        if (fingerprint === "during" && stage === "fingerprint" && !held) { held = true; entered.resolve(); return readGate.promise; }
        return fingerprint;
      },
      reloadGraph: async context => {
        contexts.push(context);
        if (context.fingerprint === "during" && stage === "reload" && !held) { held = true; entered.resolve(); await reloadGate.promise; }
      },
      publishAfterReload: async context => { published.push(context.fingerprint); },
      invalidateReload: () => undefined, info: () => undefined, error: (_event, error) => { throw error; },
    });
    await coordinator.runDirect({ repoRoot: "/fixture", cause: "ready" });
    fingerprint = "during";
    const direct = coordinator.runDirect({ repoRoot: "/fixture", cause: "graphAction" });
    await entered.promise;
    if (lifecycle === "visibility") coordinator.setVisible(false); else coordinator.setFocused(false);
    fingerprint = "latest";
    if (lifecycle === "visibility") coordinator.setVisible(true); else coordinator.setFocused(true);
    await settle();
    readGate.resolve("during"); reloadGate.resolve();
    assert.equal(await direct, false, "superseded direct work cannot claim completion");
    await settle();
    assert.equal(contexts.at(-1)?.fingerprint, "latest");
    assert.equal(contexts.filter(context => context.fingerprint === "latest").length, 1);
    assert.equal(contexts.at(-1)?.cause, "graphAction");
    assert.deepEqual(published, ["latest"]);
    coordinator.dispose();
  });
}
