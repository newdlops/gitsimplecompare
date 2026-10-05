import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, runGitBuffer, runGitStream, runGitWithInput, type RunGitOptions } from "../src/git/gitExec";
import { registerStatusIndex } from "../src/git/statusIndexOwnership";

/**
 * 캐시된 stat만 달라진 실제 Git 저장소를 만들어 조회의 index 갱신을 검출한다.
 * @param t 생성한 저장소를 검사 종료 뒤 회수할 테스트 컨텍스트
 * @returns 읽기 실행 대상과 조회 직전 실제 index 원본
 */
async function repository(t: TestContext): Promise<{ root: string; original: Buffer; identity: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-read-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["init", "-q"], root);
  await runGit(["config", "user.name", "Fixture"], root);
  await runGit(["config", "user.email", "fixture@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await writeFile(path.join(root, "tracked.txt"), "unchanged\n");
  await runGit(["add", "."], root);
  await runGit(["commit", "-qm", "initial"], root, { env: { HUSKY: "0" } });
  const original = await readFile(path.join(root, ".git/index"));
  const info = await stat(path.join(root, ".git/index"));
  const future = new Date(Date.now() + 10000);
  await utimes(path.join(root, "tracked.txt"), future, future);
  return { root, original, identity: `${info.ino}:${info.mtimeMs}:${info.ctimeMs}` };
}

for (const mode of ["text", "buffer", "stdin", "stream"] as const) {
  test(`${mode} status reads preserve actual index bytes and metadata even when optional locks are enabled by the caller`, async t => {
    const fixture = await repository(t);
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    const options: RunGitOptions = { env: { GIT_OPTIONAL_LOCKS: "1" } };
    let result: string;
    if (mode === "text") result = await runGit(args, fixture.root, options);
    else if (mode === "buffer") result = (await runGitBuffer(args, fixture.root, options)).toString();
    else if (mode === "stdin") result = await runGitWithInput(args, fixture.root, "", options);
    else {
      const chunks: Buffer[] = [];
      await runGitStream(args, fixture.root, chunk => { chunks.push(chunk); }, options);
      result = Buffer.concat(chunks).toString();
    }
    assert.equal(result, "", "touching an unchanged tracked file must remain clean");
    assert.deepEqual(await readFile(path.join(fixture.root, ".git/index")), fixture.original);
    const after = await stat(path.join(fixture.root, ".git/index"));
    assert.equal(`${after.ino}:${after.mtimeMs}:${after.ctimeMs}`, fixture.identity);
  });
}

/**
 * 셸 없이 실행되는 실제 자식으로 optional-lock 환경의 적용 결과를 읽는다.
 * @param t 실행 파일과 전용 디렉터리를 정리할 테스트 컨텍스트
 * @returns 조회·쓰기 분류만 바꿔 동일한 자식 환경을 관찰할 실행 경계
 */
async function environmentProbe(t: TestContext): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-read-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "git-probe");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(process.env.GIT_OPTIONAL_LOCKS ?? 'unset');\n`);
  await chmod(executable, 0o755);
  return { root, executable };
}

test("ordinary reads supply optional-lock protection even without explicit environment options", { skip: process.platform === "win32" }, async t => {
  const probe = await environmentProbe(t);
  assert.equal(await runGit(["diff"], probe.root, { executable: probe.executable }), "0");
});

test("clearEnv cannot accidentally remove the read-only index protection", { skip: process.platform === "win32" }, async t => {
  const probe = await environmentProbe(t);
  assert.equal(await runGit(["status"], probe.root, { executable: probe.executable, env: { GIT_OPTIONAL_LOCKS: "1" }, clearEnv: ["GIT_OPTIONAL_LOCKS"] }), "0");
});

test("only a registered private index may receive optional index writes", { skip: process.platform === "win32" }, async t => {
  const probe = await environmentProbe(t), index = path.join(probe.root, "private-index");
  const options = { executable: probe.executable, env: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "1" }, allowPrivateIndexWrites: true };
  assert.equal(await runGit(["status"], probe.root, options), "0");
  const unregister = registerStatusIndex(index); t.after(unregister);
  assert.equal(await runGit(["status"], probe.root, options), "1");
  assert.equal(await runGit(["status"], probe.root, { ...options, clearEnv: ["GIT_INDEX_FILE"] }), "0");
});

test("writes and unknown hook-capable commands retain the caller's environment", { skip: process.platform === "win32" }, async t => {
  const probe = await environmentProbe(t);
  for (const command of ["commit", "update-index", "custom-alias"]) {
    assert.equal(await runGit([command], probe.root, { executable: probe.executable, env: { GIT_OPTIONAL_LOCKS: "1" } }), "1");
  }
});
