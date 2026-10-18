import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { captureGitOperation } from "../src/git/operationControl";
import { RebaseService } from "../src/git/rebaseService";
import { GitLogService } from "../src/git/gitLogService";
import { readRebaseTodoProgress } from "../src/git/rebaseTodoProgress";
import { continueGraphRebase } from "../src/webview/graphRebaseActions";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { Uri } from "./helpers/vscodeMock";

/** 실제 edit rebase에서 로그용 진행률 반복 조회의 프로세스 수와 native Continue의 최신성을 측정한다. */
test("repeated progress reads reuse only the Git directory and observe each native stop freshly", { timeout: 45_000 }, async t => {
  const { root, head } = await safetyFixture(t, "rebase-progress-processes");
  const first = await commitText(root, "first\n", "first");
  const second = await commitText(root, "second\n", "second");
  assert.equal((await new RebaseService(root).start(head, false, [
    { hash: first, action: "edit" }, { hash: second, action: "edit" },
  ], resolve("media/rebase/rebaseEditor.js"))).status, "paused");
  const { gitDir } = await captureGitOperation(root);
  const spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  for (let index = 0; index < 5; index++) {
    const progress = await readRebaseTodoProgress(root, gitDir);
    assert.equal(progress?.currentHash, first);
    assert.equal(progress?.remaining, 1);
  }
  t.diagnostic(`Five progress reads: ${calls} Git processes`);
  assert.equal(calls, 0);
  await git(root, "-c", "core.editor=true", "rebase", "--continue");
  calls = 0;
  const advanced = await readRebaseTodoProgress(root, gitDir);
  assert.equal(advanced?.currentHash, second);
  assert.equal(advanced?.remaining, 0);
  assert.equal(calls, 0);
  await git(root, "rebase", "--abort");
  calls = 0;
  assert.equal(await readRebaseTodoProgress(root, gitDir), undefined);
  assert.equal(calls, 0);
});

/** 실제 저장소의 detached HEAD와 수동 표시용 todo 파일을 준비해 ref 해석 경계를 분리한다. */
async function storedProgressFixture(t: TestContext, separate = false) {
  const fixture = await safetyFixture(t, "rebase-progress-refs");
  const { root, directory, head } = fixture;
  const alternate = await commitText(root, "alternate content\n", "alternate ref target");
  const separatePath = join(directory, "metadata\n ");
  if (separate) await git(root, "init", "-q", "--separate-git-dir", separatePath);
  await git(root, "switch", "-q", "--detach", head);
  const gitDir = separate ? await realpath(separatePath) : await realpath(join(root, ".git"));
  await mkdir(join(gitDir, "rebase-merge"));
  await writeFile(join(gitDir, "rebase-merge", "done"), `edit ${head} original subject\n`);
  await writeFile(join(gitDir, "rebase-merge", "git-rebase-todo"), "");
  await writeFile(join(gitDir, "REBASE_HEAD"), head + "\n");
  return { ...fixture, gitDir, alternate };
}

test("noncanonical and symbolic REBASE_HEAD values retain Git resolution and done fallback", { timeout: 45_000 }, async t => {
  const { root, gitDir, head, alternate } = await storedProgressFixture(t);
  const ref = join(gitDir, "REBASE_HEAD");
  const spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  for (const [label, raw] of [
    ["canonical", head + "\n"], ["CRLF", head + "\r\n"], ["no newline", head],
    ["symbolic", "ref: refs/heads/main\n"], ["uppercase", head.toUpperCase() + "\n"],
    ["wrong object width", "b".repeat(64) + "\n"], ["oversized", "x".repeat(1024)], ["malformed", "not an oid\n"],
  ]) {
    await writeFile(ref, raw);
    const expected = await git(root, "rev-parse", "--verify", "REBASE_HEAD").catch(() => undefined);
    calls = 0;
    const progress = await readRebaseTodoProgress(root, gitDir);
    assert.equal(progress?.currentHash, expected || head, label);
    assert.equal(calls, ["canonical", "CRLF", "no newline"].includes(label) ? 0 : 1, label);
  }
  await rm(ref);
  await git(root, "-c", "tag.gpgsign=false", "tag", "REBASE_HEAD", alternate);
  calls = 0;
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, alternate);
  assert.equal(calls, 1, "Missing loose pseudorefs retain Git's alternate ref resolution");
  await git(root, "tag", "-d", "REBASE_HEAD"); calls = 0;
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, head);
  assert.equal(calls, 1, "Missing loose refs still use the repository's ref backend");
});

