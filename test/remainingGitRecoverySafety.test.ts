import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { ConflictService, detectOperation } from "../src/git/conflictService";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

/** 실제 복구 manifest의 작업 파일 원문과 stage blob을 읽어 내용 보존을 검증한다. */
async function recoveredFile(root: string, relative: string) {
  const base = join(await git(root, "rev-parse", "--absolute-git-dir"), "gitsimplecompare/operation-recovery");
  for (const entry of await readdir(base)) {
    const directory = join(base, entry);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const file = manifest.files.find((item: { path: string }) => item.path === relative);
    if (!file) continue;
    const index = manifest.index.filter((item: string) => item.endsWith(`\t${relative}`));
    return {
      kind: file.kind,
      working: file.dataFile ? await readFile(join(directory, file.dataFile)) : undefined,
      index: await Promise.all(index.map((item: string) => readFile(join(directory, `${item.split(" ")[1]}.blob`)))),
    };
  }
  throw new Error(`Missing recovery entry: ${relative}`);
}

for (const operation of ["merge", "cherry-pick", "revert"] as const) {
  test(`${operation} Abort backs up unrelated staged bytes before resetting them`, async t => {
    const { root, source } = await prSafetyFixture(t, true);
    await assert.rejects(git(root, operation, operation === "merge" ? "source" : source));
    const original = Buffer.from([0, 255, 13, 10, 42]);
    await writeFile(join(root, "other.txt"), original);
    await git(root, "add", "other.txt");
    await new ConflictService(root).abortOperation(operation);
    assert.equal(await detectOperation(root), "none");
    const recovery = await recoveredFile(root, "other.txt");
    assert.deepEqual(recovery.working, original);
    assert.deepEqual(recovery.index, [original]);
  });
}

/** orig-head에서는 추적하지만 rebase 대상에서는 삭제된 ignored 경로를 만든다. */
async function ignoredFixture(t: TestContext) {
  const { root } = await safetyFixture(t, "ignored-abort");
  await writeFile(join(root, ".gitignore"), "private.local\n");
  await writeFile(join(root, "private.local"), "tracked original\n");
  await git(root, "add", ".gitignore");
  await git(root, "add", "-f", "private.local");
  await git(root, "commit", "-qm", "track ignored config");
  await git(root, "switch", "-qc", "source");
  await git(root, "rm", "private.local");
  await commitText(root, "source\n", "source deletes config");
  await git(root, "switch", "main");
  await commitText(root, "local\n", "local");
  await assert.rejects(git(root, "rebase", "source"));
  return root;
}

for (const action of ["abort", "skip"] as const) {
  test(`rebase ${action} preserves ignored bytes at a recovery target path`, async t => {
    const root = await ignoredFixture(t);
    const content = Buffer.from([255, 0, 8, 10]);
    await writeFile(join(root, "private.local"), content);
    assert.equal(await git(root, "check-ignore", "private.local"), "private.local");
    const service = new ConflictService(root);
    await (action === "abort" ? service.abortOperation("rebase") : service.skipOperation("rebase"));
    assert.deepEqual((await recoveredFile(root, "private.local")).working, content);
    assert.equal(await detectOperation(root), "none");
  });
}

test("rebase Abort preserves an ignored symlink as a link instead of reading its target", async t => {
  const root = await ignoredFixture(t);
  await symlink("../outside-config", join(root, "private.local"));
  await new ConflictService(root).abortOperation("rebase");
  const recovery = await recoveredFile(root, "private.local");
  assert.equal(recovery.kind, "symlink");
  assert.equal(recovery.working?.toString(), "../outside-config");
});

test("rebase Abort refuses to replace an ignored directory whose contents are not backed up", async t => {
  const root = await ignoredFixture(t);
  await mkdir(join(root, "private.local"));
  await writeFile(join(root, "private.local", "nested.txt"), "keep nested work\n");
  await assert.rejects(new ConflictService(root).abortOperation("rebase"), /preserve directory/);
  assert.equal(await detectOperation(root), "rebase");
  assert.equal(await readFile(join(root, "private.local", "nested.txt"), "utf8"), "keep nested work\n");
});

