// 별도 process group 안에서 VS Code Extension Development Host smoke를 실행하는 내부 진입점.
// - 상위 runner가 timeout/interrupt 때 이 process group 전체를 종료하므로 여기서는 test-electron 결과만 전달한다.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
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

/**
 * 사용자 저장소·설정 대신 임시 Git 저장소와 전용 VS Code profile을 만들어 command smoke를 격리한다.
 * @returns 정리 대상 디렉터리와 tracked 변경 파일을 가진 workspace 경로
 */
async function createWorkspaceFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-extension-smoke-"));
  const repoRoot = path.join(directory, "workspace");
  await mkdir(repoRoot);
  await mkdir(path.join(repoRoot, ".vscode"));
  await writeFile(path.join(repoRoot, ".vscode", "settings.json"), '{"git.enabled":false}\n');
  await mkdir(path.join(directory, "hooks"));
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
  git(["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  git(["config", "user.name", "Extension Smoke"]);
  git(["config", "user.email", "extension-smoke@example.invalid"]);
  git(["config", "core.hooksPath", path.join(directory, "hooks")]);
  git(["config", "commit.gpgSign", "false"]);
  await writeFile(path.join(repoRoot, "sample.txt"), "base\n");
  git(["add", "sample.txt"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  await writeFile(path.join(repoRoot, "sample.txt"), "base\nchanged\n");
  return { directory, repoRoot };
}

/** bundled host smoke와 local/downloaded VS Code를 연결하고 실패 exit code를 전달한다. */
async function main() {
  if (!existsSync(extensionTestsPath)) {
    throw new Error("Extension test bundle is missing. Run scripts/run-extension-tests.mjs instead.");
  }
  const vscodeExecutablePath = installedVscodeExecutable();
  const fixture = await createWorkspaceFixture();
  let passed = false;
  try {
    const code = await runTests({
      extensionDevelopmentPath: workspaceRoot,
      extensionTestsPath,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: "1.85.0" }),
      extensionTestsEnv: { GSC_EXTENSION_TEST_FIXTURE: fixture.repoRoot },
      launchArgs: [
        fixture.repoRoot, "--disable-extensions", "--skip-welcome", "--disable-workspace-trust",
        `--user-data-dir=${path.join(fixture.directory, "profile")}`,
        `--extensions-dir=${path.join(fixture.directory, "extensions")}`,
      ],
    });
    passed = code === 0;
    if (code !== 0) process.exitCode = code;
  } finally {
    if (passed) await rm(fixture.directory, { recursive: true, force: true });
    else console.error(`Extension test fixture and logs retained at ${fixture.directory}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
