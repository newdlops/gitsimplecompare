// 별도 process group 안에서 VS Code Extension Development Host smoke를 실행하는 내부 진입점.
// - 상위 runner가 timeout/interrupt 때 이 process group 전체를 종료하므로 여기서는 test-electron 결과만 전달한다.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runTests } from "@vscode/test-electron";

const workspaceRoot = process.cwd();
const pushSmoke = process.env.GSC_EXTENSION_TEST_KIND === "pushSmoke";
const onboardingSmoke = process.env.GSC_EXTENSION_TEST_KIND === "repositoryOnboardingSmoke";
const blameSmoke = process.env.GSC_EXTENSION_TEST_KIND === "blameGutterSmoke";
const extensionTestsPath = path.join(workspaceRoot, "out-test-extension", `${process.env.GSC_EXTENSION_TEST_KIND || "extensionSmoke"}.js`);

/** 현재 platform에 이미 설치된 VS Code executable을 우선 찾아 불필요한 download를 막는다. */
function installedVscodeExecutable() {
  const configured = process.env.GSC_VSCODE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/MacOS/Code", "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"]
    : process.platform === "win32"
      ? ["C:\\Program Files\\Microsoft VS Code\\Code.exe"]
      : ["/usr/share/code/code", "/usr/bin/code"];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * 사용자 저장소·설정 대신 임시 Git 저장소와 전용 VS Code profile을 만들어 command smoke를 격리한다.
 * @returns 정리 대상 디렉터리·fixture root·빈 창 또는 단일/다중 workspace 진입 경로
 */
async function createWorkspaceFixture() {
  // macOS의 긴 /var/folders 경로는 실제 경로 보정 후 Unix socket의 103자 제한을 넘을 수 있다.
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const directory = await realpath(await mkdtemp(path.join(temporaryRoot, "gsc-extension-smoke-")));
  const repoRoot = path.join(directory, "workspace");
  await mkdir(repoRoot);
  await mkdir(path.join(repoRoot, ".vscode"));
  const nativeEnabled = process.env.GSC_ONBOARDING_NATIVE_GIT === "true";
  const settings = { "git.enabled": nativeEnabled, "git.autorefresh": false, "git.autofetch": "all" };
  await writeFile(path.join(repoRoot, ".vscode", "settings.json"), JSON.stringify(settings));
  const userSettings = path.join(directory, "profile", "User");
  await mkdir(userSettings, { recursive: true });
  await writeFile(path.join(userSettings, "settings.json"), JSON.stringify({
    "git.enabled": onboardingSmoke && process.env.GSC_ONBOARDING_EMPTY_WINDOW ? nativeEnabled : !nativeEnabled,
    "git.autorefresh": true, "git.autofetch": false,
    ...(blameSmoke ? { "chat.disableAIFeatures": true } : {}),
  }));
  if (process.env.GSC_ONBOARDING_EMPTY_WINDOW) return { directory, repoRoot };
  if (process.env.GSC_GIT_STARTUP_UI_CAPTURE) return { directory, repoRoot, launchPath: repoRoot };
  if (onboardingSmoke) {
    const secondRoot = path.join(directory, "second"); await mkdir(secondRoot);
    const launchPath = path.join(directory, "onboarding.code-workspace");
    await writeFile(launchPath, JSON.stringify({ folders: [{ path: repoRoot }, { path: secondRoot }], settings }));
    return { directory, repoRoot, launchPath };
  }
  await mkdir(path.join(directory, "hooks"));
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
  git(["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  git(["config", "user.name", "Extension Smoke"]);
  git(["config", "user.email", "extension-smoke@example.invalid"]);
  git(["config", "core.hooksPath", path.join(directory, "hooks")]);
  git(["config", "commit.gpgSign", "false"]);
  git(["config", "core.fsmonitor", "false"]);
  await writeFile(path.join(repoRoot, "sample.txt"), "base\n");
  git(["add", "sample.txt"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  await writeFile(path.join(repoRoot, "sample.txt"), "base\nchanged\n");
  return { directory, repoRoot, launchPath: repoRoot };
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
    const options = {
      extensionDevelopmentPath: process.env.GSC_EXTENSION_UNDER_TEST || workspaceRoot,
      extensionTestsPath,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: "1.85.0" }),
      extensionTestsEnv: {
        GSC_EXTENSION_TEST_FIXTURE: fixture.repoRoot,
        GSC_EXTENSION_TEST_PROFILE: path.join(fixture.directory, "profile"),
        ...(blameSmoke ? {
          GSC_BLAME_RESULT_DIR: process.env.GSC_BLAME_RESULT_DIR || path.join(workspaceRoot, "test-results", "native-blame"),
          GSC_TEST_MAIN_INSPECTOR_PORT: process.env.GSC_TEST_MAIN_INSPECTOR_PORT || "9239",
          GSC_BLAME_BASELINE: process.env.GSC_BLAME_BASELINE || "",
        } : {}),
        ...(onboardingSmoke ? {
          GSC_ONBOARDING_EMPTY_WINDOW: process.env.GSC_ONBOARDING_EMPTY_WINDOW ?? "",
          GSC_ONBOARDING_PUBLIC_CLONE: process.env.GSC_ONBOARDING_PUBLIC_CLONE ?? "",
        } : {}),
        ...(pushSmoke ? { GSC_PUSH_UI_CAPTURE: process.env.GSC_PUSH_UI_CAPTURE ?? "" } : {}),
        ...(process.env.GSC_NATIVE_UI_CAPTURE ? { GSC_NATIVE_UI_CAPTURE: process.env.GSC_NATIVE_UI_CAPTURE } : {}),
        ...(process.env.GSC_GIT_STARTUP_UI_CAPTURE ? { GSC_GIT_STARTUP_UI_CAPTURE: process.env.GSC_GIT_STARTUP_UI_CAPTURE } : {}),
      },
      launchArgs: [
        "--disable-extensions", "--skip-welcome", "--disable-workspace-trust",
        `--user-data-dir=${path.join(fixture.directory, "profile")}`,
        `--extensions-dir=${path.join(fixture.directory, "extensions")}`,
        ...(blameSmoke ? [`--inspect=127.0.0.1:${process.env.GSC_TEST_MAIN_INSPECTOR_PORT || "9239"}`, "--new-window"] : []),
        ...(process.env.GSC_TEST_DEBUG_PORT ? [`--remote-debugging-port=${process.env.GSC_TEST_DEBUG_PORT}`] : []),
        ...(fixture.launchPath ? [fixture.launchPath] : []),
      ],
    };
    const code = await runTests(options);
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
