import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadStashFilesForView, openStashFile, viewStashContents } from "../src/commands/stash";
import { GitService } from "../src/git/gitService";
import type { CommandDeps } from "../src/commands/shared";
import { parseRefUri } from "../src/utils/uri";
import * as vscode from "./helpers/vscodeMock";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** picker 중 활성 저장소만 전환할 수 있고 실제 서비스는 처음 등록한 root에 고정한다. */
function dependencies(roots: string[]) {
  let active = roots[0];
  const services = new Map(roots.map(root => [root, new GitService(root)]));
  return { services, activate: (root: string) => { active = root; }, deps: {
    changesView: { getActiveRepo: () => active }, registry: { get: (root: string) => services.get(root) },
  } as unknown as CommandDeps };
}

/** 명령이 실제로 연 두 가상 문서 URI에서 같은 Git 콘텐츠 reader로 본문을 확인한다. */
async function openedContents() {
  const opened = vscode.__executedCommands.filter(command => command.id === "vscode.diff").at(-1);
  assert.ok(opened);
  const [left, right] = opened.args.slice(0, 2).map(uri => parseRefUri(uri as any));
  const read = (value: typeof left) => new GitService(value.repoRoot).getFileContentAtRef(value.ref, value.path.slice(1));
  return { left, right, before: await read(left), after: await read(right) };
}

test("stash content diffs show staged plus unstaged, renamed, deleted and newline-named untracked files without applying", async t => {
  const { root } = await safetyFixture(t, "stash-content-bytes");
  await writeFile(join(root, "old.ts"), "renamed contents\n"); await writeFile(join(root, "removed.txt"), "deleted contents\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "more base files");
  await writeFile(join(root, "tracked.txt"), "staged bytes\n"); await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "staged and unstaged bytes\n");
  await git(root, "mv", "old.ts", "renamed.ts"); await rm(join(root, "removed.txt"));
  const untracked = "한글\tline\nfile.txt"; await writeFile(join(root, untracked), "saved untracked bytes\n");
  await git(root, "stash", "push", "-qum", "inspect this stash");
  const deps = dependencies([root]), service = deps.services.get(root)!, entry = (await service.listStashes())[0];
  const statusBefore = await git(root, "status", "--porcelain=v1", "-uall"), head = await git(root, "rev-parse", "HEAD");
  for (const [file, before, after] of [
    ["tracked.txt", "base\n", "staged and unstaged bytes\n"], ["renamed.ts", "renamed contents\n", "renamed contents\n"],
    ["removed.txt", "deleted contents\n", ""], [untracked, "", "saved untracked bytes\n"],
  ]) {
    vscode.__resetWindowMessages();
    await openStashFile(deps.deps, { repoRoot: root, hash: entry.hash, ref: entry.ref, path: file });
    const actual = await openedContents(); assert.equal(actual.before, before, file); assert.equal(actual.after, after, file);
    if (file === untracked) assert.equal(actual.right.ref, `${entry.hash}^3`);
    if (file === "renamed.ts") assert.equal(actual.left.path, "/old.ts");
  }
  assert.equal(await git(root, "status", "--porcelain=v1", "-uall"), statusBefore);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.deepEqual((await service.listStashes()).map(stash => stash.hash), [entry.hash]);
});

