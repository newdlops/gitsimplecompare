import assert from "node:assert/strict";
import test from "node:test";
import fileIO, { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWorkingContentWithoutStaged, buildWorkingContentWithoutStagedView, diffChunks } from "../src/git/unstagedView";
import { DiffHunkService } from "../src/git/diffHunkService";
import { parseDiff } from "../src/git/diffWorkingRead";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { StashService } from "../src/git/stashService";
import { clearStashReadCache } from "../src/git/stashReadCache";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 단순 전체 LCS 표를 사용하는 독립 기준 구현. 동일 길이는 삭제를 우선해 기존 줄 identity를 보존한다. */
function referenceChunks(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const chunks: Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> = [];
  let i = 0, j = 0, chunk: typeof chunks[number] | undefined;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (chunk) chunks.push(chunk); chunk = undefined; i++; j++;
    } else {
      chunk ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
      if (j >= b.length || i < a.length && dp[i + 1][j] >= dp[i][j + 1]) chunk.aEnd = ++i;
      else chunk.bEnd = ++j;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

test("prefix-only LCS preserves exact repeated-line identities across 3969 input pairs", () => {
  const inputs: string[][] = [[]];
  for (let length = 1; length <= 5; length++) for (let bits = 0; bits < 2 ** length; bits++) {
    inputs.push(Array.from({ length }, (_, i) => bits >> i & 1 ? "b" : "a"));
  }
  for (const a of inputs) for (const b of inputs) assert.deepEqual(diffChunks(a, b), referenceChunks(a, b));
});

test("repeated suffixes retain the existing unstaged text and overlay coordinates", () => {
  const view = buildWorkingContentWithoutStagedView("a\n", "b\n", "a\nb\na\nb\n");
  assert.equal(view.text, "a\na\na\nb\n");
  assert.deepEqual(Array.from(view.indexToHeadLine), [undefined]);
  assert.deepEqual(view.indexToHeadDisplayLine, [1]);
  assert.deepEqual(Array.from(view.workingToViewLine), [2, undefined, 3, 4]);
  assert.equal(buildWorkingContentWithoutStaged("a\n", "b\n", "a\nb\na\nb\n"), view.text);
});

test("long unchanged prefixes no longer consume the full LCS cell budget", () => {
  const prefix = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const head = prefix + "last\n", index = prefix + "staged\nlast\n", working = prefix + "staged\nchanged\n";
  const view = buildWorkingContentWithoutStagedView(head, index, working);
  assert.equal(view.text, prefix + "changed\n");
  assert.equal(buildWorkingContentWithoutStaged(head, index, working), view.text);
});

test("cursor diff parser retains final-newline, empty, binary and multiple-file sections", () => {
  assert.deepEqual(parseDiff("", "staged"), []);
  const raw = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file";
  for (const ending of ["", "\n", "\n\n"]) {
    assert.deepEqual(parseDiff(raw + ending, "unstaged"), [{ stage: "unstaged", path: "a.txt", binary: false,
      header: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt",
      hunks: [{ id: "unstaged:a.txt#0", text: "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file" }] }]);
  }
  const result = parseDiff(raw + "\ndiff --git a/b.dat b/b.dat\nBinary files a/b.dat and b/b.dat differ\n", "staged");
  assert.equal(result.length, 2); assert.equal(result[1].binary, true); assert.deepEqual(result[1].hunks, []);
});

test("synthetic untracked diffs read size and executable mode with one stat", async t => {
  const { root } = await safetyFixture(t, "untracked-one-stat");
  const file = join(root, "new.sh"); await writeFile(file, "echo hello\n"); await chmod(file, 0o755);
  let stats = 0; const original = fileIO.stat;
  t.mock.method(fileIO, "stat", async (...args: Parameters<typeof fileIO.stat>) => {
    if (args[0] === file) stats++; return original(...args);
  });
  const files = await new DiffHunkService(root).getFileWorkingDiff("new.sh");
  assert.equal(stats, 1); assert.match(files[0].header, /new file mode 100755/); assert.equal(files[0].hunks.length, 1);
});

for (const action of ["stage", "discard", "commit"] as const) {
  test(`binary ${action} batches literal selected paths and leaves a wildcard neighbor untouched`, async t => {
    const { root } = await safetyFixture(t, `binary-${action}-batch`);
    const names = ["[ab].dat", "other.dat", "a.dat"], before = Buffer.from([0, 1, 2]), after = Buffer.from([0, 3, 4]);
    for (const name of names) await writeFile(join(root, name), before);
    await git(root, "add", "."); await git(root, "commit", "-qm", "binary base");
    for (const name of names) await writeFile(join(root, name), after);
    const service = new DiffHunkService(root), files = await service.getWorkingDiff();
    const picked = names.slice(0, 2).map(path => ({ stage: "unstaged" as const, path, binary: true, hunkIds: [] }));
    const commands: string[] = [], release = setGitExecutionObserver(call => commands.push(call.command));
    try {
      if (action === "stage") await service.stageSelections(files, picked);
      else if (action === "discard") await service.discardSelections(files, picked);
      else await service.commit(files, picked, "binary selections");
    } finally { release(); }
    assert.equal(commands.filter(command => command === (action === "discard" ? "checkout" : "add")).length,
      action === "commit" ? 2 : 1);
    for (const name of names.slice(0, 2)) assert.deepEqual(await readFile(join(root, name)), action === "discard" ? before : after);
    assert.deepEqual(await readFile(join(root, "a.dat")), after);
    const scope = await git(root, "diff", action === "stage" ? "--cached" : "HEAD", "--name-only", "-z");
    assert.deepEqual(scope.split("\0").filter(Boolean).sort(), action === "stage" ? names.slice(0, 2).sort() : ["a.dat"]);
  });
}

test("stash untracked paths are shared across service instances without caching failures", async t => {
  const { root } = await safetyFixture(t, "stash-immutable-paths");
  clearStashReadCache(); t.after(clearStashReadCache);
  await writeFile(join(root, "new.txt"), "new\n"); await git(root, "stash", "push", "-qum", "new file");
  const [entry] = await new StashService(root).list();
  let reads = 0; const release = setGitExecutionObserver(call => { if (call.command === "stash") reads++; });
  try {
    const plans = await Promise.all(Array.from({ length: 5 }, () =>
      new StashService(root).fileComparison(entry.hash, { status: "A", path: "new.txt" })));
    assert.ok(plans.every(plan => plan.target === `${entry.hash}^3`)); assert.equal(reads, 1);
    await assert.rejects(new StashService(root).fileComparison("a".repeat(40), { status: "A", path: "missing" }));
    await assert.rejects(new StashService(root).fileComparison("a".repeat(40), { status: "A", path: "missing" }));
    assert.equal(reads, 3);
  } finally { release(); }
});

test("an aggregate synthetic budget retains deferred paths and scoped reads restore selectable hunks", async t => {
  const { root } = await safetyFixture(t, "synthetic-total-budget"), service = new DiffHunkService(root);
  const names = ["first.txt", "second.txt", "third.txt"];
  for (const name of names) await writeFile(join(root, name), "line\n".repeat(20));
  const files = await service.getWorkingDiff({ syntheticByteBudget: 100 });
  assert.deepEqual(files.map(file => file.path).sort(), names);
  assert.equal(files.filter(file => !file.deferred).length, 1);
  const deferred = files.find(file => file.deferred)!;
  assert.equal(deferred.binary, false); assert.deepEqual(deferred.hunks, []);
  const picked = [{ path: deferred.path, stage: "unstaged" as const, binary: false, hunkIds: [] as string[] }];
  await assert.rejects(service.stageSelections(files, picked), /Load the selected file changes/);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
  const scoped = await service.getFileWorkingDiff(deferred.path);
  assert.equal(scoped.length, 1); assert.equal(scoped[0].deferred, undefined); assert.equal(scoped[0].hunks.length, 1);
  picked[0].hunkIds = scoped[0].hunks.map(hunk => hunk.id);
  await service.stageSelections(scoped, picked);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), deferred.path);
});
