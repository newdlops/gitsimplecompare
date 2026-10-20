import assert from "node:assert/strict";
import test from "node:test";
import { GraphReadLifecycleCoordinator } from "../src/webview/graphPageLoading";
import type { GraphRefreshContext } from "../src/webview/graphRefreshCoordinator";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";

const A = "a".repeat(40), B = "b".repeat(40);

/** 명시적인 gate로 실제 실행 순서를 검사해 기계 부하나 임의의 sleep에 의존하지 않는다. */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 원본 Git 행과 같은 필드를 가진 최소 테스트 커밋을 새 객체로 만든다. */
function commit(hash = A, refs = ["HEAD", "main"]): Commit {
  return { hash, parents: [], refs, authorName: "Fixture", authorEmail: "fixture@example.invalid", dateIso: "2026-10-20T00:00:00Z", subject: "fixture" };
}

/** 현재 브랜치와 tip을 별도로 바꿀 수 있도록 전체 native branch 행을 만든다. */
function branch(name = "main", hash = A, current = true): LocalBranchStatus {
  return { name, hash, current, ahead: 0, behind: 0, gone: false, dateIso: "2026-10-20T00:00:00Z", subject: "fixture" };
}

/** 선행 원본·정상 fallback·색인을 따로 기록하고 AbortSignal에 즉시 반응하는 서비스다. */
function fixture() {
  const raw = gate<Commit[]>(), started = gate<void>();
  const state = { reads: 0, normal: 0, indexed: 0, aborted: false, native: true, fallback: [commit()] };
  const service = {
    repoRoot: "/fixture", usesNativeBranchSnapshot: () => state.native,
    readUnindexedCommitPage: async (_limit: number, _skip: number, _refs: string[], signal?: AbortSignal) => {
      state.reads++; started.resolve();
      return new Promise<Commit[]>((resolve, reject) => {
        const abort = () => { state.aborted = true; reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })); };
        signal?.addEventListener("abort", abort, { once: true });
        raw.promise.then(value => { signal?.removeEventListener("abort", abort); resolve(value); }, reject);
        if (signal?.aborted) abort();
      });
    },
    indexGraphCommitPage: () => { state.indexed++; },
    getCommitPage: async () => { state.normal++; return state.fallback; },
    getVirtualCommits: async () => { throw new Error("status must not block real history"); },
  };
  const context: GraphRefreshContext = { repoRoot: service.repoRoot, cause: "graphAction", generation: 1,
    fingerprint: `${A}\nrefs/heads/main\nrefs/heads/main ${A}\n--worktrees--`, historyIdentity: "fixture", remoteTips: [] };
  const options = { skip: 0, readLimit: 301, refs: [] as string[], readVirtualCommits: false };
  return { raw, started, state, service, context, options, coordinator: new GraphReadLifecycleCoordinator() };
}

test("first history starts before branch preparation finishes and is indexed only after adoption", async () => {
  const f = fixture(), branchesReady = gate<void>();
  const pending = f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301, async () => {
    await f.coordinator.run(f.service.repoRoot, "branches", async () => { await branchesReady.promise; return [branch()]; });
    return f.coordinator.run(f.service.repoRoot, "page", signal => f.coordinator.readPageData(f.service, { ...f.options, signal }, [branch()]));
  });
  await f.started.promise; assert.equal(f.state.reads, 1);
  f.raw.resolve([commit()]); await Promise.resolve();
  assert.equal(f.state.indexed, 0, "Preloaded history changed containment before fresh branches were ready");
  branchesReady.resolve();
  assert.deepEqual((await pending)?.page, [commit()]);
  assert.equal(f.state.indexed, 1); assert.equal(f.state.normal, 0);
});

