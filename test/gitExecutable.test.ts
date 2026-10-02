import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  GitError, resolveGitExecutable, runGit, runGitBuffer, runGitDetailed,
  runGitStream, runGitWithInput, setGitExecutableResolver,
} from "../src/git/gitExec";
import { findGitExecutables, probeGitExecutable } from "../src/git/gitExecutableService";
import { GitExecutionTiming, setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";

/** 테스트용 실행 파일을 실제 사용자 저장소와 분리하고 종료 때 임시 파일을 정리한다. */
async function executableFixture(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-git-executable-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 모든 실행 방식이 같은 resolver를 거치며 환경·stdin·바이너리 출력이 보존되는지 확인한다. */
test("configured executable applies to text, detailed, stdin, binary and stream calls", async (context) => {
  const timings: GitExecutionTiming[] = [];
  context.after(setGitExecutionObserver(timing => timings.push(timing)));
  context.after(setGitExecutableResolver(() => process.execPath));
  const cwd = process.cwd();
  assert.equal(await runGit(["-e", "process.stdout.write(process.env.GSC_EXECUTABLE_TEST)"], cwd,
    { GSC_EXECUTABLE_TEST: "environment shortcut" }), "environment shortcut");
  assert.deepEqual(await runGitDetailed(["-e", "process.stdout.write('out');process.stderr.write('err')"], cwd),
    { stdout: "out", stderr: "err" });
  const input = Buffer.from([0, 255, 65, 10]);
  const echo = ["-e", "process.stdin.on('data',chunk=>process.stdout.write(chunk.toString('hex')))"];
  assert.equal(await runGitWithInput(echo, cwd, input), input.toString("hex"));
  const emit = ["-e", "process.stdout.write(Buffer.from([0,255,65,10]))"];
  assert.deepEqual(await runGitBuffer(emit, cwd), input);
  const chunks: Buffer[] = [];
  await runGitStream(emit, cwd, chunk => chunks.push(Buffer.from(chunk)));
  assert.deepEqual(Buffer.concat(chunks), input);
  assert.equal(timings.length, 5, "모든 실제 실행 경로가 공통 계측 경계에 연결돼 있다");
  assert.ok(timings.every(timing => timing.outcome === "success" && timing.executable === process.execPath));
  assert.equal(JSON.stringify(timings).includes("process.stdout"), false, "실행 인자와 본문은 계측 로그에 포함하지 않는다");
});

/** 잘못된 설정과 무관하게 호출자가 지정한 후보만 진단할 수 있는지 검증한다. */
test("explicit executable overrides a broken configured path in every execution mode", async (context) => {
  context.after(setGitExecutableResolver(() => "/nonexistent/gsc-configured-git"));
  const cwd = process.cwd(), options = { executable: process.execPath };
  const emit = ["-e", "process.stdout.write('selected')"];
  assert.equal(await runGit(emit, cwd, options), "selected");
  assert.equal((await runGitDetailed(emit, cwd, options)).stdout, "selected");
  assert.equal(await runGitWithInput(emit, cwd, "input", options), "selected");
  assert.equal((await runGitBuffer(emit, cwd, options)).toString(), "selected");
  const chunks: Buffer[] = [];
  await runGitStream(emit, cwd, chunk => chunks.push(Buffer.from(chunk)), options);
  assert.equal(Buffer.concat(chunks).toString(), "selected");
});

/** 설정 변경과 해제가 다음 호출에 적용되며 오래된 등록 해제가 새 resolver를 지우지 않는지 확인한다. */
test("resolver observes live repository choices and resets safely", () => {
  let selected = "/first/git";
  const releaseFirst = setGitExecutableResolver(cwd => cwd === "/repo-a" ? selected : "");
  assert.equal(resolveGitExecutable("/repo-a"), "/first/git");
  selected = "/second/git";
  assert.equal(resolveGitExecutable("/repo-a"), "/second/git");
  assert.equal(resolveGitExecutable("/repo-b"), "git");
  const releaseSecond = setGitExecutableResolver(() => "/new/git");
  releaseFirst();
  assert.equal(resolveGitExecutable("/repo-a"), "/new/git");
  releaseSecond();
  assert.equal(resolveGitExecutable("/repo-a"), "git");
});

/** 공백·셸 문자가 들어간 경로도 셸 해석 없이 하나의 실행 파일로 전달되는지 검증한다. */
test("executable paths with spaces and shell characters remain literal", { skip: process.platform === "win32" }, async (context) => {
  const cwd = await executableFixture(context);
  const executable = path.join(cwd, "git tool $(literal)");
  await symlink(process.execPath, executable);
  assert.equal(await runGit(["-e", "process.stdout.write('literal path')"], cwd, { executable }), "literal path");
});

/** 잘못 저장된 경로에서 다른 Git으로 조용히 변경되지 않고 원래 실행 오류를 반환하는지 확인한다. */
test("missing configured Git fails without silently falling back", async (context) => {
  const cwd = await executableFixture(context);
  const timings: GitExecutionTiming[] = [];
  context.after(setGitExecutionObserver(timing => timings.push(timing)));
  context.after(setGitExecutableResolver(() => path.join(cwd, "missing-git")));
  const expectMissing = (error: unknown) => error instanceof GitError && error.code === "ENOENT";
  await assert.rejects(runGit(["--version"], cwd), expectMissing);
  await assert.rejects(runGitWithInput(["--version"], cwd, "input"), expectMissing);
  await assert.rejects(runGitBuffer(["--version"], cwd), expectMissing);
  await assert.rejects(runGitStream(["--version"], cwd, () => undefined), expectMissing);
  assert.equal(timings.length, 4);
  assert.ok(timings.every(timing => timing.outcome === "error" && timing.code === "ENOENT"));
});

/** 실제 Git 진단이 세 샘플의 정확한 중앙값을 계산하는지 확인한다. */
test("Git startup diagnosis validates Git and reports the sample median", async () => {
  const result = await probeGitExecutable("git", process.cwd());
  assert.equal(result.error, undefined);
  assert.match(result.version!, /^git version /);
  assert.equal(result.samplesMs.length, 3);
  assert.equal(result.medianMs, [...result.samplesMs].sort((a, b) => a - b)[1]);
});

/** 버전 출력이 Git 형식이 아니거나 실행 자체가 실패한 후보를 저장 가능한 결과로 만들지 않는다. */
test("diagnosis rejects non-Git and missing executables", async (context) => {
  const cwd = await executableFixture(context);
  const other = await probeGitExecutable(process.execPath, cwd);
  assert.match(other.error!, /did not report a Git version/);
  assert.equal(other.medianMs, undefined);
  const missing = await probeGitExecutable(path.join(cwd, "missing"), cwd);
  assert.ok(missing.error);
  assert.equal(missing.medianMs, undefined);
});

/** 느린 후보의 제한 시간과 사용자 취소가 자식 프로세스를 끝내고 설정 저장 단계로 넘어가지 않는지 확인한다. */
test("startup probes terminate timed out and cancelled processes", { skip: process.platform === "win32" }, async (context) => {
  const cwd = await executableFixture(context);
  const executable = path.join(cwd, "slow-git");
  await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => console.log('git version fixture'), 30000);\n`, { mode: 0o755 });
  const timeout = await probeGitExecutable(executable, cwd, undefined, 3, 100);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.medianMs, undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(probeGitExecutable(executable, cwd, controller.signal), { name: "AbortError" }); }
  finally { clearTimeout(timer); }
});

/** 탐색은 현재 경로와 PATH를 유지하면서 동일 경로를 한 번만 진단하게 한다. */
test("discovery keeps configured and PATH candidates without duplicates", async () => {
  const candidates = await findGitExecutables("/missing/configured-git", ["git", "/missing/configured-git"]);
  assert.equal(candidates[0], "/missing/configured-git");
  assert.equal(candidates.filter(candidate => candidate === "git").length, 1);
  assert.equal(new Set(candidates).size, candidates.length);
});