for (const family of ["PR", "branch"] as const) {
  test(`${family} completed Undo keeps index-only edits, HEAD and its snapshot`, async t => {
    const fixture = await prSafetyFixture(t);
    const { root } = fixture;
    const service = family === "PR" ? fixture.service : new BranchOperationService(root);
    if (family === "PR") await fixture.service.squashCherryPick(fixture.pr);
    else await (service as BranchOperationService).squashMerge("source");
    const head = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "other.txt"), "index only\n");
    await git(root, "add", "other.txt");
    await writeFile(join(root, "other.txt"), "other base\n");
    await assert.rejects(service.undoLastOperation(), /staged changes would be reset/);
    assert.equal(await git(root, "show", ":other.txt"), "index only");
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other base\n");
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
    assert.equal(await service.hasUndoSnapshot(), true);
    await git(root, "stash", "push", "-m", "preserve index-only work");
    await service.undoLastOperation();
    assert.notEqual(await git(root, "rev-parse", "HEAD"), head);
    assert.equal(await git(root, "show", "stash@{0}^2:other.txt"), "index only");
  });
}

for (const persistent of [false, true]) {
  test(`stack checkpoint ${persistent ? "persistent" : "one-shot"} I/O failure keeps active Git and concurrent edits`, async t => {
    const { root, base } = await prSafetyFixture(t);
    const metadata = new PullRequestStackMetadataService(root);
    await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: base });
    await git(root, "switch", "stack/one");
    await commitText(root, "stack\n", "stack");
    await git(root, "switch", "main");
    await commitText(root, "advanced main\n", "main");
    await git(root, "switch", "stack/one");
    const service = new PullRequestStackRestackService(root);
    const plan = await service.createPlan("stack/one");
    const rename = fs.promises.rename;
    let injected = 0;
    const mock = t.mock.method(fs.promises, "rename", async (from, to) => {
      if (String(to).endsWith("/gitsimplecompare/stack-restack-state.json") && (persistent || !injected)) {
        const state = JSON.parse(await readFile(from, "utf8"));
        if (state.status === "conflicts") {
          injected++;
          await writeFile(join(root, "other.txt"), "concurrent work\n");
          throw Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
        }
      }
      return rename(from, to);
    });
    await assert.rejects(service.execute(plan), /injected disk full.*\nRecovery stopped/);
    assert.ok(injected);
    assert.equal(await detectOperation(root), "rebase");
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "concurrent work\n");
    const pending = JSON.parse(await readFile(join(root, ".git/gitsimplecompare/stack-restack-state.json"), "utf8"));
    assert.equal(await git(root, "rev-parse", pending.steps[0].snapshotRef), pending.steps[0].beforeHead);
    mock.mock.restore();
    if (!persistent) {
      assert.equal(pending.status, "conflicts");
      assert.ok(pending.steps[0].nativeOperation);
      await writeFile(join(root, "other.txt"), "other base\n");
      await new ConflictService(root).abortOperation("rebase");
      assert.equal(await service.restoreAfterAbort(), root);
    }
  });
}

test("cherry-pick Skip preserves an ignored file introduced by a later sequencer item", async t => {
  const { root } = await safetyFixture(t, "sequencer-ignored");
  await writeFile(join(root, ".gitignore"), "private.local\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-qm", "ignore local config");
  await git(root, "switch", "-qc", "source");
  const first = await commitText(root, "source\n", "first source");
  await writeFile(join(root, "private.local"), "new tracked configuration\n");
  await git(root, "add", "-f", "private.local");
  await git(root, "commit", "-qm", "add configuration");
  const second = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  await commitText(root, "local\n", "local");
  await assert.rejects(git(root, "cherry-pick", first, second));
  await writeFile(join(root, "private.local"), "ignored local work\n");
  await new ConflictService(root).skipOperation("cherry-pick");
  assert.equal((await recoveredFile(root, "private.local")).working?.toString(), "ignored local work\n");
  assert.equal(await detectOperation(root), "none");
});

test("Abort never executes if writing the recovery manifest fails", async t => {
  const { root, source } = await prSafetyFixture(t, true);
  await assert.rejects(git(root, "cherry-pick", source));
  await writeFile(join(root, "other.txt"), "new staged work\n");
  await git(root, "add", "other.txt");
  const write = fs.promises.writeFile;
  t.mock.method(fs.promises, "writeFile", async (file, ...args) => {
    if (String(file).endsWith("/manifest.json")) throw Object.assign(new Error("injected backup write error"), { code: "ENOSPC" });
    return write(file, ...args);
  });
  await assert.rejects(new ConflictService(root).abortOperation("cherry-pick"), /injected backup write error/);
  assert.equal(await detectOperation(root), "cherry-pick");
  assert.equal(await git(root, "show", ":other.txt"), "new staged work");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new staged work\n");
});
