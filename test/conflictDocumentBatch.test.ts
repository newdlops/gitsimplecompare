import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService, type ConflictDocument } from "../src/git/conflictService";
import { ConflictContentService } from "../src/git/conflictContentService";
import { readConflictWorkingLeaf } from "../src/git/conflictWorktreeCas";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 특수 경로·강제 binary 속성을 포함한 실제 rebase 충돌을 만든다. */
async function fixture(t: TestContext) {
  const fixture = await safetyFixture(t, "conflict-document-batch");
  const { root } = fixture;
  const newline = process.platform === "win32" ? "line name.txt" : "line\nname.txt";
  const magic = process.platform === "win32" ? "literal[1].txt" : ":(glob)*";
  const paths = ["plain.txt", "한글 [literal].txt", newline, "forced.txt", magic, "folder/nested.txt"];
  await mkdir(join(root, "folder"));
  await writeFile(join(root, ".gitattributes"), "forced.txt -diff\n");
  for (const rel of paths) await writeFile(join(root, rel), "base\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "base files");
  const base = await git(root, "rev-parse", "HEAD");
  for (const rel of paths) await writeFile(join(root, rel), "main\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "main files");
  await git(root, "switch", "-qc", "side", base);
  for (const rel of paths) await writeFile(join(root, rel), "side\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "side files");
  await assert.rejects(git(root, "rebase", "main"));
  return { ...fixture, paths, service: new ConflictService(root) };
}

/** 파일별 실패를 성공 데이터로 오인하지 않고 요청 문서를 꺼낸다. */
function value(results: ReadonlyMap<string, PromiseSettledResult<ConflictDocument>>, rel: string): ConflictDocument {
  const result = results.get(rel);
  assert.ok(result && result.status === "fulfilled", `No successful result for ${JSON.stringify(rel)}`);
  return result.value;
}

test("fresh document batches match individual reads with literal paths and one shared query of each kind", { timeout: 45_000 }, async t => {
  const { root, paths, service } = await fixture(t);
  await service.getConflictDocument(paths[0], true, { deferMetadata: true });
  const spawn = childProcess.spawn;
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (spawn as Function)(...args);
  });
  const batch = await service.getConflictDocuments([...paths, paths[0]], true);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(args => args[0] === "ls-files").length, 1);
  assert.equal(calls.filter(args => args[0] === "check-attr").length, 1);
  assert.equal(calls.filter(args => args[0] === "rev-parse").length, 1);
  assert.equal(batch.size, paths.length);
  for (const rel of paths) {
    assert.deepEqual(value(batch, rel), await service.getConflictDocument(rel, true, { deferMetadata: true }));
    assert.equal(value(batch, rel).resultVersion, (await readConflictWorkingLeaf(join(root, rel))).version);
  }
  const read = ConflictContentService.prototype.readDocument;
  const fileReads: string[] = [];
  let activeFiles = 0, peakFiles = 0;
  const observer = t.mock.method(ConflictContentService.prototype, "readDocument", async function (...args) {
    fileReads.push(args[0]); activeFiles++; peakFiles = Math.max(peakFiles, activeFiles);
    try { return await Reflect.apply(read, this, args); } finally { activeFiles--; }
  });
  const skipped = await service.getConflictDocuments(paths, true, { isNeeded: rel => rel !== paths[0] });
  observer.mock.restore();
  assert.equal(skipped.get(paths[0])?.status, "rejected");
  assert.equal(fileReads.includes(paths[0]), false, "A closed consumer must not start its remaining file IO");
  assert.equal(fileReads.length, paths.length - 1);
  assert.equal(peakFiles, 1, "Each batch reads one file at a time to keep native concurrency bounded");
  assert.equal(value(skipped, paths[1]).rel, paths[1]);
  const old = value(batch, paths[0]);
  const previous = new Map([[paths[0], { ...old, metadataState: "ready" as const }]]);
  await writeFile(join(root, paths[0]), "latest worktree text\n");
  const next = value(await service.getConflictDocuments(paths, true, { previous }), paths[0]);
  assert.equal(next.result, "latest worktree text\n");
  assert.notEqual(next.resultVersion, old.resultVersion);
  assert.equal(next.metadataState, "ready");
  await assert.rejects(service.takeOurs(paths[0], old.resultVersion, old.sourceVersion), /changed|Reload/i);
  assert.equal(await readFile(join(root, paths[0]), "utf8"), "latest worktree text\n");

  await writeFile(join(root, ".gitattributes"), "forced.txt diff\n");
  assert.equal(value(await service.getConflictDocuments(paths, true), "forced.txt").resultState.kind, "text");
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  const todo = join(gitDir, "rebase-merge", "git-rebase-todo");
  await writeFile(todo, await readFile(todo, "utf8") + "\n# changed operation epoch\n");
  const changed = value(await service.getConflictDocuments(paths, true, { previous }), paths[0]);
  assert.notEqual(changed.sourceVersion, old.sourceVersion);
  assert.equal(changed.metadataState, "pending");
  await assert.rejects(service.takeOurs(paths[0], changed.resultVersion, old.sourceVersion), /sources changed|Reload/i);
  assert.equal(await readFile(join(root, paths[0]), "utf8"), "latest worktree text\n");
});

test("a resolved file and unsafe parent cannot hide another file's successful document", { skip: process.platform === "win32", timeout: 45_000 }, async t => {
  const { root, directory, paths, service } = await fixture(t);
  await git(root, "add", "--", "plain.txt");
  const outside = join(directory, "outside"); await mkdir(outside);
  await writeFile(join(outside, "nested.txt"), "external text must stay private\n");
  const originalDirectory = join(root, "folder-original");
  await rename(join(root, "folder"), originalDirectory);
  await symlink(outside, join(root, "folder"));
  const batch = await service.getConflictDocuments(paths, true);
  assert.equal(batch.get("plain.txt")?.status, "rejected");
  assert.equal(batch.get("folder/nested.txt")?.status, "rejected");
  assert.equal(value(batch, paths[1]).rel, paths[1]);
  assert.equal(await readFile(join(outside, "nested.txt"), "utf8"), "external text must stay private\n");
});

test("empty, unsafe and already cancelled document batches start no Git processes", async t => {
  const { root } = await safetyFixture(t, "conflict-document-batch-invalid");
  const service = new ConflictService(root), spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { calls++; return (spawn as Function)(...args); });
  assert.equal((await service.getConflictDocuments([])).size, 0);
  await assert.rejects(service.getConflictDocuments(["tracked.txt", "../outside.txt"]));
  await assert.rejects(service.getConflictDocuments(["bad\0name.txt"]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.getConflictDocuments(["tracked.txt"], true, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancelling a document batch waits for every owned initial Git query to close", async t => {
  const { root } = await safetyFixture(t, "conflict-document-batch-cancel");
  const service = new ConflictService(root), controller = new AbortController(), spawn = childProcess.spawn;
  let started = 0, closed = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") {
      started++;
      child.once("close", () => { closed++; });
      queueMicrotask(() => controller.abort());
    }
    return child;
  });
  await assert.rejects(service.getConflictDocuments(["tracked.txt"], true, { signal: controller.signal }), { name: "AbortError" });
  assert.ok(started > 0);
  assert.equal(closed, started);
});
