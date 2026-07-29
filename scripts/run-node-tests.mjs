// Node 기반 순수 테스트를 자동 발견·번들·실행하는 스크립트.
// - package.json에 테스트 파일명을 계속 나열하지 않아 새 서비스 테스트가 누락되는 일을 막는다.
// - 웹뷰/시각/Extension Development Host spec은 별도 runner가 담당하므로 여기서는 *.test.ts만 실행한다.
import { spawn } from "node:child_process";
import { open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const workspaceRoot = process.cwd();
const testDirectory = path.join(workspaceRoot, "test");
const outputDirectory = path.join(workspaceRoot, "out-test");
const lockPath = path.join(workspaceRoot, ".gsc-node-test.lock");
// Git 임시 저장소를 실제로 만드는 통합 단위 테스트가 있어, 정상 단일 실행에는 충분한
// 시간을 주되 이전처럼 수 시간 동안 터미널을 점유하지 않도록 상한을 둔다.
const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TEST_CONCURRENCY = 3;
const MAX_TEST_TIMEOUT_MS = DEFAULT_TEST_TIMEOUT_MS;
const MAX_TEST_CONCURRENCY = DEFAULT_TEST_CONCURRENCY;
const TERMINATION_GRACE_MS = 5 * 1000;
const UI_TEST_DIRECTORIES = new Set(["webview", "a11y", "extension", "visual"]);

/**
 * 환경 변수로 지정한 테스트 전체 제한 시간을 검증한다.
 * 잘못된 값은 조용히 무시하지 않고 명시적으로 실패시켜 CI와 로컬 실행의 동작을 같게 만든다.
 * @returns {number} Node test runner 전체에 적용할 양의 제한 시간(밀리초)
 */
function testTimeoutMs() {
  const configured = process.env.GSC_NODE_TEST_TIMEOUT_MS;
  if (configured == null || configured === "") {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  const timeout = Number(configured);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TEST_TIMEOUT_MS) {
    throw new Error(`GSC_NODE_TEST_TIMEOUT_MS must be a positive number no greater than ${MAX_TEST_TIMEOUT_MS}.`);
  }
  return timeout;
}

/**
 * Node test worker 수를 검증한다.
 * Git 임시 저장소 테스트의 총 실행 시간을 줄이되, 과도한 병렬 실행으로 로컬 자원과
 * 터미널 routing을 압박하지 않도록 기본값을 세 worker로 제한한다.
 * @returns {number} 동시에 실행할 양의 정수 test worker 수
 */
function testConcurrency() {
  const configured = process.env.GSC_NODE_TEST_CONCURRENCY;
  if (configured == null || configured === "") {
    return DEFAULT_TEST_CONCURRENCY;
  }
  const concurrency = Number(configured);
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > MAX_TEST_CONCURRENCY) {
    throw new Error(`GSC_NODE_TEST_CONCURRENCY must be a positive integer no greater than ${MAX_TEST_CONCURRENCY}.`);
  }
  return concurrency;
}

/**
 * 테스트 runner와 그 worker를 같은 종료 범위로 다룬다.
 * POSIX에서는 별도 process group 전체에 신호를 보내고, Windows에서는 Node의 자식
 * 종료 API로 폴백한다. 이미 종료된 프로세스는 정리 과정에서 오류로 취급하지 않는다.
 * @param {import("node:child_process").ChildProcess} child 종료할 Node test runner
 * @param {NodeJS.Signals} signal 보낼 종료 신호
 * @returns {void}
 */
function terminateTestProcess(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && error.code !== "ESRCH") {
        console.error(`Could not signal the Node test process group: ${error.message}`);
      }
    }
  }
  child.kill(signal);
}

/**
 * 디렉터리를 재귀 순회해 Node test runner로 실행할 TypeScript 파일을 안정된 순서로 찾는다.
 * @param {string} directory 탐색할 절대 디렉터리 경로
 * @returns {Promise<string[]>} 절대 경로 기준으로 정렬된 *.test.ts 파일 목록
 */
async function discoverTestFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (relativeDirectory === "" && UI_TEST_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await discoverTestFiles(entryPath, path.join(relativeDirectory, entry.name))));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

/** npm test 뒤에 지정한 대상이 unit test 디렉터리 안의 직접 실행 가능한 테스트인지 확인한다. */
function targetTestFiles(arguments_) {
  if (arguments_.length === 0) return undefined;
  return arguments_.map((argument) => {
    const resolved = path.resolve(workspaceRoot, argument);
    const relative = path.relative(testDirectory, resolved);
    const topLevelDirectory = relative.split(path.sep)[0];
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !resolved.endsWith(".test.ts") ||
      UI_TEST_DIRECTORIES.has(topLevelDirectory)
    ) {
      throw new Error(`Target test must be a unit *.test.ts file under test/: ${argument}`);
    }
    return resolved;
  });
}

/** 살아 있는 process ID인지 확인해 stale lock만 제거하고 다른 실행을 침범하지 않는다. */
function isRunningProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 전체 npm test를 하나만 허용하는 lock을 만들고, 이전 비정상 종료의 stale lock만 정리한다. */
async function acquireSingleFlightLock() {
  const metadata = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(metadata, "utf8");
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readLockMetadata();
    if (isRunningProcess(existing?.pid)) {
      throw new Error(`Another Git Simple Compare node test group is already running (pid ${existing.pid}).`);
    }
    await rm(lockPath, { force: true });
    return acquireSingleFlightLock();
  }
  console.error(`Node test group: pid=${process.pid} concurrency=${testConcurrency()} timeoutMs=${testTimeoutMs()}.`);
}

