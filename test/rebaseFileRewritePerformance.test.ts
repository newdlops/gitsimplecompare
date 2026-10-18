import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { RebaseFileRewritePlanner, type RebaseFileRewriteOps } from "../src/git/rebaseFileRewriteOps";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const editor = resolve("media/rebase/rebaseEditor.js");
const execFile = promisify(childProcess.execFile);

/** helper 내부 Git까지 trace2 start 이벤트로 세어 파일 수에 비례한 프로세스 실행을 검출한다. */
async function runAmend(root: string, file: string, trace: string, helper = editor): Promise<string[][]> {
  await execFile(process.execPath, [helper, "amend", file], {
    cwd: root, env: { ...process.env, GSC_REPO_ROOT: root, GIT_TRACE2_EVENT: trace },
  });
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return events.filter(event => event.event === "start").map(event => event.argv);
}

/** host 쪽 Git은 그대로 실행하면서 planner의 명령 수와 인자를 관찰한다. */
function recordGitCalls(t: TestContext): string[][] {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("amend batches 128 excluded files and preserves binary, rename, delete, symlink and literal paths", async t => {
  const { root, directory } = await safetyFixture(t, "rewrite-batch");
  const names = Array.from({ length: 128 }, (_, index) => [":(glob)*.bin", "line\nbreak.bin", "-dash.bin", "한글\t.bin"][index] || `file-${index}.bin`);
  for (const [index, name] of names.entries()) await writeFile(join(root, name), Buffer.from([0, 255, index]));
  await chmod(join(root, names[4]), 0o755);
  await writeFile(join(root, "old-name.txt"), "rename bytes\n");
  await writeFile(join(root, "deleted.txt"), "restore deleted\n");
  await writeFile(join(root, "keep-unselected.bin"), "before\n");
  await symlink("old-target", join(root, "link"));
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base files");
  for (const name of names) await writeFile(join(root, name), Buffer.from([0, 10, 42]));
  await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
  await unlink(join(root, "deleted.txt"));
  await unlink(join(root, "link"));
  await symlink("new-target", join(root, "link"));
  await writeFile(join(root, "added.txt"), "omit addition\n");
  await writeFile(join(root, "keep-unselected.bin"), "keep new bytes\n");
  await writeFile(join(root, "tracked.txt"), "keep current commit\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "changes");
  await writeFile(join(root, "untracked.txt"), "keep untracked\n");
  const opFile = join(directory, "ops.json"), trace = join(directory, "trace.json");
  await writeFile(opFile, JSON.stringify({ version: 2, patches: [], files: [
    ...names.map(path => ({ path })), { path: "new-name.txt", oldPath: "old-name.txt" },
    { path: "link" }, { path: "deleted.txt" }, { path: "added.txt" }, { path: "never-existed.txt" },
  ] }));
  const started = performance.now();
  const calls = await runAmend(root, opFile, trace);
  t.diagnostic(`128-file exclude: ${calls.length} Git processes, ${Math.round(performance.now() - started)}ms`);
  for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(root, name)), Buffer.from([0, 255, index]));
  assert.ok((await lstat(join(root, names[4]))).mode & 0o111);
  assert.equal(await readFile(join(root, "old-name.txt"), "utf8"), "rename bytes\n");
  await assert.rejects(lstat(join(root, "new-name.txt")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "added.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "deleted.txt"), "utf8"), "restore deleted\n");
  assert.equal(await readlink(join(root, "link")), "old-target");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "keep current commit\n");
  assert.equal(await readFile(join(root, "keep-unselected.bin"), "utf8"), "keep new bytes\n");
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "keep untracked\n");
  assert.ok(calls.length <= 10, `Expected batched restore, got ${calls.length} Git processes`);
});

