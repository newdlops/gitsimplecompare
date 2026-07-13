import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitService, type StatusGroups } from "../src/git/gitService";
import {
  StatusCache,
  StatusSourceFence,
  statusGroupsSignature,
  statusRefreshFreshness,
} from "../src/git/statusCache";

/** 외부에서 완료 순서를 제어할 수 있는 테스트용 Promise 묶음. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * 비동기 캐시 조회의 완료 순서를 테스트가 직접 제어할 수 있게 deferred Promise 를 만든다.
 * @returns promise 와 resolve/reject 함수를 함께 가진 제어 객체
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * 테스트 값이 호출자 변경으로 캐시를 오염시키지 않도록 새 객체로 복제한다.
 * @param value 복제할 label 객체
 * @returns 같은 label 을 가진 새 객체
 */
function cloneLabel(value: { label: string }): { label: string } {
  return { ...value };
}

test("invalidate 원인과 무관하게 generation을 증가시킨다", () => {
  const cache = new StatusCache(cloneLabel);
  assert.equal(cache.getGeneration(), 0);
  assert.equal(cache.isGenerationCurrent(0), true);

  cache.invalidate();
  assert.equal(cache.getGeneration(), 1);
  assert.equal(cache.isGenerationCurrent(0), false);

  const service = new GitService("/unused");
  assert.equal(service.getStatusGeneration(), 0);
  service.invalidateStatusCache(false);
  assert.equal(service.getStatusGeneration(), 1);
  assert.equal(service.isStatusGenerationCurrent(0), false);
  service.invalidateStatusCache();
  assert.equal(service.getStatusGeneration(), 2);
});

test("invalidate 이전 조회가 늦게 완료돼도 새 세대 캐시를 덮지 않는다", async () => {
  const cache = new StatusCache(cloneLabel);
  const old = deferred<{ label: string }>();
  const oldRead = cache.read(() => old.promise);

  cache.invalidate();
  const currentRead = cache.read(async () => ({ label: "current" }));
  assert.deepEqual(await currentRead, { label: "current" });

  old.resolve({ label: "old" });
  assert.deepEqual(await oldRead, { label: "old" });
  assert.deepEqual(await cache.get(1000), { label: "current" });
});

test("같은 세대에서도 더 오래된 강제 조회는 최신 캐시를 덮지 않는다", async () => {
  const cache = new StatusCache(cloneLabel);
  const old = deferred<{ label: string }>();
  const current = deferred<{ label: string }>();
  const oldRead = cache.read(() => old.promise);
  const currentRead = cache.read(() => current.promise);

  current.resolve({ label: "current" });
  assert.deepEqual(await currentRead, { label: "current" });
  old.resolve({ label: "old" });
  assert.deepEqual(await oldRead, { label: "old" });

  assert.deepEqual(await cache.get(1000), { label: "current" });
});

test("오래된 조회의 실패가 최신 완료 캐시를 지우지 않는다", async () => {
  const cache = new StatusCache(cloneLabel);
  const old = deferred<{ label: string }>();
  const oldRead = cache.read(() => old.promise);
  const currentRead = cache.read(async () => ({ label: "current" }));
  await currentRead;

  old.reject(new Error("old read failed"));
  await assert.rejects(oldRead, /old read failed/);
  assert.deepEqual(await cache.get(1000), { label: "current" });
});

test("낮은 상세도 캐시는 통계를 요구하는 조회에 재사용하지 않는다", async () => {
  const cache = new StatusCache(cloneLabel);
  await cache.read(async () => ({ label: "status-only" }), 0);

  assert.equal(cache.get(1000, 1), undefined);
  await cache.read(async () => ({ label: "with-stats" }), 1);
  assert.deepEqual(await cache.get(1000, 1), { label: "with-stats" });
  assert.deepEqual(await cache.get(1000, 0), { label: "with-stats" });
});

