import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { runGit } from "../src/git/gitExec";
import {
  cleanupRebaseMessageQueue, initializeRebaseMessageQueue,
  rebaseContinueEditorEnv, refreshRebaseMessageQueueForContinue,
} from "../src/git/rebaseMessageQueue";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const editor = resolve("media/rebase/rebaseEditor.js");
const execFile = promisify(childProcess.execFile);

interface TraceEvent { event: string; argv?: string[] }

/** Trace2 파일이 없으면 자식 Git을 실행하지 않은 것으로 보고 빈 이벤트를 반환한다. */
async function traceEvents(file: string): Promise<TraceEvent[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

/** 실제 helper 자식 Git까지 포함해 메시지 편집기와 done 경로 조회 수를 집계한다. */
function editorCounts(events: TraceEvent[]) {
  return {
    editors: events.filter(event => event.event === "child_start" && event.argv?.some(arg => arg.includes(editor) && / msg$/.test(arg))).length,
    doneLookups: events.filter(event => event.event === "start" && event.argv?.[1] === "rev-parse"
      && event.argv[2] === "--git-path" && /rebase-(?:merge|apply)\/done$/.test(event.argv[3])).length,
  };
}

/** 한 작업 동안만 Trace2를 상속시켜 서비스 내부 Git과 helper의 자식 프로세스를 함께 기록한다. */
async function traceOperation<T>(file: string, operation: () => Promise<T>) {
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  try {
    const result = await operation();
    const events = await traceEvents(file);
    assert.ok(events.some(event => event.event === "start"), "Trace2 must capture the real host Git process");
    return { result, events };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
}

/** 정상/linked worktree에 독립 파일 내용을 가진 선형 커밋 여섯 개를 만든다. */
async function messageFixture(t: TestContext, label: string, linked = false) {
  const fixture = await safetyFixture(t, label);
  let root = fixture.root;
  if (linked) {
    root = join(fixture.directory, "linked path 한글");
    await git(fixture.root, "worktree", "add", "-qb", "linked", root, fixture.head);
  }
  const hashes: string[] = [];
  for (let index = 0; index < 6; index++) hashes.push(await commitText(root, `content ${index}\n`, `original ${index}`));
  return { ...fixture, root, hashes, tree: await git(root, "rev-parse", "HEAD^{tree}") };
}

/** 커밋 본문 전체를 순서대로 읽어 제목만 맞고 본문이 손실되는 회귀도 검출한다. */
async function messages(root: string, base: string): Promise<string[]> {
  return (await git(root, "log", "--reverse", "--format=%B%x00", `${base}..HEAD`))
    .split("\0").map(message => message.trim()).filter(Boolean);
}

/** 현재 worktree에 해당하는 queue 상태 파일의 실제 절대 경로를 구한다. */
async function statePath(root: string): Promise<string> {
  return resolve(root, await git(root, "rev-parse", "--git-path", "gitsimplecompare/rebase-message-queue-state.json"));
}

for (const linked of [false, true]) {
  for (const mixed of [false, true]) {
    test(`message-free ${mixed ? "reword/squash" : "reword"} uses no message helper in a ${linked ? "linked" : "normal"} worktree`, async t => {
      const fixture = await messageFixture(t, "message-free-editor", linked);
      const items: RebaseItem[] = fixture.hashes.map((hash, index) => ({ hash, action: mixed && index % 2 ? "squash" : "reword" }));
      const { result, events } = await traceOperation(join(fixture.directory, "trace.json"), () =>
        new RebaseService(fixture.root, { nativeEditors: true }).start(fixture.head, false, items, editor));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.deepEqual(await messages(fixture.root, fixture.head), mixed
        ? ["original 0\n\noriginal 1", "original 2\n\noriginal 3", "original 4\n\noriginal 5"]
        : ["original 0", "original 1", "original 2", "original 3", "original 4", "original 5"]);
      assert.equal(await git(fixture.root, "rev-parse", "HEAD^{tree}"), fixture.tree);
      const counts = editorCounts(events);
      t.diagnostic(`message-free ${mixed ? "mixed" : "reword"}: ${JSON.stringify(counts)}`);
      assert.equal(counts.editors, 0, "An all-null queue must not start the message helper");
      assert.equal(counts.doneLookups, 0, "An all-null queue must not resolve done paths per commit");
    });
  }

  test(`custom messages read live done without per-message Git in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const fixture = await messageFixture(t, "message-custom-editor", linked);
    const items: RebaseItem[] = fixture.hashes.map((hash, index) => ({ hash, action: "reword", message: `rewritten ${index}\n\nbody ${index}` }));
    const { result, events } = await traceOperation(join(fixture.directory, "trace.json"), () =>
      new RebaseService(fixture.root, { nativeEditors: true }).start(fixture.head, false, items, editor));
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(await messages(fixture.root, fixture.head), [
      "rewritten 0\n\nbody 0", "rewritten 1\n\nbody 1", "rewritten 2\n\nbody 2",
      "rewritten 3\n\nbody 3", "rewritten 4\n\nbody 4", "rewritten 5\n\nbody 5",
    ]);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD^{tree}"), fixture.tree);
    assert.deepEqual(editorCounts(events), { editors: 6, doneLookups: 0 });
  });
}

test("version 1 sessions select the editor from the current queue and current worktree", async t => {
  const { root, directory, head } = await safetyFixture(t, "message-legacy-state");
  const initial = await initializeRebaseMessageQueue(root, [{ hash: head, action: "reword" }], editor);
  const file = await statePath(root), gitDir = dirname(dirname(file));
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.nativeEditors, undefined, "Existing callers and old v1 sessions retain the Node helper");
  const legacyQueue = join(directory, "older-location", "queue.json");
  await mkdir(dirname(legacyQueue));
  await writeFile(legacyQueue, JSON.stringify(["late custom message"]));
  await writeFile(file, JSON.stringify({ version: 1, queuePath: legacyQueue, editorScript: editor, nodePath: process.execPath }));
  let env = (await rebaseContinueEditorEnv(root))!;
  assert.match(env.GIT_EDITOR, / msg$/);
  assert.equal(typeof env.GSC_REBASE_GIT_DIR, "string", "Continue must provide its current worktree metadata path");
  assert.equal(await realpath(env.GSC_REBASE_GIT_DIR), await realpath(gitDir), "A legacy queue location must not choose the Git directory");
  await writeFile(legacyQueue, JSON.stringify([null, null]));
  env = (await rebaseContinueEditorEnv(root))!;
  assert.equal(env.GIT_EDITOR, "true");
  assert.equal(initial.GIT_EDITOR, "true");
  await writeFile(legacyQueue, JSON.stringify(["latest message"]));
  assert.match((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, / msg$/);
  await cleanupRebaseMessageQueue(root);
});

test("unreadable or malformed message queues retain the existing helper", async t => {
  const { root, head } = await safetyFixture(t, "message-invalid-queue");
  await initializeRebaseMessageQueue(root, [{ hash: head, action: "reword", message: "custom" }], editor);
  const state = JSON.parse(await readFile(await statePath(root), "utf8"));
  for (const raw of ["invalid JSON", "null", "{}", "[null, 1]", "[false]", "[{}]", '[""]']) {
    await writeFile(state.queuePath, raw);
    assert.match((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, / msg$/, raw);
  }
  await rm(state.queuePath);
  assert.match((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, / msg$/);
});

test("an exhausted custom queue selects the native editor without caching the previous choice", async t => {
  const { root, head } = await safetyFixture(t, "message-exhausted-queue");
  const initial = await initializeRebaseMessageQueue(root, [{ hash: head, action: "reword", message: "initial custom" }], editor);
  assert.match(initial.GIT_EDITOR, / msg$/);
  const state = JSON.parse(await readFile(await statePath(root), "utf8"));
  await writeFile(state.queuePath, "[]");
  assert.equal((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, "true");
  await writeFile(state.queuePath, "[null]");
  assert.equal((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, "true");
  await writeFile(state.queuePath, JSON.stringify([null, "later custom"]));
  assert.match((await rebaseContinueEditorEnv(root))!.GIT_EDITOR, / msg$/);
  await cleanupRebaseMessageQueue(root);
});

interface HelperInput { root: string; directory: string; gitDir: string; hint?: string; targetDir?: string; action?: string; backend?: string }

/** 실제 Git metadata의 done과 메시지 파일로 helper를 직접 실행해 hint의 소유 경계를 확인한다. */
async function helperMessage(input: HelperInput, label: string) {
  const doneDir = join(input.gitDir, input.backend || "rebase-merge");
  await mkdir(doneDir, { recursive: true });
  await writeFile(join(doneDir, "done"), `${input.action || "reword"} ${"a".repeat(40)} original\n`);
  const queue = join(input.directory, `${label}.queue.json`), target = join(input.targetDir || input.gitDir, `${label}.message`);
  const message = `${label} custom\n\nbody\n`, trace = join(input.directory, `${label}.trace.json`);
  await writeFile(queue, JSON.stringify([message]));
  await writeFile(target, "native message\n");
  try {
    await execFile(process.execPath, [editor, "msg", target], {
      cwd: input.root, env: { ...process.env, GSC_REPO_ROOT: input.root, GSC_MSG_QUEUE: queue,
        GIT_TRACE2_EVENT: trace, ...(input.hint === undefined ? {} : { GSC_REBASE_GIT_DIR: input.hint }) },
    });
    return { message, target: await readFile(target, "utf8"), queue: JSON.parse(await readFile(queue, "utf8")),
      gitProcesses: (await traceEvents(trace)).filter(event => event.event === "start").length };
  } finally {
    await rm(doneDir, { recursive: true, force: true });
  }
}

test("message helper accepts only an absolute hint owned by the Git message file", async t => {
  const fixture = await safetyFixture(t, "message-hint-fallback");
  const gitDir = resolve(fixture.root, await git(fixture.root, "rev-parse", "--git-dir"));
  const linked = join(fixture.directory, "other worktree");
  await git(fixture.root, "worktree", "add", "-qb", "other", linked, fixture.head);
  const otherGitDir = resolve(linked, await git(linked, "rev-parse", "--git-dir"));
  const alias = join(fixture.directory, "git-alias");
  await symlink(gitDir, alias, "dir");
  const cases = [
    { label: "missing", hint: undefined, want: 1 },
    { label: "stale-worktree", hint: otherGitDir, want: 1 },
    { label: "deleted", hint: join(fixture.directory, "deleted-gitdir"), want: 1 },
    { label: "relative", hint: ".git", want: 1 },
    { label: "wrong-message-parent", hint: gitDir, targetDir: fixture.directory, want: 1 },
    { label: "current", hint: gitDir, want: 0 },
    { label: "canonical-alias", hint: alias, want: 0 },
  ];
  for (const entry of cases) {
    const actual = await helperMessage({ ...fixture, gitDir, ...entry }, entry.label);
    assert.equal(actual.target, actual.message, entry.label);
    assert.deepEqual(actual.queue, [], entry.label);
    assert.equal(actual.gitProcesses, entry.want, entry.label);
  }
  const apply = await helperMessage({ ...fixture, gitDir, hint: gitDir, backend: "rebase-apply" }, "apply-backend");
  assert.equal(apply.target, apply.message);
  assert.equal(apply.gitProcesses, 0);
});

test("message helper rereads live done and never consumes a message for pick or edit", async t => {
  const fixture = await safetyFixture(t, "message-live-done");
  const gitDir = resolve(fixture.root, await git(fixture.root, "rev-parse", "--git-dir"));
  for (const action of ["pick", "edit", "reword", "squash"]) {
    const actual = await helperMessage({ ...fixture, gitDir, hint: gitDir, action }, action);
    const consume = action === "reword" || action === "squash";
    assert.equal(actual.target, consume ? actual.message : "native message\n", action);
    assert.deepEqual(actual.queue, consume ? [] : [actual.message], action);
    assert.equal(actual.gitProcesses, 0, action);
  }
});

for (const linked of [false, true]) {
  for (const native of [false, true]) {
    test(`message-free pause supports ${native ? "native Continue" : "a new custom message"} in a ${linked ? "linked" : "normal"} worktree`, async t => {
      const fixture = await messageFixture(t, "message-pause-resume", linked);
      const base = fixture.hashes[1], hashes = fixture.hashes.slice(2);
      const items: RebaseItem[] = [
        { hash: hashes[0], action: "reword" }, { hash: hashes[1], action: "edit" },
        { hash: hashes[2], action: "squash" }, { hash: hashes[3], action: "reword" },
      ];
      assert.equal((await new RebaseService(fixture.root, { nativeEditors: true }).start(base, false, items, editor)).status, "paused");
      const file = await statePath(fixture.root), state = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(JSON.parse(await readFile(state.queuePath, "utf8")), [null, null, null]);
      if (native) {
        await runGit(["-c", "core.editor=true", "rebase", "--continue"], fixture.root,
          { clearEnv: ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GSC_MSG_QUEUE", "GSC_REBASE_GIT_DIR"] });
      } else {
        items[3].message = "new custom message\n\nnew body";
        const refreshed = (await refreshRebaseMessageQueueForContinue(fixture.root, items))!;
        assert.equal(refreshed.queueLength, 2);
        assert.match(refreshed.env.GIT_EDITOR, / msg$/);
        assert.equal(await realpath(refreshed.env.GSC_REBASE_GIT_DIR), await realpath(dirname(dirname(file))));
        await runGit(["rebase", "--continue"], fixture.root, refreshed.env);
      }
      assert.deepEqual(await messages(fixture.root, base), ["original 2", "original 3\n\noriginal 4", native ? "original 5" : "new custom message\n\nnew body"]);
      assert.equal(await git(fixture.root, "rev-parse", "HEAD^{tree}"), fixture.tree);
      await cleanupRebaseMessageQueue(fixture.root);
    });
  }
}

test("a message-free conflict can add a current custom message before Continue", async t => {
  const fixture = await safetyFixture(t, "message-conflict-continue");
  await git(fixture.root, "switch", "-qc", "onto");
  const onto = await commitText(fixture.root, "onto content\n", "onto");
  await git(fixture.root, "switch", "main");
  const first = await commitText(fixture.root, "first content\n", "original conflict message");
  await writeFile(join(fixture.root, "side.txt"), "second content\n");
  await git(fixture.root, "add", "side.txt");
  await git(fixture.root, "commit", "-qm", "original second message");
  const second = await git(fixture.root, "rev-parse", "HEAD");
  const items: RebaseItem[] = [{ hash: first, action: "reword" }, { hash: second, action: "reword" }];
  assert.equal((await new RebaseService(fixture.root, { nativeEditors: true }).start(fixture.head, false, items, editor, onto)).status, "conflicts");
  items[0].message = "custom after conflict";
  const refreshed = (await refreshRebaseMessageQueueForContinue(fixture.root, items))!;
  assert.equal(refreshed.queueLength, 2);
  await writeFile(join(fixture.root, "tracked.txt"), "resolved conflict\n");
  await git(fixture.root, "add", "tracked.txt");
  const { events } = await traceOperation(join(fixture.directory, "continue.trace.json"), () => runGit(["rebase", "--continue"], fixture.root, refreshed.env));
  assert.deepEqual(await messages(fixture.root, onto), ["custom after conflict", "original second message"]);
  assert.equal(await git(fixture.root, "show", "HEAD:tracked.txt"), "resolved conflict");
  assert.equal(await git(fixture.root, "show", "HEAD:side.txt"), "second content");
  assert.equal(editorCounts(events).doneLookups, 0);
  await cleanupRebaseMessageQueue(fixture.root);
});

test("SHA-256 reword messages survive full done hashes and a refreshed continuation queue", async t => {
  const fixture = await safetyFixture(t, "message-sha256");
  const root = join(fixture.directory, "sha256 path 한글");
  await mkdir(root);
  await git(root, "init", "-qb", "main", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(fixture.directory, "hooks") })) {
    await git(root, "config", key, value);
  }
  const base = await commitText(root, "base\n", "base");
  const first = await commitText(root, "first\n", "original first");
  const second = await commitText(root, "second\n", "original edit");
  const third = await commitText(root, "third\n", "original last");
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  assert.equal(first.length, 64);
  const items: RebaseItem[] = [
    { hash: first, action: "reword", message: "first custom\n\nfirst body" },
    { hash: second, action: "edit" }, { hash: third, action: "reword", message: "outdated last" },
  ];
  assert.equal((await new RebaseService(root, { nativeEditors: true }).start(base, false, items, editor)).status, "paused");
  assert.deepEqual(await messages(root, base), ["first custom\n\nfirst body", "original edit"]);
  items[2].message = "latest custom\n\nlatest body";
  const refreshed = (await refreshRebaseMessageQueueForContinue(root, items))!;
  assert.equal(refreshed.queueLength, 1);
  await runGit(["rebase", "--continue"], root, refreshed.env);
  assert.deepEqual(await messages(root, base), ["first custom\n\nfirst body", "original edit", "latest custom\n\nlatest body"]);
  assert.equal(await git(root, "rev-parse", "HEAD^{tree}"), tree);
  await cleanupRebaseMessageQueue(root);
});
