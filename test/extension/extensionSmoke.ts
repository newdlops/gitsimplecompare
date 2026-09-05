// 격리된 Extension Development Host에서 확장 manifest와 activation을 확인하는 PR-00 smoke.
// - GitHub 인증·실제 repository·사용자 window를 요구하지 않는 최소 lifecycle 검증만 수행한다.
import assert from "node:assert/strict";
import * as vscode from "vscode";

/** Development Host가 extension manifest를 찾고 activation까지 완료하는지 검사한다. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare");
  assert.ok(extension, "Git Simple Compare extension manifest was not discovered by the Development Host.");
  await extension.activate();
  assert.equal(extension.isActive, true, "Git Simple Compare extension did not activate.");
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("gitSimpleCompare.showChanges"), "Changes sidebar wrapper command was not registered.");
  assert.ok(commands.includes("gitSimpleCompare.cleanupVscodeCache"), "VS Code cache cleanup command was not registered.");
  assert.equal(commands.includes("gitSimpleCompare.showReviews"), false, "Reviews sidebar wrapper command must not be registered.");
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
}