for (const changed of ["HEAD", "same-OID checkout", "local tip"] as const) {
  test(`a changed ${changed} discards the early page and reads the final native scope`, async () => {
    const f = fixture();
    const branches = changed === "HEAD" ? [branch("main", B)] : changed === "same-OID checkout" ? [branch("other")]
      : [branch(), branch("topic", B, false)];
    f.raw.resolve([commit(A, changed === "local tip" ? ["HEAD", "main", "topic"] : ["HEAD", "main"])]);
    f.state.fallback = [commit(B, ["HEAD", branches[0].name])];
    const data = await f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301,
      () => f.coordinator.readPageData(f.service, f.options, branches));
    assert.deepEqual(data.page, f.state.fallback);
    assert.equal(f.state.indexed, 0); assert.equal(f.state.normal, 1);
  });
}

test("a changed filter discards all-ref preparation instead of publishing an incorrect range", async () => {
  const f = fixture();
  await f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301,
    () => f.coordinator.readPageData(f.service, { ...f.options, refs: ["topic"] }, [branch()]));
  assert.equal(f.state.aborted, true); assert.equal(f.state.indexed, 0); assert.equal(f.state.normal, 1);
});

test("a new service with the same root cannot consume the earlier repository object's page", async () => {
  const f = fixture(), next = { ...f.service };
  await f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301,
    () => f.coordinator.readPageData(next, f.options, [branch()]));
  assert.equal(f.state.aborted, true); assert.equal(f.state.indexed, 0); assert.equal(f.state.normal, 1);
});

test("hiding a pending Graph aborts the early child and never indexes it", async () => {
  const f = fixture(), resume = gate<void>();
  const pending = f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301, async () => {
    await resume.promise;
    return f.coordinator.readPageData(f.service, f.options, [branch()]);
  });
  await f.started.promise;
  f.coordinator.cancel("hidden");
  assert.equal(f.state.aborted, true); assert.equal(f.state.indexed, 0);
  // 실제 panel은 세대 검사에서 중단한다. 여기서는 그 이후 동일 범위가 와도 이전 결과가 재사용되지 않는지 확인한다.
  resume.resolve(); await pending;
  assert.equal(f.state.indexed, 0); assert.equal(f.state.normal, 1);
});

test("a branch preparation failure cancels the unused early read and preserves the original error", async () => {
  const f = fixture(), error = new Error("branch metadata failed");
  await assert.rejects(f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301, async () => { throw error; }), value => value === error);
  assert.equal(f.state.aborted, true); assert.equal(f.state.indexed, 0); assert.equal(f.state.normal, 0);
});

test("the same unfiltered history failure is propagated without repeating a timed-out read", async () => {
  const f = fixture(), error = Object.assign(new Error("history deadline"), { code: "ETIMEDOUT" });
  f.service.readUnindexedCommitPage = async () => { f.state.reads++; throw error; };
  await assert.rejects(f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301,
    () => f.coordinator.readPageData(f.service, f.options, [branch()])), value => value === error);
  assert.equal(f.state.reads, 1); assert.equal(f.state.normal, 0); assert.equal(f.state.indexed, 0);
});

for (const disabled of ["batch tracking", "uncertain history", "incomplete remote catalog", "filtered reload", "detached"] as const) {
  test(`${disabled} keeps the existing native page path`, async () => {
    const f = fixture();
    if (disabled === "batch tracking") f.state.native = false;
    if (disabled === "uncertain history") f.context.historyUncertain = true;
    if (disabled === "incomplete remote catalog") delete f.context.remoteTips;
    if (disabled === "detached") f.context.fingerprint = `${A}\nDETACHED\n--worktrees--`;
    await f.coordinator.withFirstPagePrefetch(f.service, f.context, disabled !== "filtered reload", 301,
      () => f.coordinator.readPageData(f.service, f.options, [branch()]));
    assert.equal(f.state.reads, 0); assert.equal(f.state.normal, 1); assert.equal(f.state.indexed, 0);
  });
}

test("a current HEAD outside the loaded page does not force a duplicate history query", async () => {
  const f = fixture(), page = [commit(B, ["topic"])];
  f.raw.resolve(page);
  const data = await f.coordinator.withFirstPagePrefetch(f.service, f.context, true, 301,
    () => f.coordinator.readPageData(f.service, f.options, [branch(), branch("topic", B, false)]));
  assert.deepEqual(data.page, page); assert.equal(f.state.normal, 0); assert.equal(f.state.indexed, 1);
});
