import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PullService } from "../src/git/pullService";
import { PullRollbackStore } from "../src/git/pullRollbackStore";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

for (const change of ["branch", "head", "upstream"] as const) {
  test(`pull never starts after its prepared ${change} changes during local-state checks`, async t => {
    const f = await safetyFixture(t, `pull-prepare-${change}`); await addOrigin(f.root, f.directory);
    await git(f.root, "switch", "-qc", "incoming");
    await writeFile(join(f.root, "incoming.txt"), "remote content\n"); await git(f.root, "add", "incoming.txt");
    await git(f.root, "commit", "-qm", "incoming"); await git(f.root, "push", "-q", "origin", "HEAD:main");
    await git(f.root, "switch", "main"); await git(f.root, "branch", "other");
    await git(f.root, "branch", "--set-upstream-to=origin/main", "other");
    const service = new PullService(f.root), hasChanges = service.hasLocalChanges.bind(service);
    let expectedHead = "";
    t.mock.method(service, "hasLocalChanges", async () => {
      const value = await hasChanges();
      if (change === "branch") await git(f.root, "switch", "-q", "other");
      if (change === "head") await commitText(f.root, "new user commit\n", "user commit");
      if (change === "upstream") await git(f.root, "config", "branch.main.merge", "refs/heads/missing");
      expectedHead = await git(f.root, "rev-parse", "HEAD");
      await writeFile(join(f.root, "untracked.txt"), "user work\n");
      return value;
    });
    let pulls = 0;
    const release = setGitExecutionObserver(row => { if (row.repoRoot === f.root && row.command === "pull") pulls++; });
    t.after(release);
    await assert.rejects(service.pullCurrent(), /changed|Ref safety|preparation/i);
    assert.equal(pulls, 0);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), expectedHead);
    assert.equal(await git(f.root, "branch", "--show-current"), change === "branch" ? "other" : "main");
    assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "user work\n");
    assert.equal(await git(f.root, "stash", "list"), "");
  });
}

for (const change of ["branch", "head", "upstream"] as const) {
  test(`pull retry stops after its ${change} changes while local work is stashed`, async t => {
    const f = await safetyFixture(t, `pull-retry-${change}`); await addOrigin(f.root, f.directory);
    await git(f.root, "switch", "-qc", "incoming");
    await commitText(f.root, "remote content\n", "incoming");
    await git(f.root, "push", "-q", "origin", "HEAD:main");
    await git(f.root, "switch", "main"); await git(f.root, "branch", "other");
    await git(f.root, "branch", "--set-upstream-to=origin/main", "other");
    await writeFile(join(f.root, "tracked.txt"), "saved local work\n");
    const create = PullRollbackStore.prototype.create;
    let savedHash = "", expectedHead = "";
    t.mock.method(PullRollbackStore.prototype, "create", async function (
      this: PullRollbackStore, ...args: Parameters<typeof create>
    ) {
      const snapshot = await create.apply(this, args);
      assert.ok(snapshot); savedHash = snapshot.hash;
      if (change === "branch") await git(f.root, "switch", "-q", "other");
      if (change === "head") await commitText(f.root, "new user commit\n", "user commit");
      if (change === "upstream") await git(f.root, "config", "branch.main.merge", "refs/heads/missing");
      expectedHead = await git(f.root, "rev-parse", "HEAD");
      await writeFile(join(f.root, "untracked.txt"), "new user work\n");
      return snapshot;
    });
    let pulls = 0;
    const release = setGitExecutionObserver(row => { if (row.repoRoot === f.root && row.command === "pull") pulls++; });
    t.after(release);
    await assert.rejects(new PullService(f.root).pullCurrent(), error => {
      assert.match(String(error), /changed|preparation/i);
      assert.ok(String(error).includes(savedHash), "the error must identify the preserved stash object");
      return true;
    });
    assert.equal(pulls, 1, "the changed checkout must never receive a retry");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), expectedHead);
    assert.equal(await git(f.root, "branch", "--show-current"), change === "branch" ? "other" : "main");
    assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "new user work\n");
    assert.equal(await git(f.root, "show", `${savedHash}:tracked.txt`), "saved local work");
    assert.equal(await git(f.root, "rev-parse", "refs/stash"), savedHash);
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), change === "head" ? "new user commit\n" : "base\n");
  });
}
