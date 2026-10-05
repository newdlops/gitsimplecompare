import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runGh } from "../src/git/ghCli";

/** shell 초기화 여부를 파일에 기록하는 격리된 실행 파일을 만든다. */
async function executable(file: string, body: string) { await writeFile(file, `#!/bin/sh\n${body}\n`); await chmod(file, 0o755); }

/** PATH·명시 설정·shell 보완이 실제 execFile에 전달되는 경로를 격리한다. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gsc-gh-path-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), marker = join(root, "shell-called"), shell = join(root, "shell"); await mkdir(bin);
  await executable(join(bin, "gh"), 'printf "path-gh"');
  await executable(shell, 'printf "called" > "$GSC_SHELL_MARKER"; printf "%s" "$GSC_SHELL_GH"');
  const env = { ...process.env, GITHUB_CLI_PATH: "", PATH: bin, SHELL: shell, GSC_SHELL_MARKER: marker, GSC_SHELL_GH: join(bin, "gh") };
  return { root, bin, marker, shell, env };
}

test("existing PATH gh avoids login shell initialization and explicit override takes precedence", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t); assert.equal(await runGh(["--version"], f.root, { env: f.env }), "path-gh");
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  const override = join(f.root, "configured"); await executable(override, 'printf "configured-gh"');
  assert.equal(await runGh([], f.root, { env: { ...f.env, GITHUB_CLI_PATH: override } }), "configured-gh");
});

test("relative PATH and empty PATH entries resolve against the requested repository cwd", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), other = join(f.root, "other"); await mkdir(other); await mkdir(join(other, "bin"));
  await executable(join(other, "bin", "gh"), 'printf "other-gh"');
  const env = { ...f.env, PATH: "bin" };
  assert.equal(await runGh([], f.root, { env }), "path-gh"); assert.equal(await runGh([], other, { env }), "other-gh");
  await executable(join(other, "gh"), 'printf "cwd-gh"');
  assert.equal(await runGh([], other, { env: { ...f.env, PATH: `${delimiter}/missing` } }), "cwd-gh");
});

test("directories named gh are skipped and login shell remains a working fallback", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t); const wrong = join(f.root, "directory-bin"); await mkdir(wrong); await mkdir(join(wrong, "gh"));
  assert.equal(await runGh([], f.root, { env: { ...f.env, PATH: `${wrong}${delimiter}${f.bin}` } }), "path-gh");
  assert.equal(await runGh([], f.root, { env: { ...f.env, PATH: "/missing" } }), "path-gh");
  assert.equal(await readFile(f.marker, "utf8"), "called");
});

test("a pre-cancelled request starts neither gh nor a login shell lookup", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(runGh([], f.root, { env: { ...f.env, PATH: "/missing" }, signal: controller.signal }), { code: "ABORTED" });
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});