test("a symlink pseudoref is delegated to Git while later canonical replacement stays fresh", {
  skip: process.platform === "win32",
}, async t => {
  const { root, directory, gitDir, head } = await storedProgressFixture(t);
  const ref = join(gitDir, "REBASE_HEAD"), target = join(directory, "ref-target");
  await writeFile(target, head + "\n"); await rm(ref); await symlink(target, ref);
  const spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, head);
  assert.equal(calls, 1);
  await rm(ref); await writeFile(ref, head + "\n"); calls = 0;
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, head);
  assert.equal(calls, 0);
});

test("directory resolution preserves a separate Git directory ending in newline and whitespace", {
  skip: process.platform === "win32",
}, async t => {
  const { root, gitDir, head } = await storedProgressFixture(t, true);
  const spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  assert.equal((await readRebaseTodoProgress(root))?.currentHash, head);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, head);
  assert.equal(calls, 0);
});

/** 같은 실제 edit rebase를 Git ref 해석 방식과 loose 파일 방식으로 각각 실행해 준비 비용을 직접 비교한다. */
test("Start and Continue save ref lookup processes while producing the same final commit", { timeout: 60_000 }, async t => {
  const spawn = childProcess.spawn, open = fs.promises.open;
  let recording = false, calls = 0;
  let blocked = new Set<string>();
  const measured: Array<{ mode: string; start: number; continue: number }> = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (recording && args[0] === "git") calls++;
    return (spawn as Function)(...args);
  });
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    if (blocked.has(String(args[0]))) throw Object.assign(new Error("Use Git ref interpretation for the comparison"), { code: "ENOTSUP" });
    return open(...args);
  });
  t.mock.method(Uri, "joinPath", (uri, ...parts) => Uri.file(join(uri.fsPath, ...parts)));
  for (const mode of ["Git ref", "loose ref"]) {
    const { root, head } = await safetyFixture(t, "rebase-progress-compare");
    const hash = await commitText(root, "edit content\n", "edit");
    const gitDir = await realpath(join(root, ".git"));
    // macOS의 /var와 /private/var 별칭 양쪽을 막아 모든 loose 조회가 실제 Git 대조군으로 간다.
    blocked = mode === "Git ref" ? new Set(["HEAD", "REBASE_HEAD"].flatMap(name => [
      join(gitDir, name), join(root, ".git", name),
    ])) : new Set();
    calls = 0; recording = true;
    const started = await new RebaseService(root).start(head, false, [{ hash, action: "edit" }], resolve("media/rebase/rebaseEditor.js"));
    const start = calls;
    assert.equal(started.status, "paused");
    calls = 0;
    const continued = await continueGraphRebase({ logService: new GitLogService(root),
      extensionUri: Uri.file(resolve(".")) as any, refreshGraph: async () => {} });
    recording = false;
    measured.push({ mode, start, continue: calls });
    assert.equal(continued.status, "completed");
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "edit content");
    assert.equal(await git(root, "rev-list", "--count", `${head}..HEAD`), "1");
  }
  t.diagnostic(JSON.stringify(measured));
  assert.deepEqual(measured, [{ mode: "Git ref", start: 15, continue: 38 }, { mode: "loose ref", start: 14, continue: 32 }]);
});
