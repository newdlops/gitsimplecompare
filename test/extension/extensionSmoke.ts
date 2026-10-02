// 격리된 Extension Development Host에서 확장 manifest와 activation을 확인하는 PR-00 smoke.
// - GitHub 인증·사용자 repository·사용자 window 없이 격리된 fixture에서 lifecycle과 Git 설정을 검증한다.
import assert from "node:assert/strict";
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
  assert.equal(commands.includes("gitSimpleCompare.showReviews"), false, "Reviews sidebar wrapper command must not be registered.");
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
  await verifyBuiltinGitControl();
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