for (const linked of [false, true]) {
  test(`native rebase moves binary and renamed files through batched exec in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const fixture = await safetyFixture(t, "rewrite-native");
    let root = fixture.root;
    await writeFile(join(root, "old-name.txt"), "rename bytes\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "base files");
    const base = await git(root, "rev-parse", "HEAD");
    const paths = ["binary.bin", "line\nbreak.bin", ":(glob)*.bin"];
    for (const path of paths) await writeFile(join(root, path), Buffer.from([0, 255, 1]));
    await chmod(join(root, paths[0]), 0o755);
    await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
    await writeFile(join(root, "keep.txt"), "keep in source\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "source");
    const source = await git(root, "rev-parse", "HEAD");
    const target = await commitText(root, "target\n", "target");
    if (linked) {
      root = join(fixture.directory, "linked 한글\npath' $literal");
      await git(fixture.root, "worktree", "add", "-qb", "linked", root, target);
    }
    const items: RebaseItem[] = [{ hash: source, action: "pick", fileMoves: [
      ...paths.map(sourcePath => ({ sourceHash: source, sourcePath, targetHash: target })),
      { sourceHash: source, sourcePath: "new-name.txt", sourceOldPath: "old-name.txt", targetHash: target },
    ] }, { hash: target, action: "pick" }];
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, "spawn", (...args: any[]) => {
      const child = (spawn as Function)(...args);
      if (args[0] === "git" && args[1][0] === "rebase") {
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("close", (code: number, signal: string) => {
          if (code) t.diagnostic(`Native rebase exit=${code} signal=${signal}: ${stderr}`);
        });
      }
      return child;
    });
    const result = await new RebaseService(root).start(base, false, items, editor);
    assert.equal(result.status, "completed", JSON.stringify(result));
    const commits = (await git(root, "rev-list", "--reverse", `${base}..HEAD`)).split("\n");
    assert.equal(commits.length, 2);
    assert.equal(await git(root, "show", `${commits[0]}:keep.txt`), "keep in source");
    assert.equal(await git(root, "show", `${commits[0]}:old-name.txt`), "rename bytes");
    await assert.rejects(git(root, "cat-file", "-e", `${commits[0]}:binary.bin`));
    for (const path of paths) assert.deepEqual(await readFile(join(root, path)), Buffer.from([0, 255, 1]));
    assert.ok((await lstat(join(root, paths[0]))).mode & 0o111);
    assert.equal(await readFile(join(root, "new-name.txt"), "utf8"), "rename bytes\n");
    await assert.rejects(lstat(join(root, "old-name.txt")), { code: "ENOENT" });
    assert.equal(await git(root, "status", "--porcelain"), "");
  });
}

test("root SHA-256 rebase moves a file without a hard-coded SHA-1 empty tree", async t => {
  const { directory } = await safetyFixture(t, "rewrite-root-sha256");
  const root = join(directory, "sha256");
  await mkdir(root);
  await git(root, "init", "-q", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(directory, "hooks") })) await git(root, "config", key, value);
  await writeFile(join(root, "moving.bin"), Buffer.from([0, 255, 10]));
  await git(root, "add", "moving.bin");
  const source = await commitText(root, "root\n", "root");
  const target = await commitText(root, "target\n", "target");
  const result = await new RebaseService(root).start("", true, [
    { hash: source, action: "pick", fileMoves: [{ sourceHash: source, sourcePath: "moving.bin", targetHash: target }] },
    { hash: target, action: "pick" },
  ], editor);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(await readFile(join(root, "moving.bin")), Buffer.from([0, 255, 10]));
  const rootCommit = (await git(root, "rev-list", "--max-parents=0", "HEAD")).trim();
  await assert.rejects(git(root, "cat-file", "-e", `${rootCommit}:moving.bin`));
  assert.equal(rootCommit.length, 64);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

for (const legacy of [true, false]) {
  test(`batch restore ${legacy ? "falls back for unsupported Git" : "stops on real restore errors"}`, async t => {
    const { root, directory } = await safetyFixture(t, "rewrite-compat");
    await commitText(root, "current\n", "current");
    const before = await git(root, "rev-parse", "HEAD");
    const ops = join(directory, "ops.json"), helper = join(directory, "helper.cjs");
    await writeFile(ops, JSON.stringify({ excludePaths: ["tracked.txt", "absent.txt"] }));
    await writeFile(helper, `const cp = require("node:child_process");
const run = cp.execFileSync;
cp.execFileSync = function(command, args, options) {
  if (command === "git" && args[0] === "restore") {
    const error = new Error("restore failed");
    error.stderr = Buffer.from(${JSON.stringify(legacy ? "git: 'restore' is not a git command" : "fatal: checkout failed due to an IO error")});
    throw error;
  }
  return run.apply(this, arguments);
};
require(${JSON.stringify(editor)});
`);
    if (legacy) {
      await runAmend(root, ops, join(directory, "trace.json"), helper);
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "base\n");
    } else {
      await assert.rejects(runAmend(root, ops, join(directory, "trace.json"), helper), /rebaseEditor failed/);
      assert.equal(await git(root, "rev-parse", "HEAD"), before);
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "current\n");
    }
  });
}

test("plain 10k-item plans index file moves once and launch no Git processes", async t => {
  let reads = 0;
  const items = Array.from({ length: 10_000 }, (_, index) => ({
    hash: index.toString(16).padStart(40, "0"), action: "pick" as const,
    get fileMoves() { reads++; return []; },
  }));
  const calls = recordGitCalls(t);
  const started = performance.now();
  const planner = new RebaseFileRewritePlanner("/unused", items, [], process.execPath, editor);
  for (const item of items) assert.equal(await planner.execLine(item), undefined);
  t.diagnostic(`10k-item plan: ${Math.round(performance.now() - started)}ms, ${reads} move-list reads`);
  assert.equal(reads, items.length);
  assert.equal(calls.length, 0);
});

test("96 moved files share a binary patch and one worktree metadata lookup", async t => {
  const { root, directory, head: base } = await safetyFixture(t, "rewrite-patch");
  const paths = Array.from({ length: 96 }, (_, index) => `move-${index}.bin`);
  for (const path of paths) await writeFile(join(root, path), Buffer.from([0, 255, 10]));
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "source");
  const source = await git(root, "rev-parse", "HEAD");
  const target = await commitText(root, "target\n", "target");
  const items: RebaseItem[] = [{ hash: source, action: "pick", fileMoves: paths.map(sourcePath => ({ sourceHash: source, sourcePath, targetHash: target })) }, { hash: target, action: "pick" }];
  const calls = recordGitCalls(t);
  const planner = new RebaseFileRewritePlanner(root, items, [], process.execPath, editor);
  const remove = await planner.execLine(items[0]);
  const apply = await planner.execLine(items[1]);
  assert.ok(remove && apply);
  const ops: RebaseFileRewriteOps = JSON.parse(await readFile(apply.opFile, "utf8"));
  assert.equal(ops.patches.length, 1);
  assert.equal(ops.patches[0].paths.length, 96);
  assert.equal(calls.filter(args => args[0] === "rev-parse").length, 1);
  assert.equal(calls.filter(args => args[0] === "diff-tree").length, 1);
  // source가 제거된 트리 위에서 실제 target patch를 적용해 byte와 index 상태까지 확인한다.
  await git(root, "switch", "-qc", "verify-patch", base);
  await runAmend(root, apply.opFile, join(directory, "trace-patch.json"));
  for (const path of paths) assert.deepEqual(await readFile(join(root, path)), Buffer.from([0, 255, 10]));
  assert.equal(await git(root, "status", "--porcelain"), "");
});