test("View Stash Contents keeps the captured repository and hash while the picker waits", async t => {
  const first = await safetyFixture(t, "stash-picker-first"), second = await safetyFixture(t, "stash-picker-second");
  await writeFile(join(first.root, "tracked.txt"), "selected stash bytes\n"); await git(first.root, "stash", "push", "-qm", "selected");
  const f = dependencies([first.root, second.root]), entry = (await f.services.get(first.root)!.listStashes())[0];
  t.mock.method(vscode.window, "showQuickPick", async (items: readonly any[]) => {
    f.activate(second.root);
    await writeFile(join(first.root, "tracked.txt"), "newer stash bytes\n"); await git(first.root, "stash", "push", "-qm", "newer");
    return items[0];
  });
  vscode.__resetWindowMessages();
  await viewStashContents(f.deps, { repoRoot: first.root, hash: entry.hash, ref: entry.ref });
  const actual = await openedContents();
  assert.equal(actual.right.repoRoot, first.root); assert.equal(actual.right.ref, entry.hash); assert.equal(actual.after, "selected stash bytes\n");
  assert.equal(await readFile(join(first.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(second.root, "tracked.txt"), "utf8"), "base\n");
  assert.deepEqual(vscode.__errorMessages, []);
});

test("stash contents handles no stashes, cancel and unavailable selections without mutations", async t => {
  const { root } = await safetyFixture(t, "stash-picker-states"), f = dependencies([root]);
  vscode.__resetWindowMessages(); await viewStashContents(f.deps);
  assert.deepEqual(vscode.__informationMessages, ["No stashes."]);
  await writeFile(join(root, "tracked.txt"), "saved\n"); await git(root, "stash", "push", "-qm", "saved");
  const service = f.services.get(root)!, entry = (await service.listStashes())[0], selection = { repoRoot: root, hash: entry.hash, ref: entry.ref };
  vscode.__resetWindowMessages(); await viewStashContents(f.deps, selection);
  assert.equal(vscode.__executedCommands.length, 0, "cancelling the file picker opens nothing");
  vscode.__resetWindowMessages(); await viewStashContents(f.deps, { ...selection, hash: "a".repeat(40) });
  assert.match(vscode.__errorMessages.join("\n"), /Could not open stash contents/);
  assert.deepEqual((await service.listStashes()).map(stash => stash.hash), [entry.hash]);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("the saved staged snapshot is visible even when the saved working file reverted to its base", async t => {
  const { root } = await safetyFixture(t, "stash-index-only"), f = dependencies([root]);
  await writeFile(join(root, "tracked.txt"), "saved staged only\n"); await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "base\n"); await git(root, "stash", "push", "-qm", "index-only difference");
  const service = f.services.get(root)!, entry = (await service.listStashes())[0], selection = { repoRoot: root, ref: entry.ref, hash: entry.hash };
  assert.deepEqual(await service.stashShowFiles(entry.hash), []);
  vscode.__resetWindowMessages(); await viewStashContents(f.deps, selection);
  assert.deepEqual(vscode.__informationMessages, ["No saved working tree changes. View staged changes from the menu."]);
  vscode.__resetWindowMessages(); vscode.__setQuickPickResult((items: readonly unknown[]) => items[0]);
  await viewStashContents(f.deps, selection, true);
  const actual = await openedContents();
  assert.equal(actual.right.ref, `${entry.hash}^2`); assert.equal(actual.before, "base\n"); assert.equal(actual.after, "saved staged only\n");
  assert.equal(await git(root, "status", "--porcelain"), "");
  assert.equal((await service.listStashes())[0].hash, entry.hash);
});

test("opening many large stashes bounds the completed metadata cache while recent selections stay reusable", async t => {
  const { root } = await safetyFixture(t, "stash-cache-budget"), f = dependencies([root]), service = f.services.get(root)!;
  const files = Array.from({ length: 9000 }, (_, index) => ({ path: `long-directory/saved-file-${index}.ts`, status: "M" as const }));
  let reads = 0;
  t.mock.method(service, "stashShowFiles", async () => { reads++; return files; });
  t.mock.method(service, "resolveStash", async (selection: any) => ({ ...selection, index: 0, message: "saved", relativeDate: "", branch: "main" }));
  const targets = Array.from({ length: 20 }, (_, index) => ({ repoRoot: root, ref: `stash@{${index}}`, hash: (index + 1).toString(16).padStart(40, "0") }));
  for (const target of targets) await loadStashFilesForView(f.deps, target);
  assert.equal(reads, 20);
  await loadStashFilesForView(f.deps, targets.at(-1)!); assert.equal(reads, 20, "the recently viewed stash must still reuse its read");
  await loadStashFilesForView(f.deps, targets[0]); assert.equal(reads, 21, "old large metadata must be evicted instead of growing without a budget");
});
