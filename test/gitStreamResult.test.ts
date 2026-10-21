import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { runGitStreamResult } from "../src/git/gitExec";

/** 실제 child/stdout/close를 쓰는 작은 테스트 실행기를 만들며 사용자 Git이나 파일은 건드리지 않는다. */
async function executable(t: TestContext, body: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-stream-result-")), file = path.join(directory, "fake-git");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { directory, file };
}

test("streamed results reject write commands before spawning", async () => {
  await assert.rejects(() => runGitStreamResult(["commit", "--allow-empty"], "/unused", () => ({ onData: () => {}, finish: () => "unsafe" })), /read pipeline preparation produced a write command/);
});

test("safe read retries use a fresh reader and discard all partial output", { skip: process.platform === "win32" }, async t => {
  const f = await executable(t, `const fs=require("node:fs"),counter=process.env.GSC_FOLD_COUNTER_FILE;
if(!fs.existsSync(counter)){fs.writeFileSync(counter,"1");process.stdout.write("partial");
process.stderr.write("fatal: Unable to create '/fixture/index.lock': File exists.\\n");process.exitCode=1;}
else{fs.writeFileSync(counter,"2");process.stdout.write("complete");}`);
  let created = 0, finished = 0;
  const value = await runGitStreamResult(["ls-files", "--stage"], f.directory, () => {
    created++; let text = "";
    return { onData: chunk => { text += chunk.toString(); }, finish: () => { finished++; return text; } };
  }, { executable: f.file, env: { GSC_FOLD_COUNTER_FILE: path.join(f.directory, "counter") } });
  assert.equal(created, 2); assert.equal(finished, 1); assert.equal(value, "complete");
  assert.equal(await readFile(path.join(f.directory, "counter"), "utf8"), "2");
});

test("ordinary Native failure never finishes or retries a partially consumed result", { skip: process.platform === "win32" }, async t => {
  const f = await executable(t, `process.stdout.write("partial");process.stderr.write("fatal: unavailable index\\n");process.exitCode=1;`);
  let created = 0;
  await assert.rejects(() => runGitStreamResult(["ls-files"], f.directory, () => {
    created++; return { onData: () => {}, finish: () => assert.fail("Partial output must not be published") };
  }, { executable: f.file }), /unavailable index/);
  assert.equal(created, 1);
});

test("a consumer failure is propagated without retry or completion", { skip: process.platform === "win32" }, async t => {
  const f = await executable(t, `process.stdout.write("data");`), failure = new Error("Invalid stage output");
  let created = 0;
  await assert.rejects(() => runGitStreamResult(["ls-files"], f.directory, () => {
    created++; return { onData: () => { throw failure; }, finish: () => assert.fail("Failed consumer cannot finish") };
  }, { executable: f.file }), error => error === failure);
  assert.equal(created, 1);
});
