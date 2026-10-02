// 격리된 Extension Development Host에서 확장 manifest와 activation을 확인하는 PR-00 smoke.
// - GitHub 인증·사용자 repository·사용자 window 없이 격리된 fixture에서 lifecycle과 Git 설정을 검증한다.
import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { GitService } from "../../src/git/gitService";
import { VscodeGitStatusProvider } from "../../src/providers/vscodeGitStatusProvider";

/** Development Host가 extension manifest를 찾고 activation까지 완료하는지 검사한다. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare");
  assert.ok(extension, "Git Simple Compare extension manifest was not discovered by the Development Host.");
  await extension.activate();
  assert.equal(extension.isActive, true, "Git Simple Compare extension did not activate.");
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("gitSimpleCompare.showChanges"), "Changes sidebar wrapper command was not registered.");
  assert.ok(commands.includes("gitSimpleCompare.cleanupVscodeCache"), "VS Code cache cleanup command was not registered.");
  assert.ok(commands.includes("gitSimpleCompare.cleanupStaleBranches"), "Stale branch cleanup command was not registered.");
  assert.ok(commands.includes("gitSimpleCompare.toggleBuiltinGit"), "Built-in Git toggle command was not registered.");
  assert.ok(commands.includes("gitSimpleCompare.toggleBuiltinGitUser"), "User-level built-in Git toggle command was not registered.");
  assert.equal(commands.includes("gitSimpleCompare.showReviews"), false, "Reviews sidebar wrapper command must not be registered.");
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
  await verifyBuiltinGitControl();
  await verifyBuiltinGitUserControl();
}

/**
 * 격리 profile의 사용자 전역 기본값·워크스페이스 우선순위와 실제 내장 Git 상태를 검증한다.
 * - runner가 전달한 전용 profile 경로를 확인하고 원래 설정을 복원해 사용자 환경을 보호한다.
 * @returns 사용자 기본값 상속, override 보존, 자체 CLI 동작을 확인하면 완료되는 Promise
 */
