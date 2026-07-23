// commit, hook 관리, staged hook 사전 실행 명령의 package ID와 handler를 한곳에서 배선한다.
// - 전체 commands/index.ts가 기능별 등록 세부사항으로 비대해지지 않게 commit 도메인을 분리한다.
import * as vscode from "vscode";
import { commitChanges } from "./commit";
import {
  runCommitHookPreflight,
  type RunCommitHookPreflightArgs,
} from "./commitHookPreflight";
import {
  createCommitHook,
  dismissCommitFailure,
  openCommitFailure,
  openCommitHook,
  openCommitHooksFolder,
  refreshCommitHooks,
  showCommitFailureOutput,
  toggleCommitHook,
} from "./commitHooks";
import type { CommandDeps } from "./shared";

/**
 * commit 실행과 file hook 관리/진단 명령을 등록한다.
 * @param deps 활성 Changes 저장소와 Git 서비스 registry를 제공하는 공유 의존성
 * @returns extension context가 dispose할 VS Code command 등록 목록
 */
export function registerCommitCommands(
  deps: CommandDeps
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "gitSimpleCompare.commit",
      (op?: Parameters<typeof commitChanges>[1]) => commitChanges(deps, op)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.runCommitHookPreflight",
      (args?: RunCommitHookPreflightArgs) =>
        runCommitHookPreflight(deps, args)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.refreshCommitHooks",
      () => refreshCommitHooks(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.toggleCommitHook",
      (args) => toggleCommitHook(deps, args)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.createCommitHook",
      () => createCommitHook(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openCommitHook",
      (name?: string) => openCommitHook(deps, name)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openCommitHooksFolder",
      () => openCommitHooksFolder(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openCommitFailure",
      (args) => openCommitFailure(deps, args)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.dismissCommitFailure",
      () => dismissCommitFailure(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.showCommitFailureOutput",
      showCommitFailureOutput
    ),
  ];
}
