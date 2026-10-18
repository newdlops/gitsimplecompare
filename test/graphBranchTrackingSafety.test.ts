import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GraphLocalBranchTrackingReader } from "../src/git/graphLocalBranchTracking";
import { readGraphLocalBranchSnapshot } from "../src/git/graphLocalBranches";
import { GitError, runGit, runGitWithInput } from "../src/git/gitExec";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** @param t fixture 정리 수명 @returns 공통 upstream이 있는 160개 실제 브랜치와 서로 다른 두 커밋 */
async function fixture(t: TestContext) {
  const f = await safetyFixture(t, "graph-tracking-safety"), names = Array.from({ length: 160 }, (_, index) => `branch-${index}`);
  const commits: string[] = [];
  for (let index = 1; index <= 64; index++) {
    const text = `child ${index}\n`;
    commits.push(`commit refs/heads/history\nmark :${index}\ncommitter Tracking <tracking@example.test> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(text)}\n${text}from ${index === 1 ? f.head : `:${index - 1}`}\n\n`);
  }
  await runGitWithInput(["fast-import", "--quiet"], f.root, commits.join("") + "done\n");
  const tip = await git(f.root, "rev-parse", "history");
  await git(f.root, "remote", "add", "origin", "unused-local-origin");
  await runGitWithInput(["update-ref", "--stdin"], f.root,
    `update refs/remotes/origin/main ${f.head}\n${names.map(name => `update refs/heads/${name} ${tip}\n`).join("")}`);
  const file = join(f.root, ".git", "config");
  await writeFile(file, await readFile(file, "utf8") + names.map(name => `[branch "${name}"]\n remote = origin\n merge = refs/heads/main\n`).join(""));
  return { ...f, tip, names };
}

/** @param args Git argv @returns 현재 실행이 이력 일괄 계산 프로세스이면 true */
function isBatch(args: string[]): boolean { return args.some(arg => arg.includes("%(ahead-behind:")); }

test("metadata and upstream-ref reads start together before either independent result is needed", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void, refsStarted = false;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (args.includes("--sort=-committerdate") && !args.some(arg => arg.includes("%(upstream:track)"))) {
      entered(); await paused;
    }
    if (args.includes("--format=%(refname)\x1f%(objectname)")) refsStarted = true;
    return runGit(args, root, options);
  });
  await reader.read();
  const reading = reader.read();
  t.after(async () => { release(); await reading; });
  await reached;
  assert.equal(refsStarted, true, "independent ref discovery waited behind the branch metadata process");
  release();
  assert.deepEqual(await reading, await readGraphLocalBranchSnapshot(f.root));
});

test("up-to-date large branch lists keep one native read instead of adding tracking processes", async t => {
  const f = await fixture(t); await git(f.root, "update-ref", "refs/remotes/origin/main", f.tip);
  const calls: string[][] = [];
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    calls.push(args); return runGit(args, root, options);
  });
  await reader.read(); calls.length = 0;
  const actual = await reader.read();
  assert.equal(calls.length, 1);
  assert.equal(actual.branches.find(branch => branch.name === f.names[0])?.ahead, 0);
  assert.deepEqual(actual, await readGraphLocalBranchSnapshot(f.root));
});

test("an untracked branch with unavailable ancestry does not enter the tracking walk or trigger fallback", async t => {
  const f = await fixture(t), tree = await git(f.root, "rev-parse", `${f.tip}^{tree}`);
  const raw = `tree ${tree}\nparent ${"1".repeat(40)}\nauthor Partial <partial@example.test> 1700001000 +0000\ncommitter Partial <partial@example.test> 1700001000 +0000\n\nUntracked partial history\n`;
  const partial = (await runGitWithInput(["hash-object", "-t", "commit", "-w", "--stdin"], f.root, raw)).trim();
  await git(f.root, "update-ref", "refs/heads/untracked-partial", partial);
  let legacyReads = 0, unrelatedComparisons = 0;
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (args.some(arg => arg.includes("%(upstream:track)"))) legacyReads++;
    const output = await runGit(args, root, options);
    if (isBatch(args)) unrelatedComparisons += output.split("\n").filter(line => line.startsWith("refs/heads/untracked-partial\x1f")).length;
    return output;
  });
  await reader.read(); legacyReads = 0;
  assert.deepEqual(await reader.read(), await readGraphLocalBranchSnapshot(f.root));
  assert.equal(legacyReads, 0, "unrelated history forced the batch tracking read into the slow fallback");
  assert.equal(unrelatedComparisons, 0, "Git calculated ahead/behind for an untracked history");
});

