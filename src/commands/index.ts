// 명령 등록 모듈.
// - package.json 에 선언된 command id 와 실제 핸들러를 한곳에서 연결한다.
// - 핸들러는 각 기능 모듈에 두고, 여기서는 "배선(wiring)"만 담당해 책임을 분리한다.
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import { compareBranches, openChangeDiff } from "./compareBranches";
import {
  compareActiveFileWithBranch,
  compareExplorerFileWithBranch,
} from "./compareFile";
import { ChangeDiffArgs } from "../providers/changesTreeProvider";

/**
 * 모든 명령을 등록하고 Disposable 배열을 반환한다.
 * - 반환된 Disposable 들은 extension.ts 에서 context.subscriptions 에 등록한다.
 * - 새 명령을 추가할 때는 이 배열에 한 줄만 더하면 된다(확장성).
 * @param deps 명령들이 공유하는 의존성
 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("gitSimpleCompare.compareBranches", () =>
      compareBranches(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareFileWithBranch",
      (uri?: vscode.Uri) => compareExplorerFileWithBranch(deps, uri)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareActiveFileWithBranch",
      () => compareActiveFileWithBranch(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.refreshChanges", () =>
      deps.treeProvider.refresh()
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openChangeDiff",
      (args: ChangeDiffArgs) => openChangeDiff(args)
    ),
  ];
}
