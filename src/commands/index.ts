// 명령 등록 모듈.
// - package.json 에 선언된 command id 와 실제 핸들러를 한곳에서 연결한다.
// - 핸들러는 각 기능 모듈에 두고, 여기서는 "배선(wiring)"만 담당해 책임을 분리한다.
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import {
  changeComparisonRef,
  compareBranches,
  openChangeDiff,
  runComparison,
} from "./compareBranches";
import {
  compareActiveFileWithBranch,
  compareExplorerFileWithBranch,
} from "./compareFile";
import { changeSortOrder, setViewMode } from "./viewState";
import { applyLeftToRight } from "./applyChanges";
import { showGraph } from "./showGraph";
import { startInteractiveRebase } from "./rebase";
import { showSplitCommits } from "./splitCommits";
import {
  abortOperation,
  continueOperation,
  markResolved,
  openMergeEditor,
  refreshConflicts,
  takeOurs,
  takeTheirs,
} from "./conflicts";
import { ChangeDiffArgs } from "../providers/changesTreeModel";

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
      deps.changesView.refresh()
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openChangeDiff",
      (args: ChangeDiffArgs) => openChangeDiff(args)
    ),
    // From/To 헤더 클릭/편집 → 한쪽 브랜치만 바꿔 재비교
    vscode.commands.registerCommand(
      "gitSimpleCompare.changeComparisonRef",
      (arg) => changeComparisonRef(deps, arg)
    ),
    // 설정 단계의 Compare 액션 → 초안 from/to 로 비교 실행
    vscode.commands.registerCommand("gitSimpleCompare.runComparison", () =>
      runComparison(deps)
    ),
    // 보기 상태: 트리/리스트 토글 및 정렬 변경
    vscode.commands.registerCommand("gitSimpleCompare.viewAsTree", () =>
      setViewMode(deps, "tree")
    ),
    vscode.commands.registerCommand("gitSimpleCompare.viewAsList", () =>
      setViewMode(deps, "list")
    ),
    vscode.commands.registerCommand("gitSimpleCompare.changeSortOrder", () =>
      changeSortOrder(deps)
    ),
    // diff 창: 좌측(브랜치) 내용을 우측(작업파일)에 일괄 반영
    vscode.commands.registerCommand(
      "gitSimpleCompare.applyLeftToRight",
      () => applyLeftToRight()
    ),
    // git 그래프 웹뷰 열기
    vscode.commands.registerCommand("gitSimpleCompare.showGraph", () =>
      showGraph(deps)
    ),
    // 인터랙티브 rebase 시작
    vscode.commands.registerCommand(
      "gitSimpleCompare.startInteractiveRebase",
      () => startInteractiveRebase(deps)
    ),
    // 변경을 여러 커밋으로 분할
    vscode.commands.registerCommand(
      "gitSimpleCompare.splitCommits",
      () => showSplitCommits(deps)
    ),
    // 충돌 해결
    vscode.commands.registerCommand("gitSimpleCompare.refreshConflicts", () =>
      refreshConflicts(deps.conflicts)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.takeOurs",
      (rel: string) => takeOurs(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.takeTheirs",
      (rel: string) => takeTheirs(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.markResolved",
      (rel: string) => markResolved(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openMergeEditor",
      (rel: string) => openMergeEditor(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.continueOperation", () =>
      continueOperation(deps.conflicts)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.abortOperation", () =>
      abortOperation(deps.conflicts)
    ),
  ];
}
