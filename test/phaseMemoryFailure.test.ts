import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preserveIncompletePhaseMemory } from "./helpers/phaseMemorySummary";
import type { PhaseMemoryResult } from "./helpers/phaseMemorySampler";

test("incomplete resource observations keep their raw failure and cannot overwrite or masquerade as success", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-memory-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failed: PhaseMemoryResult = { complete: false, rootPid: process.pid, observerPid: process.pid + 1,
    intervalMs: 50, samples: [], errors: ["TimeoutExpired: process read timed out"], scope: "fixture" };
  const output = path.join(directory, "result.json"), file = await preserveIncompletePhaseMemory(failed, "rebase", output);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), failed);
  await assert.rejects(preserveIncompletePhaseMemory(failed, "rebase", output), { code: "EEXIST" });
  await assert.rejects(preserveIncompletePhaseMemory({ ...failed, complete: true }, "push", output));
  await assert.rejects(preserveIncompletePhaseMemory(failed, "../escape", output));
});
