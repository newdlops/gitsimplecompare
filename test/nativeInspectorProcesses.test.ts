import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import childProcess = require("node:child_process");
import { findCurrentVSCodeMainPid } from "../src/providers/nativeDiffOverlayInspector";

const executable = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const profile = "/private/tmp/isolated code profile";
const storage = profile + "/User/globalStorage/newdlops.gitsimplecompare";

/** 프로세스 표 경계만 대체하고 실제 PID 선택 함수와 명령 인자를 검증한다. */
function rows(t: TestContext, environmentPid: string, narrow: string, all: string) {
  const previous = process.env.VSCODE_PID;
  process.env.VSCODE_PID = environmentPid;
  t.after(() => { if (previous === undefined) delete process.env.VSCODE_PID; else process.env.VSCODE_PID = previous; });
  const calls: string[][] = [];
  t.mock.method(childProcess, "execFile", ((file: string, args: string[], _options: unknown, done: Function) => {
    assert.equal(file, "ps"); calls.push(args); done(null, args.includes("-p") ? narrow : all, "");
  }) as any);
  return calls;
}

test("a validated host main PID avoids the full process table and preserves long profile arguments", async t => {
  const calls = rows(t, "9876", `9876 1 ${executable} /private/tmp/workspace --user-data-dir=${profile} --new-window`, "");
  assert.equal(await findCurrentVSCodeMainPid(storage), 9876);
  assert.deepEqual(calls, [["-ww", "-p", "9876", "-o", "pid=,ppid=,command="]]);
});

test("a Code Helper process must not be treated as a main executable", async t => {
  rows(t, "55", `55 1 ${executable} Helper (Plugin) --type=utility`, `55 1 ${executable} Helper (Plugin) --type=utility`);
  assert.equal(await findCurrentVSCodeMainPid(storage), undefined);
});

test("a stale environment PID falls back to the matching profile instead of a similarly prefixed profile", async t => {
  const calls = rows(t, "55", "55 1 /bin/zsh", [
    `22 1 ${executable} --user-data-dir=${profile}-other --new-window`,
    `9876 1 ${executable} --user-data-dir="${profile}" --new-window`,
  ].join("\n"));
  assert.equal(await findCurrentVSCodeMainPid(storage), 9876);
  assert.equal(calls.length, 2); assert.ok(calls[1].includes("-Aww"));
});

test("an environment main belonging to another explicit profile is rejected", async t => {
  rows(t, "22", `22 1 ${executable} --user-data-dir=/other/profile`, [
    `22 1 ${executable} --user-data-dir=/other/profile`,
    `9876 1 ${executable} --user-data-dir='${profile}' --new-window`,
  ].join("\n"));
  assert.equal(await findCurrentVSCodeMainPid(storage), 9876);
});

test("a single unrelated default main is not enough evidence to connect to a custom profile", async t => {
  rows(t, "0", "", `22 1 ${executable}`);
  assert.equal(await findCurrentVSCodeMainPid(storage), undefined);
});