async function verifyBuiltinGitUserControl(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE;
  assert.ok(root);
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  assert.equal(process.env.GSC_EXTENSION_TEST_PROFILE, path.join(path.dirname(root), "profile"));
  /** 각 저장 이후에도 최신 설정 snapshot을 읽도록 Git 설정 객체를 새로 얻는다. */
  const config = () => vscode.workspace.getConfiguration("git");
  const original = config().inspect<boolean>("enabled");
  const git = await vscode.extensions.getExtension("vscode.git")!.activate() as {
    getAPI(version: 1): { repositories: Array<{ rootUri: vscode.Uri }> };
  };
  const provider = new VscodeGitStatusProvider(() => {});
  /** 최신 내장 Git API가 임시 저장소를 추적하는지 확인하며 중단 중 API 부재는 false로 처리한다. */
  const repositoryOpen = async (): Promise<boolean> => {
    try { return git.getAPI(1).repositories.some((repo) => repo.rootUri.fsPath === root); }
    catch { return false; }
  };
  try {
    assert.equal(original?.workspaceValue, undefined);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.checked");
    assert.equal(config().inspect("enabled")?.globalValue, false);
    assert.equal(config().inspect("enabled")?.workspaceValue, undefined);
    assert.equal(config().get("enabled"), false);
    await waitFor(async () => !await repositoryOpen());
    assert.equal(await provider.ensureReady(), false);
    const status = await new GitService(root).getStatusGroups({ force: true, includeStats: false });
    assert.ok(status.staged.some((file) => file.path === "sample.txt"));

    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit");
    assert.equal(config().inspect("enabled")?.workspaceValue, true);
    assert.equal(config().inspect("enabled")?.globalValue, false);
    await waitFor(repositoryOpen);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.unchecked");
    assert.equal(config().inspect("enabled")?.globalValue, true);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.checked");
    assert.equal(config().inspect("enabled")?.globalValue, false);
    assert.equal(config().inspect("enabled")?.workspaceValue, true);
    assert.equal(config().get("enabled"), true);
    await waitFor(repositoryOpen);

    await config().update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(async () => !await repositoryOpen());
    assert.equal(await provider.getStatusGroups(root), undefined);
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGitUser.unchecked");
    assert.equal(config().get("enabled"), true);
    await waitFor(repositoryOpen);
    await waitFor(async () => (await provider.getStatusGroups(root))?.staged
      .some((file) => file.path === "sample.txt") === true);
    console.log("User Git default, workspace precedence and independent CLI status passed.");
  } finally {
    provider.dispose();
    await config().update("enabled", original?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await config().update("enabled", original?.globalValue, vscode.ConfigurationTarget.Global);
  }
}

/**
 * 실제 내장 Git의 저장소 감시 중단·재개와 중단 상태의 자체 status·stage 동작을 검증한다.
 * - runner가 만든 임시 workspace만 허용해 사용자의 설정·index를 변경하지 않는다.
 * @returns 중단·재개와 CLI 상태 검증을 모두 완료하면 해결되는 Promise
 */
async function verifyBuiltinGitControl(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE;
  assert.ok(root, "Isolated Git fixture was not provided by the Extension Host runner.");
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  assert.ok(gitExtension, "Built-in Git extension was not found.");
  const git = await gitExtension.activate() as {
    enabled?: boolean;
    getAPI(version: 1): { repositories: Array<{ rootUri: vscode.Uri }> };
  };
  const provider = new VscodeGitStatusProvider(() => {});
  const globalEnabled = vscode.workspace.getConfiguration("git").inspect("enabled")?.globalValue;
  assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), false);
  assert.equal(await provider.ensureReady(), false);
  await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit.unchecked");
  assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), true);
  let initialApiState = "";
  try {
    await waitFor(async () => {
      try {
        const roots = git.getAPI(1).repositories.map((repo) => repo.rootUri.fsPath);
        initialApiState = JSON.stringify(roots);
        return roots.includes(root);
      } catch (error) {
        initialApiState = String(error);
        return false;
      }
    });
  } catch (error) {
    console.error({ root, enabled: git.enabled, initialApiState });
    throw error;
  }
  const api = git.getAPI(1);
  assert.equal(await provider.ensureReady(), true);

  try {
    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit.checked");
    assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), false);
    assert.equal(vscode.workspace.getConfiguration("git").inspect("enabled")?.workspaceValue, false);
    await waitFor(async () => !api.repositories.some((repo) => repo.rootUri.fsPath === root));
    assert.equal(await provider.getRepositories(), undefined);
    assert.equal(await provider.getStatusGroups(root), undefined);
    assert.equal(await provider.ensureReady(), false);

    const service = new GitService(root);
    const unstaged = await service.getStatusGroups({ force: true, includeStats: false });
    assert.ok(unstaged.unstaged.some((file) => file.path === "sample.txt"));
    await service.stage(["sample.txt"]);
    const staged = await service.getStatusGroups({ force: true, includeStats: false });
    assert.ok(staged.staged.some((file) => file.path === "sample.txt"));

    await vscode.commands.executeCommand("gitSimpleCompare.toggleBuiltinGit.unchecked");
    assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), true);
    await waitFor(async () => api.repositories.some((repo) => repo.rootUri.fsPath === root));
    await waitFor(async () => (await provider.getStatusGroups(root))?.staged
      .some((file) => file.path === "sample.txt") === true);
    assert.equal(vscode.workspace.getConfiguration("git").inspect("enabled")?.globalValue, globalEnabled);
    console.log("Built-in Git stopped/resumed and independent CLI status/stage passed.");
  } finally {
    provider.dispose();
    await vscode.workspace.getConfiguration("git").update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
  }
}

/**
 * 내장 Git의 비동기 repository 이벤트가 fixture 상태에 수렴할 때까지 제한 시간 안에서 기다린다.
 * @param predicate 현재 상태에서 검증 조건이 만족됐는지 확인하는 비동기 함수
 * @returns 20초 내 만족하면 완료하고, 만료되면 테스트를 실패시킨다.
 */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Built-in Git did not reach the expected repository state within 20 seconds.");
}
