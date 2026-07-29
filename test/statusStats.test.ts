import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";
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