test("includeStats false는 porcelain 한 번만 읽고 기본 조회는 통계를 다시 보강한다", async () => {
  const service = new GitService("/unused");
  const commands: string[][] = [];
  const runnable = service as unknown as {
    run: (args: string[]) => Promise<string>;
  };
  runnable.run = async (args: string[]) => {
    commands.push(args);
    return args[0] === "status" ? " M tracked.txt\0" : "";
  };

  const statusOnly = await service.getStatusGroups({
    force: true,
    includeStats: false,
  });
  assert.deepEqual(statusOnly, {
    staged: [],
    unstaged: [{ status: "M", path: "tracked.txt", oldPath: undefined }],
  });
  assert.deepEqual(commands.map((args) => args[0]), ["status"]);

  await service.getStatusGroups({ includeStats: false });
  assert.deepEqual(commands.map((args) => args[0]), ["status"]);

  const withStats = await service.getStatusGroups();
  assert.deepEqual(commands.map((args) => args[0]), [
    "status",
    "status",
    "diff",
    "diff",
  ]);
  assert.deepEqual(withStats.unstaged[0], {
    status: "M",
    path: "tracked.txt",
    oldPath: undefined,
    additions: 0,
    deletions: 0,
  });
});

test("provider 통계 보강 결과는 authoritative GitService 캐시를 오염시키지 않는다", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsc-status-cache-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });

  const service = new GitService(repoRoot);
  assert.deepEqual(await service.getStatusGroups({ force: true }), {
    staged: [],
    unstaged: [],
  });

  const providerGroups: StatusGroups = {
    staged: [{ status: "M", path: "provider-stale.txt" }],
    unstaged: [],
  };
  const enriched = await service.addStatusStats(providerGroups);
  assert.equal(enriched.staged[0]?.path, "provider-stale.txt");

  assert.deepEqual(await service.getStatusGroups(), {
    staged: [],
    unstaged: [],
  });
});

test("status fingerprint는 통계와 provider 배열 순서에 영향받지 않는다", () => {
  const first: StatusGroups = {
    staged: [
      { status: "M", path: "b.ts", additions: 10, deletions: 2 },
      { status: "A", path: "a.ts" },
    ],
    unstaged: [{ status: "R", path: "new.ts", oldPath: "old.ts" }],
  };
  const reordered: StatusGroups = {
    staged: [
      { status: "A", path: "a.ts", additions: 1, deletions: 0 },
      { status: "M", path: "b.ts" },
    ],
    unstaged: [
      {
        status: "R",
        path: "new.ts",
        oldPath: "old.ts",
        additions: 3,
        deletions: 3,
      },
    ],
  };
  assert.equal(statusGroupsSignature(first), statusGroupsSignature(reordered));
});

test("provider는 CLI 상태와 수렴하기 전까지 fence를 통과하지 못한다", () => {
  const fence = new StatusSourceFence();
  const committed: StatusGroups = { staged: [], unstaged: [] };
  const staleProvider: StatusGroups = {
    staged: [{ status: "M", path: "committed.ts" }],
    unstaged: [],
  };

  fence.protect(committed);
  assert.equal(fence.inspectProvider(staleProvider), "verify");
  fence.reconcile(committed, staleProvider);
  assert.equal(fence.isProtected(), true);
  assert.equal(fence.inspectProvider(committed), "accept");
  assert.equal(fence.isProtected(), false);
});

test("fence 중 실제 외부 변경이면 CLI 검증 뒤 provider 상태를 수용한다", () => {
  const fence = new StatusSourceFence();
  const clean: StatusGroups = { staged: [], unstaged: [] };
  const changed: StatusGroups = {
    staged: [],
    unstaged: [{ status: "M", path: "new-change.ts" }],
  };

  fence.protect(clean);
  assert.equal(fence.inspectProvider(changed), "verify");
  fence.reconcile(changed, changed);
  assert.equal(fence.isProtected(), false);
  assert.equal(fence.inspectProvider(changed), "accept");
});

test("status 최신성은 동일 요청의 generation 변경만 재시도 대상으로 구분한다", () => {
  const current = {
    activeRoot: "/repo",
    requestRoot: "/repo",
    latestRequestId: 7,
    requestId: 7,
    currentGeneration: 4,
    requestGeneration: 4,
  };
  assert.equal(statusRefreshFreshness(current), "current");
  assert.equal(
    statusRefreshFreshness({ ...current, currentGeneration: 5 }),
    "generationChanged"
  );
  assert.equal(
    statusRefreshFreshness({ ...current, latestRequestId: 8 }),
    "superseded"
  );
  assert.equal(
    statusRefreshFreshness({ ...current, activeRoot: "/other" }),
    "superseded"
  );
});
