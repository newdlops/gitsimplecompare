import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ComparisonService } from "../src/git/comparisonService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

for (const mode of ["remote", "local-dot", "custom-fetch"] as const) {
  test(`upstream comparison uses exact ${mode} refs despite colliding branch and tag names`, async t => {
    const f = await safetyFixture(t, `upstream-identity-${mode}`); await addOrigin(f.root, f.directory);
    const upstreamRef = mode === "local-dot" ? "refs/heads/base" : mode === "custom-fetch" ? "refs/custom/origin/main" : "refs/remotes/origin/main";
    if (mode === "local-dot") {
      await git(f.root, "branch", "base"); await git(f.root, "branch", "--set-upstream-to=base", "main");
    } else if (mode === "custom-fetch") {
      await git(f.root, "config", "remote.origin.fetch", "+refs/heads/*:refs/custom/origin/*");
      await git(f.root, "update-ref", upstreamRef, f.head);
    }
    const current = await commitText(f.root, "base\nlocal change\n", "local change");
    if (mode !== "local-dot") await git(f.root, "branch", mode === "remote" ? "origin/main" : "custom/origin/main");
    else await git(f.root, "tag", "base", current);
    await git(f.root, "tag", "main", f.head);
    const before = { index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")) };
    const service = new ComparisonService(f.root);
    for (const diffBase of ["twoDot", "threeDot"] as const) {
      const value = await service.compareUpstream(diffBase);
      assert.deepEqual(value.changes.map(change => change.path), ["tracked.txt"]);
      assert.equal(value.resolvedBaseHash, f.head);
      assert.equal(value.resolvedTargetHash, current);
      assert.equal(value.sourceBaseRef, upstreamRef);
      assert.equal(value.baseLabel, mode === "local-dot" ? "base" : mode === "remote" ? "origin/main" : "custom/origin/main");
      assert.equal(value.targetLabel, "main");
    }
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before.index);
    assert.deepEqual(await readFile(join(f.root, ".git/config")), before.config);
  });
}