/** lock JSON이 손상돼도 안전하게 stale로 판단할 수 있도록 최소 PID만 읽는다. */
async function readLockMetadata() {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 현재 runner가 만든 lock만 종료 경로에서 제거한다. */
async function releaseSingleFlightLock() {
  await rm(lockPath, { force: true });
}

/**
 * test/ 아래 TypeScript 경로를 esbuild가 생성할 out-test/ CommonJS 경로로 바꾼다.
 * @param {string[]} sourceFiles 번들 입력 TypeScript 파일 목록
 * @returns {string[]} Node test runner에 전달할 생성 JavaScript 파일 목록
 */
function outputTestFiles(sourceFiles) {
  return sourceFiles.map((sourceFile) => {
    const relativePath = path.relative(testDirectory, sourceFile);
    return path.join(outputDirectory, relativePath.replace(/\.ts$/, ".js"));
  });
}

/**
 * out-test만 지우고 새 테스트 번들을 생성한다.
 * - 삭제 대상은 현재 workspace 직속 out-test로 고정해 다른 사용자 파일을 건드리지 않는다.
 * @param {string[]} sourceFiles esbuild entry point 목록
 * @returns {Promise<void>}
 */
async function bundleTests(sourceFiles) {
  if (path.dirname(outputDirectory) !== workspaceRoot || path.basename(outputDirectory) !== "out-test") {
    throw new Error("Refusing to clear an unexpected test output directory.");
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await build({
    entryPoints: sourceFiles,
    outdir: outputDirectory,
    outbase: testDirectory,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    logLevel: "info",
    alias: { vscode: path.join(workspaceRoot, "test", "helpers", "vscodeMock.ts") },
  });
}

/**
 * Node의 내장 test runner를 상속 stdio로 실행해 기존 TAP 출력과 종료 코드를 보존한다.
 * 전체 실행이 제한 시간을 넘으면 먼저 SIGTERM을 보내고, 유예 시간 안에 끝나지 않으면
 * SIGKILL을 보내 무한 대기로 개발 터미널과 CI worker가 누적되는 일을 막는다.
 * @param {string[]} files 실행할 번들 테스트 파일의 절대 경로 목록
 * @param {number} timeoutMs 전체 실행 제한 시간(밀리초)
 * @param {number} concurrency 동시에 실행할 Node test worker 수
 * @returns {Promise<number>} 자식 프로세스 종료 코드. signal 종료는 실패로 취급한다.
 */
function runNodeTests(files, timeoutMs, concurrency) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files], {
      cwd: workspaceRoot,
      stdio: "inherit",
      // POSIX에서는 timeout 때 worker까지 함께 종료할 별도 process group을 만든다.
      detached: process.platform !== "win32",
    });

    let finished = false;
    let timedOut = false;
    let interrupted = false;
    let forceKillTimer;

    /**
     * 제한 시간 초과나 상위 터미널의 중단 요청을 같은 방식으로 처리한다.
     * 부모 runner만 먼저 종료되면 detached worker가 고아가 될 수 있으므로, 항상
     * worker를 포함한 process group부터 정상 종료시키고 유예 뒤 강제 종료한다.
     * @param {string} reason 종료 사유를 설명할 로그 메시지
     * @returns {void}
     */
    function requestTermination(reason) {
      if (finished || forceKillTimer) return;
      console.error(`${reason}; sending SIGTERM.`);
      terminateTestProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!finished) {
          console.error(`Node tests did not exit within ${TERMINATION_GRACE_MS}ms; sending SIGKILL.`);
          terminateTestProcess(child, "SIGKILL");
        }
      }, TERMINATION_GRACE_MS);
    }

    /**
     * 터미널 종료 신호를 child process group으로 전파한다.
     * @param {NodeJS.Signals} signal 부모 runner가 받은 POSIX 신호
     * @returns {void}
     */
    function handleInterruption(signal) {
      if (finished) return;
      interrupted = true;
      requestTermination(`Node test runner received ${signal}`);
    }

    const signalHandlers = new Map([
      ["SIGINT", () => handleInterruption("SIGINT")],
      ["SIGTERM", () => handleInterruption("SIGTERM")],
      ["SIGHUP", () => handleInterruption("SIGHUP")],
    ]);
    for (const [signal, handler] of signalHandlers) {
      process.once(signal, handler);
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination(`Node tests exceeded ${timeoutMs}ms`);
    }, timeoutMs);

    /**
     * 타이머를 정리하고 Promise를 한 번만 완료한다.
     * @param {() => void} callback 정리 후 resolve 또는 reject를 수행할 함수
     * @returns {void}
     */
    function finish(callback) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      callback();
    }

    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => resolve(timedOut || interrupted || signal ? 1 : (code ?? 1)));
    });
  });
}

/**
 * 자동 발견부터 번들·실행까지의 실패를 npm test 종료 코드로 전달한다.
 * @returns {Promise<void>}
 */
async function main() {
  await acquireSingleFlightLock();
  try {
    const sourceFiles = targetTestFiles(process.argv.slice(2)) ?? await discoverTestFiles(testDirectory);
    if (sourceFiles.length === 0) {
      throw new Error("No unit *.test.ts files were found under test/.");
    }

    await bundleTests(sourceFiles);
    const code = await runNodeTests(
      outputTestFiles(sourceFiles),
      testTimeoutMs(),
      testConcurrency()
    );
    if (code !== 0) {
      process.exitCode = code;
    }
  } finally {
    await releaseSingleFlightLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