test("long Unicode tracking refs are split into bounded native argument batches", async t => {
  const f = await fixture(t), names = f.names.map((_name, index) => `tracking-${index}-${"한".repeat(60)}`);
  await runGitWithInput(["update-ref", "--stdin"], f.root, names.map((name, index) =>
    `update refs/heads/${name} ${f.tip}\ndelete refs/heads/${f.names[index]}\n`).join(""));
  const config = join(f.root, ".git", "config");
  await writeFile(config, await readFile(config, "utf8") + names.map(name =>
    `[branch "${name}"]\n remote = origin\n merge = refs/heads/main\n`).join(""));
  const batches: string[][] = [];
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (isBatch(args)) batches.push(args);
    return runGit(args, root, options);
  });
  await reader.read();
  assert.deepEqual(await reader.read(), await readGraphLocalBranchSnapshot(f.root));
  assert.ok(batches.length >= 2);
  assert.ok(batches.every(args => Buffer.byteLength(args.join(" ")) < 28 * 1024));
});

for (const diagnostic of ["fatal: unknown field name: ahead-behind:base", "치명적: 알 수 없는 필드 이름: ahead-behind:base", "fatal: nom de champ inconnu : ahead-behind:base"]) {
test(`an older Git without ahead-behind falls back once for ${diagnostic}`, async t => {
  const f = await fixture(t); let attempts = 0;
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (isBatch(args)) { attempts++; throw new GitError("unsupported format", diagnostic); }
    return runGit(args, root, options);
  });
  const expected = await reader.read();
  assert.deepEqual(await reader.read(), expected);
  assert.deepEqual(await reader.read(), expected);
  assert.equal(attempts, 1);
});
}

for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "GIT_READ_STOPPING"]) {
  test(`a ${code} tracking read is not restarted through the fallback`, async t => {
    const f = await fixture(t), failure = Object.assign(new Error(code), { code });
    let legacyReads = 0;
    const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
      if (isBatch(args)) throw failure;
      if (args.some(arg => arg.includes("%(upstream:track)"))) legacyReads++;
      return runGit(args, root, options);
    });
    await reader.read();
    await assert.rejects(reader.read(), error => error === failure);
    assert.equal(legacyReads, 1);
  });
}

test("cancellation during the batch boundary does not launch a legacy re-read", async t => {
  const f = await fixture(t), controller = new AbortController();
  let legacyReads = 0;
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (isBatch(args)) { controller.abort(); options?.signal?.throwIfAborted(); }
    if (args.some(arg => arg.includes("%(upstream:track)"))) legacyReads++;
    return runGit(args, root, options);
  });
  await reader.read();
  await assert.rejects(reader.read(controller.signal), { name: "AbortError" });
  assert.equal(legacyReads, 1);
});

test("a local tip moving between metadata and counts triggers a fresh exact snapshot", async t => {
  const f = await fixture(t); let moved = false, legacyReads = 0;
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (isBatch(args) && !moved) { moved = true; await git(root, "update-ref", `refs/heads/${f.names[0]}`, f.head); }
    if (args.some(arg => arg.includes("%(upstream:track)"))) legacyReads++;
    return runGit(args, root, options);
  });
  await reader.read();
  assert.deepEqual(await reader.read(), await readGraphLocalBranchSnapshot(f.root));
  assert.equal(moved, true); assert.equal(legacyReads, 2);
});

test("batch tracking observes replace refs and shallow boundaries without caching history counts", async t => {
  const f = await fixture(t); let batches = 0;
  const reader = new GraphLocalBranchTrackingReader(f.root, async (args, root, options) => {
    if (isBatch(args)) batches++;
    return runGit(args, root, options);
  });
  await reader.read();
  await writeFile(join(f.root, ".git", "shallow"), `${f.tip}\n`);
  assert.deepEqual(await reader.read(), await readGraphLocalBranchSnapshot(f.root));
  assert.equal(batches, 1);
  await unlink(join(f.root, ".git", "shallow"));
  await reader.read();
  const tree = await git(f.root, "rev-parse", `${f.tip}^{tree}`);
  const orphan = await git(f.root, "commit-tree", tree, "-m", "replacement root");
  await git(f.root, "replace", f.tip, orphan);
  const replaced = await reader.read();
  assert.deepEqual(replaced, await readGraphLocalBranchSnapshot(f.root));
  assert.equal(replaced.branches.find(branch => branch.name === f.names[0])?.behind, 1);
  await git(f.root, "replace", "-d", f.tip);
  const restored = await reader.read();
  assert.deepEqual(restored, await readGraphLocalBranchSnapshot(f.root));
  assert.equal(restored.branches.find(branch => branch.name === f.names[0])?.behind, 0);
});
