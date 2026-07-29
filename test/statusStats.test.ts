import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";
import {
  disposeWorkingStatusRefresh,
  refreshWorkingStatus,
} from "../src/commands/workingStatusRefresh";
import type { CommandDeps } from "../src/commands/shared";
import type { StatusGroups } from "../src/git/gitService";
import { attachStatusStats } from "../src/git/statusStats";

test("staged와 unstaged numstat을 직렬 실행하고 같은 통계를 병합한다", async () => {
  const groups: StatusGroups = {
    staged: [{ status: "M", path: "staged.ts" }],
    unstaged: [{ status: "M", path: "unstaged.ts" }],
  };
  const commands: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const result = await attachStatusStats("/unused", groups, async (args) => {
    commands.push(args);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await waitImmediate();
    inFlight--;
    return args.includes("--cached")
      ? "3\t1\tstaged.ts\0"
      : "5\t2\tunstaged.ts\0";
  });

  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    commands.map((args) => args.includes("--cached") ? "staged" : "unstaged"),
    ["staged", "unstaged"]
  );
  assert.deepEqual(result, {
    staged: [
      {
        status: "M",
        path: "staged.ts",
        additions: 3,
        deletions: 1,
      },
    ],
    unstaged: [
      {
        status: "M",
        path: "unstaged.ts",
        additions: 5,
        deletions: 2,
      },
    ],
  });
});

test("activation dispose는 시작 전 fallback과 stats timer를 모두 취소한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = workingStatusHarness();

  await refreshWorkingStatus(harness.deps, { reason: "documentSaved" });
  assert.equal(harness.applied.length, 1);
  disposeWorkingStatusRefresh(harness.deps);
  disposeWorkingStatusRefresh(harness.deps);
  t.mock.timers.tick(1000);
  await Promise.resolve();

  assert.deepEqual(harness.calls, { cli: 0, stats: 0 });
  assert.equal(harness.applied.length, 1);
});

test("activation dispose 뒤 완료된 실행 중 stats 결과는 UI에 적용하지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statsGate = deferred<StatusGroups>();
  const harness = workingStatusHarness(() => statsGate.promise);

  await refreshWorkingStatus(harness.deps, { reason: "vscodeGit:state" });
  t.mock.timers.tick(300);
  assert.equal(harness.calls.stats, 1);

  disposeWorkingStatusRefresh(harness.deps);
  statsGate.resolve({
    staged: [{ status: "M", path: "file.ts", additions: 7, deletions: 2 }],
    unstaged: [],
  });
  await waitImmediate();

  assert.equal(harness.applied.length, 1);
  assert.equal(harness.applied[0].staged[0].additions, undefined);
});

/** working-status timer 수명 테스트에 필요한 최소 CommandDeps와 호출 기록을 만든다. */
function workingStatusHarness(
  enrich: (groups: StatusGroups) => Promise<StatusGroups> =
    async (groups) => groups
): {
  deps: CommandDeps;
  calls: { cli: number; stats: number };
  applied: StatusGroups[];
} {
  const groups: StatusGroups = {
    staged: [{ status: "M", path: "file.ts" }],
    unstaged: [],
  };
  const calls = { cli: 0, stats: 0 };
  const applied: StatusGroups[] = [];
  const service = {
    getStatusGeneration: () => 0,
    mutatedRecently: () => false,
    getStatusGroups: async () => {
      calls.cli++;
      return groups;
    },
    addStatusStats: async (value: StatusGroups) => {
      calls.stats++;
      return enrich(value);
    },
  };
  const deps = {
    registry: { get: () => service },
    changesView: {
      getActiveRepo: () => "/repo",
      setStatusGroups: (value: StatusGroups) => applied.push(value),
    },
    vscodeGitStatus: {
      getStatusGroups: async () => groups,
      getStatusRevision: () => 0,
    },
  } as unknown as CommandDeps;
  return { deps, calls, applied };
}

/** 실행 중 stats 완료 시점을 activation dispose 뒤로 미루는 Promise gate를 만든다. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
