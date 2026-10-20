import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { rebaseSequenceEditor } from "../src/git/rebaseNativeEditors";

const execFile = promisify(childProcess.execFile);
const editor = resolve("media/rebase/rebaseEditor.js");
const options = { skip: process.platform !== "darwin" && process.platform !== "linux" };

/** 테스트용 shell도 경로 한 개를 리터럴로 전달해 따옴표·개행·확장 문자를 실행하지 않는다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** 소유 임시 파일과 Node fallback 확인용 proxy를 만든다. 실제 저장소와 사용자 파일은 쓰지 않는다. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gsc-native-sequence-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo '한글\npath"), todo = join(directory, "todo ' $file\n");
  await mkdir(root);
  const target = join(root, "git-rebase-todo"), marker = join(directory, "fallback marker");
  const nodePath = join(directory, "node 'proxy");
  await writeFile(nodePath, `#!/bin/sh\nprintf x >> ${quote(marker)}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  await writeFile(todo, "reword aaaa 한글\npick bbbb second\n");
  await writeFile(target, "old todo");
  const env = { ...process.env, GSC_TODO: todo, ELECTRON_RUN_AS_NODE: "1" };
  return { directory, root, todo, target, marker, nodePath, env };
}

/** 실제 Git처럼 editor command 뒤에 target을 별도 argv로 추가한다. */
async function execute(f: Awaited<ReturnType<typeof fixture>>, command: string, target = f.target) {
  return execFile("/bin/sh", ["-c", command + ' "$@"', "gsc-editor-test", target], { cwd: f.root, env: f.env });
}

test("native sequence copy preserves todo bytes and quoted paths without starting Node", options, async t => {
  const f = await fixture(t), sentinel = join(f.root, "must-not-exist");
  const todo = join(f.directory, "todo $(touch must-not-exist) ' `literal`\n");
  await writeFile(todo, await readFile(f.todo));
  const selected = await rebaseSequenceEditor(todo, editor, f.nodePath, true);
  assert.equal(selected.kind, "copy");
  await execute(f, selected.command);
  assert.deepEqual(await readFile(f.target), await readFile(todo));
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("arbitrary and missing scripts retain their own behavior even when native mode is requested", options, async t => {
  const f = await fixture(t), custom = join(f.directory, "custom 'editor.js");
  await writeFile(custom, 'process.stderr.write("custom failure\\n"); process.exit(19);\n');
  for (const script of [custom, join(f.directory, "missing-editor.js")]) {
    assert.equal((await rebaseSequenceEditor(f.todo, script, process.execPath, true)).kind, "node");
  }
  const selected = await rebaseSequenceEditor(f.todo, custom, process.execPath, true);
  await assert.rejects(execute(f, selected.command), (error: any) => error.code === 19 && /custom failure/.test(error.stderr));
  assert.equal(await readFile(f.target, "utf8"), "old todo");
  assert.equal((await rebaseSequenceEditor(f.todo, editor, process.execPath)).kind, "node", "Native mode is opt-in");
});

test("native sequence copy delegates a directory target to the original helper", options, async t => {
  const f = await fixture(t), selected = await rebaseSequenceEditor(f.todo, editor, f.nodePath, true);
  assert.equal(selected.kind, "copy");
  await assert.rejects(execute(f, selected.command, f.root), /rebaseEditor failed/);
  assert.equal(await readFile(f.marker, "utf8"), "x");
  await assert.rejects(readFile(join(f.root, f.todo.split("/").at(-1)!)), { code: "ENOENT" });
});

test("native sequence copy failure preserves the original helper error and target bytes", options, async t => {
  const f = await fixture(t);
  await rm(f.todo);
  const selected = await rebaseSequenceEditor(f.todo, editor, f.nodePath, true);
  await assert.rejects(execute(f, selected.command), /rebaseEditor failed/);
  assert.equal(await readFile(f.marker, "utf8"), "x");
  assert.equal(await readFile(f.target, "utf8"), "old todo");
});
