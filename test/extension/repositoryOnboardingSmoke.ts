// 실제 VS Code에서 기본 Git을 켜거나 끄지 않고 자체 명령·온보딩 연결을 검증한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { GitService } from "../../src/git/gitService";
import { VscodeGitStatusProvider } from "../../src/providers/vscodeGitStatusProvider";
import type { GitSimpleCompareApi } from "../../src/extensionApi";

/** 조건이 실제 host에서 성립할 때까지 기다리며 살아 있는 테스트의 종료 상한을 지킨다. */
async function waitFor(predicate: () => Promise<boolean>, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  assert.fail("Repository onboarding did not reach the expected state.");
}

/** runner 전용 profile/root만 접근하는지 확인해 사용자 저장소를 테스트에서 변경하지 않는다. */
function fixtureRoot(): string {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE;
  assert.ok(root);
  if (!process.env.GSC_ONBOARDING_EMPTY_WINDOW) assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  assert.equal(process.env.GSC_EXTENSION_TEST_PROFILE, path.join(path.dirname(root), "profile"));
  return root;
}

/** 세 범위의 native 설정을 비교하기 위한 값만 복사한다. token이나 사용자 계정은 읽지 않는다. */
function nativeSettings(): unknown {
  const config = vscode.workspace.getConfiguration("git");
  return ["enabled", "autorefresh", "autofetch"].map(key => ({ key, inspect: config.inspect(key), value: config.get(key) }));
}

/** 사용자·workspace 토글이 확장 전용 설정만 변경하며 자체 CLI 상태와 stage가 동작하는지 확인한다. */
export async function verifyBuiltinGitControl(): Promise<void> {
  const root = fixtureRoot(), before = nativeSettings();
  const config = () => vscode.workspace.getConfiguration("gitSimpleCompare");
  const original = config().inspect<boolean>("useBuiltinGitStatus");
  const provider = new VscodeGitStatusProvider(() => {});
  try {
    assert.equal(config().get("useBuiltinGitStatus"), false);
    assert.equal(await provider.ensureReady(), false);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit.unchecked");
    assert.equal(config().get("useBuiltinGitStatus"), true);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit.checked");
    assert.equal(config().get("useBuiltinGitStatus"), false);
    assert.equal(await provider.ensureReady(), false);
    const service = new GitService(root);
    const unstaged = await service.getStatusGroups({ force: true, includeStats: false });
    assert.ok(unstaged.unstaged.some(file => file.path === "sample.txt"));
    await service.stage(["sample.txt"]);
    assert.ok((await service.getStatusGroups({ force: true, includeStats: false })).staged.some(file => file.path === "sample.txt"));
    assert.deepEqual(nativeSettings(), before);
    console.log("PASS: workspace status reuse toggle and own CLI status/stage preserve all native Git preferences.");
  } finally {
    provider.dispose();
    await config().update("useBuiltinGitStatus", original?.workspaceValue, vscode.ConfigurationTarget.Workspace);
  }
}

/** user 선택을 workspace가 덮어써도 Git 설정의 각 범위는 유지되는지 확인한다. */
export async function verifyBuiltinGitUserControl(): Promise<void> {
  const before = nativeSettings(), config = () => vscode.workspace.getConfiguration("gitSimpleCompare");
  const original = config().inspect<boolean>("useBuiltinGitStatus");
  try {
    await config().update("useBuiltinGitStatus", false, vscode.ConfigurationTarget.Global);
    await config().update("useBuiltinGitStatus", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.unchecked");
    assert.equal(config().inspect("useBuiltinGitStatus")?.globalValue, true);
    await config().update("useBuiltinGitStatus", false, vscode.ConfigurationTarget.Workspace);
    assert.equal(config().get("useBuiltinGitStatus"), false);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.checked");
    assert.equal(config().inspect("useBuiltinGitStatus")?.globalValue, false);
    assert.deepEqual(nativeSettings(), before);
    console.log("PASS: user/workspace engine selection preserves native Git flags and scope precedence.");
  } finally {
    await config().update("useBuiltinGitStatus", original?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await config().update("useBuiltinGitStatus", original?.globalValue, vscode.ConfigurationTarget.Global);
  }
}

/** Clone/Init/Open은 production 명령으로 실행하고 GitHub 인증 provider는 Git과 독립적으로 준비되는지 확인한다. */
export async function verifyOwnRepositoryCommands(): Promise<void> {
  const root = fixtureRoot(), before = nativeSettings(), directory = path.dirname(root);
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["getStarted", "cloneRepository", "cloneFromGitHub", "openRepository", "initializeRepository"]) {
    assert.ok(commands.includes("gitSimpleCompare." + id));
  }
  await vscode.commands.executeCommand("gitSimpleCompare.getStarted");
  const sourceIndex = await readFile(path.join(root, ".git/index"));
  const cloned = path.join(directory, "own clone");
  await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository", { source: root, parentDirectory: directory, folderName: "own clone", open: "none" });
  assert.equal(await readFile(path.join(cloned, "sample.txt"), "utf8"), "base\n");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloned, encoding: "utf8" }),
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(await readFile(path.join(root, ".git/index")), sourceIndex);
  const initialized = path.join(directory, "own initialized"); await mkdir(initialized);
  await writeFile(path.join(initialized, "keep.txt"), "keep\n");
  await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository", { directory: initialized, open: "none" });
  assert.ok((await stat(path.join(initialized, ".git/HEAD"))).isFile());
  assert.equal(await readFile(path.join(initialized, "keep.txt"), "utf8"), "keep\n");
  await vscode.commands.executeCommand("gitSimpleCompare.openRepository", { directory: root });
  const github = vscode.extensions.getExtension("vscode.github-authentication");
  assert.ok(github, "GitHub sign-in provider must be present independently of vscode.git");
  await github.activate();
  await vscode.authentication.getSession("github", ["repo"], { silent: true });
  assert.deepEqual(nativeSettings(), before);
  console.log("PASS: own Clone/Init/Open and independent GitHub authentication work without changing git.enabled.");
}

