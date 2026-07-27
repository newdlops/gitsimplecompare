// 별도 process group 안에서 VS Code Extension Development Host smoke를 실행하는 내부 진입점.
// - 상위 runner가 timeout/interrupt 때 이 process group 전체를 종료하므로 여기서는 test-electron 결과만 전달한다.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { runTests } from "@vscode/test-electron";

const workspaceRoot = process.cwd();
const extensionTestsPath = path.join(workspaceRoot, "out-test-extension", "extensionSmoke.js");

/** 현재 platform에 이미 설치된 VS Code executable을 우선 찾아 불필요한 download를 막는다. */
function installedVscodeExecutable() {
  const configured = process.env.GSC_VSCODE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"]
    : process.platform === "win32"
      ? ["C:\\Program Files\\Microsoft VS Code\\Code.exe"]
      : ["/usr/share/code/code", "/usr/bin/code"];
  return candidates.find((candidate) => existsSync(candidate));
}

/** bundled host smoke와 local/downloaded VS Code를 연결하고 실패 exit code를 전달한다. */
async function main() {
  if (!existsSync(extensionTestsPath)) {
    throw new Error("Extension test bundle is missing. Run scripts/run-extension-tests.mjs instead.");
  }
  const vscodeExecutablePath = installedVscodeExecutable();
  const code = await runTests({
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath,
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: "1.85.0" }),
    launchArgs: ["--disable-extensions", "--skip-welcome", "--disable-workspace-trust"],
  });
  if (code !== 0) process.exitCode = code;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
