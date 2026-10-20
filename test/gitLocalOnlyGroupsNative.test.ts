import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLocalOnlyBranchMap } from "../src/git/gitLocalOnlyBranches";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { localOnlyFixture, nativeLocalOnlyOracle } from "./helpers/localOnlyFixture";

for (const [count, groups] of [[16, 1], [16, 2], [160, 1], [40, 2], [160, 2]]) {
  test(`native ${count} branches / ${groups} upstream groups exactly match independent ancestry and preserve HEAD/index`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "gsc-local-only-groups-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = await localOnlyFixture(directory, count, groups), expected = await nativeLocalOnlyOracle(f);
    const head = await readFile(path.join(f.root, ".git/HEAD")), calls: Array<{ args: string[]; input?: string }> = [];
    const index = await readFile(path.join(f.root, ".git/index")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    const actual = await loadLocalOnlyBranchMap(f.root, f.branches, f.remoteTips, undefined, (args, root, options) => {
      calls.push({ args, input: options?.input });
      return options?.input === undefined ? runGit(args, root, { signal: options?.signal })
        : runGitWithInput(args, root, options.input, { signal: options.signal });
    });
    assert.deepEqual(actual, expected); assert.equal(calls.length, count > 16 && groups > 1 ? 2 : 1 + groups);
    for (const call of calls.slice(1)) assert.equal(call.input?.split("\n").filter(line => line.startsWith("^")).length,
      count > 16 && groups > 1 ? 0 : 1);
    assert.deepEqual(await readFile(path.join(f.root, ".git/HEAD")), head);
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; }), index);
  });
}