/**
 * 저장소가 없는 실제 시작 화면을 보여 주고 UI로 초기화한 뒤 Changes 연결을 확인한다.
 * @param prefix 캡처 준비/종료 신호를 저장할 테스트 전용 경로
 * @param api 활성 확장의 실제 공유 상태 API
 */
export async function captureGitStartupUi(prefix: string, api: GitSimpleCompareApi): Promise<void> {
  const root = fixtureRoot(), before = nativeSettings();
  await vscode.commands.executeCommand("workbench.view.scm");
  await writeFile(prefix + ".ready", root);
  console.log("ONBOARDING_CAPTURE_READY: " + root);
  await waitFor(() => readFile(prefix + ".done", "utf8").then(() => true, () => false), 10 * 60_000);
  assert.ok((await stat(path.join(root, ".git/HEAD"))).isFile(), "The UI must initialize the fixture repository.");
  assert.equal((await api.workingTreeStatus.getStatus(root)).branch, "main");
  assert.deepEqual(nativeSettings(), before);
  console.log("PASS: startup welcome → own Init → Changes, with native Git settings preserved.");
}

/** 빈 창에서도 온보딩 자체 선택과 Init 명령이 workspace 없이 동작하는지 실제 host에서 확인한다. */
async function verifyEmptyWindow(): Promise<void> {
  assert.equal(vscode.workspace.workspaceFolders, undefined);
  const root = fixtureRoot(), before = nativeSettings();
  await vscode.commands.executeCommand("gitSimpleCompare.getStarted");
  await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository", { directory: root, open: "none" });
  assert.ok((await stat(path.join(root, ".git/HEAD"))).isFile());
  assert.deepEqual(nativeSettings(), before);
  console.log("PASS: empty-window own Init and onboarding preserve native Git preferences.");
}

/**
 * 빈 workspace에서 Init 후 다른 저장소를 Add하여 실제 production stage가 새 저장소에 적용되는지 확인한다.
 * @returns 새 저장소 선택과 파일 stage로 온보딩 첫 실사용을 증명한다.
 */
async function verifySetupToChanges(api: GitSimpleCompareApi): Promise<void> {
  const root = fixtureRoot(), before = nativeSettings(), directory = path.dirname(root);
  await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository", { directory: root });
  assert.ok((await stat(path.join(root, ".git/HEAD"))).isFile());
  const source = path.join(directory, "source"); await mkdir(source);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("-c", "init.templateDir=", "init", "--initial-branch=main");
  await writeFile(path.join(source, "source.txt"), "source\n");
  git("add", "source.txt");
  git("-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "-c", "user.name=Onboarding", "-c", "user.email=onboarding@example.invalid", "commit", "-qm", "source");
  const cloned = path.join(directory, "connected clone");
  await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository", { source, parentDirectory: directory, folderName: "connected clone", open: "add" });
  assert.equal(await readFile(path.join(cloned, "source.txt"), "utf8"), "source\n");
  await writeFile(path.join(cloned, "onboarding-only.txt"), "first Git Simple Compare change\n");
  await vscode.commands.executeCommand("gitSimpleCompare.stage", ["onboarding-only.txt"]);
  assert.ok((await api.workingTreeStatus.getStatus(cloned)).groups.staged.some(file => file.path === "onboarding-only.txt"));
  assert.deepEqual(nativeSettings(), before);
  if (process.env.GSC_ONBOARDING_PUBLIC_CLONE) {
    await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository", { source: "https://github.com/octocat/Hello-World.git", parentDirectory: directory, folderName: "public-github", open: "none" });
    assert.ok((await stat(path.join(directory, "public-github/.git/HEAD"))).isFile());
    assert.deepEqual(nativeSettings(), before);
    console.log("PASS: actual public GitHub clone through own CLI, with native Git preferences preserved.");
  }
  const github = vscode.extensions.getExtension("vscode.github-authentication"); assert.ok(github);
  await github.activate(); await vscode.authentication.getSession("github", ["repo"], { silent: true });
  console.log("PASS: own Init → Clone → Add to workspace → production Stage, plus independent GitHub authentication.");
}

/** Native Git true/false·빈 창·실제 첫 setup의 별도 matrix 진입점이다. */
export async function run(): Promise<void> {
  const before = nativeSettings();
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare"); assert.ok(extension);
  await extension.activate();
  assert.deepEqual(nativeSettings(), before, "Activation must not migrate or rewrite any native Git setting.");
  const api = extension.exports as GitSimpleCompareApi;
  if (process.env.GSC_GIT_STARTUP_UI_CAPTURE) return captureGitStartupUi(process.env.GSC_GIT_STARTUP_UI_CAPTURE, api);
  if (process.env.GSC_ONBOARDING_EMPTY_WINDOW) return verifyEmptyWindow();
  await verifySetupToChanges(api);
}
