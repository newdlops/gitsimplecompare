// Extension Host smoke를 bundle하고 15분 상한의 별도 process group에서 실행한다.
// - UI/host test가 node unit runner와 섞이지 않게 하고 timeout/interrupt 뒤 고아 VS Code를 남기지 않는다.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const workspaceRoot = process.cwd();
const outputDirectory = path.join(workspaceRoot, "out-test-extension");
const TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5 * 1000;

/** Extension Host가 require할 test module만 vscode external로 bundle한다. */
async function bundleExtensionSmoke() {
  if (path.dirname(outputDirectory) !== workspaceRoot || path.basename(outputDirectory) !== "out-test-extension") {
    throw new Error("Refusing to clear an unexpected Extension test output directory.");
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(workspaceRoot, "test", "extension", "extensionSmoke.ts")],
    outfile: path.join(outputDirectory, "extensionSmoke.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    logLevel: "info",
  });
}

/** detached child의 전체 process group에 종료 신호를 보내고 이미 끝난 경우는 무시한다. */
function terminateProcessGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && error.code !== "ESRCH") console.error(`Could not signal Extension test group: ${error.message}`);
    }
  }
  child.kill(signal);
}

/** bounded detached child로 Development Host를 실행하고 signal/timeout 결과를 npm exit code로 보존한다. */
function runExtensionHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(workspaceRoot, "scripts", "run-extension-test-host.mjs")], {
      cwd: workspaceRoot,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let finished = false;
    let interrupted = false;
    let timedOut = false;
    let forceKillTimer;

    /** timeout 또는 상위 중단 신호를 같은 process-group cleanup으로 처리한다. */
    function requestTermination(reason) {
      if (finished || forceKillTimer) return;
      console.error(`${reason}; sending SIGTERM.`);
      terminateProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!finished) {
          console.error(`Extension tests did not exit within ${TERMINATION_GRACE_MS}ms; sending SIGKILL.`);
          terminateProcessGroup(child, "SIGKILL");
        }
      }, TERMINATION_GRACE_MS);
    }

    /** 상위 터미널 신호를 host와 VS Code child 전체로 전파한다. */
    function handleSignal(signal) {
      if (finished) return;
      interrupted = true;
      requestTermination(`Extension test runner received ${signal}`);
    }

    const handlers = new Map([["SIGINT", () => handleSignal("SIGINT")], ["SIGTERM", () => handleSignal("SIGTERM")], ["SIGHUP", () => handleSignal("SIGHUP")]]);
    for (const [signal, handler] of handlers) process.once(signal, handler);
    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination(`Extension tests exceeded ${TIMEOUT_MS}ms`);
    }, TIMEOUT_MS);

    /** cleanup을 한 번만 수행하고 child 결과를 안정된 exit code로 반환한다. */
    function finish(callback) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      callback();
    }

    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => resolve(timedOut || interrupted || signal ? 1 : (code ?? 1))));
  });
}

/** bundle 이후 한 개의 Extension Host test group만 실행한다. */
async function main() {
  await bundleExtensionSmoke();
  const code = await runExtensionHost();
  if (code !== 0) process.exitCode = code;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
