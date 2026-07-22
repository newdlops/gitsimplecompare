// 명령 등록 모듈.
// - package.json 에 선언된 command id 와 실제 핸들러를 한곳에서 연결한다.
// - 핸들러는 각 기능 모듈에 두고, 여기서는 "배선(wiring)"만 담당해 책임을 분리한다.
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import {
  changeComparisonRef,
  compareBranches,
  compareBranchesAdvanced,
  openChangeDiff,
  runComparison,
  swapBranchComparison,
} from "./compareBranches";
import {
  compareActiveFileWithBranch,
  compareExplorerFileWithBranch,
} from "./compareFile";
import {
  changeSortOrder,
  setViewMode,
  toggleSectionViewMode,
  toggleVisibleSection,
} from "./viewState";
import type { TreeSection, VisibleSection } from "../webview/changesViewProvider";
import { applyLeftToRight } from "./applyChanges";
import { openDiffFileEditor } from "./diffEditor";
import { showGraph } from "./showGraph";
import { checkoutBranch } from "./checkoutBranch";
import {
  branchRebaseMerge,
  branchSquashMerge,
  undoBranchOperation,
} from "./branchOperations";
import { cleanupPullRequestOperationWorktrees } from "./prOperationWorktrees";
import { configureAiCli, loginAiCli } from "./aiSettings";
import { generateCommitMessage } from "./aiMessages";
import { openAiCommitPlan, type OpenAiCommitPlanArgs } from "./aiCommitPlan";
import { commitChanges } from "./commit";
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
import { configureUserProfile } from "./userProfile";
import { configureRemoteBranch } from "./remoteBranch";
import {
  clearGitHubWebCookie,
  setGitHubWebCookie,
} from "./githubWebCookie";
import {
  toggleBlameDecorator,
  toggleBlameLineVisible,
} from "./blame";
import { showSplitCommits } from "./splitCommits";
import {
  discardEditorHunks,
  stageEditorHunks,
  toggleSelectedLineCheckboxes,
} from "./editorHunks";
import { refreshChangesView } from "./refreshChangesView";
import type { RefreshRequest } from "./refreshChangesView";
import {
  openFileHistoryCommit,
  refreshFileHistory,
  type FileHistoryRefreshRequest,
  type OpenFileHistoryCommitArgs,
} from "./fileHistory";
import {
  addToExclude,
  addToGitignore,
  discardChanges,
  openFile,
  openWorkingChange,
  refreshWorkingChanges,
  stageChanges,
  unstageChanges,
} from "./workingChanges";
import { runScmAction } from "./scmActions";
import {
  applyStash,
  branchStash,
  dropStash,
  loadStashFilesForView,
  openStashFile,
  popStash,
  refreshStashes,
  stashSelected,
} from "./stash";
import {
  abortOperation,
  continueOperation,
  markResolved,
  openConflictEditor,
  openMergeEditor,
  refreshConflicts,
  rollbackPull,
  skipOperation,
  takeBoth,
  takeCurrent,
  takeIncoming,
  takeOurs,
  takeTheirs,
} from "./conflicts";
import {
  createWorktree,
  openWorktree,
  refreshWorktrees,
  removeWorktree,
  renameWorktree,
} from "./worktrees";
import {
  changeStackPullRequestBase,
  createStackPullRequest,
  openStackPullRequest,
  refreshPullRequestStacks,
} from "./pullRequestStacks";
import { ChangeDiffArgs } from "../providers/changesTreeModel";
import { SHOW_BLOCK_BLAME_COMMAND } from "../providers/blockBlameCodeLensPresentation";
import {
  clearExplorerComparison,
  compareLocalWithRemote,
  comparePullRequest,
  ComparisonFocus,
  hideExplorerComparison,
  OpenComparisonDiffArgs,
  openComparisonDiff,
  openComparisonFile,
  refreshExplorerComparison,
  selectExplorerComparison,
  showExplorerComparison,
} from "./comparisonDecorations";

const SECTION_TOGGLE_COMMANDS: [string, VisibleSection][] = [
  ["gitSimpleCompare.toggleSection.repos.visible", "repos"],
  ["gitSimpleCompare.toggleSection.repos.hidden", "repos"],
  ["gitSimpleCompare.toggleSection.changes.visible", "changes"],
  ["gitSimpleCompare.toggleSection.changes.hidden", "changes"],
  ["gitSimpleCompare.toggleSection.history.visible", "history"],
  ["gitSimpleCompare.toggleSection.history.hidden", "history"],
  ["gitSimpleCompare.toggleSection.compare.visible", "compare"],
  ["gitSimpleCompare.toggleSection.compare.hidden", "compare"],
  ["gitSimpleCompare.toggleSection.stashes.visible", "stashes"],
  ["gitSimpleCompare.toggleSection.stashes.hidden", "stashes"],
  ["gitSimpleCompare.toggleSection.worktrees.visible", "worktrees"],
  ["gitSimpleCompare.toggleSection.worktrees.hidden", "worktrees"],
  ["gitSimpleCompare.toggleSection.pullRequestStacks.visible", "pullRequestStacks"],
  ["gitSimpleCompare.toggleSection.pullRequestStacks.hidden", "pullRequestStacks"],
];

const BLAME_DECORATOR_COMMANDS = [
  "gitSimpleCompare.toggleBlameDecorator",
  "gitSimpleCompare.toggleBlameDecorator.checked",
  "gitSimpleCompare.toggleBlameDecorator.unchecked",
];

const BLAME_LINE_COMMANDS = [
  "gitSimpleCompare.toggleBlameLineVisible",
  "gitSimpleCompare.toggleBlameLineVisible.checked",
  "gitSimpleCompare.toggleBlameLineVisible.unchecked",
];

const BLAME_BLOCK_COMMANDS = [
  "gitSimpleCompare.toggleBlameBlockVisible",
  "gitSimpleCompare.toggleBlameBlockVisible.checked",
  "gitSimpleCompare.toggleBlameBlockVisible.unchecked",
];

/**
 * 모든 명령을 등록하고 Disposable 배열을 반환한다.
 * - 반환된 Disposable 들은 extension.ts 에서 context.subscriptions 에 등록한다.
 * - 새 명령을 추가할 때는 이 배열에 한 줄만 더하면 된다(확장성).
 * @param deps 명령들이 공유하는 의존성
 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    // provider/controller가 파일·git 이벤트 새로고침을 요청하면 같은 명령 경로로 합친다.
    deps.comparison.onDidRequestRefresh((request) => {
      void refreshExplorerComparison(deps, request.reason, false);
    }),
    ...SECTION_TOGGLE_COMMANDS.map(([command, section]) =>
      vscode.commands.registerCommand(command, () =>
        toggleVisibleSection(deps, section)
      )
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareBranches",
      (focus?: ComparisonFocus) => compareBranches(deps, focus)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareBranchesAdvanced",
      (focus?: ComparisonFocus) => compareBranchesAdvanced(deps, focus)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openGutterSettings",
      () =>
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@id:scm.diffDecorations"
        )
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.selectExplorerComparison",
      () => selectExplorerComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareLocalWithRemote",
      () => compareLocalWithRemote(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.comparePullRequest",
      () => comparePullRequest(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.showExplorerComparison",
      () => showExplorerComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.hideExplorerComparison",
      () => hideExplorerComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.refreshExplorerComparison",
      () => refreshExplorerComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.clearExplorerComparison",
      () => clearExplorerComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.swapBranchComparison",
      () => swapBranchComparison(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openComparisonDiff",
      (args: OpenComparisonDiffArgs) => openComparisonDiff(deps, args)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openComparisonFile",
      (args: OpenComparisonDiffArgs) => openComparisonFile(deps, args)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.checkoutBranch", () =>
      checkoutBranch(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.branchSquashMerge", () =>
      branchSquashMerge(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.branchRebaseMerge", () =>
      branchRebaseMerge(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.undoBranchOperation", () =>
      undoBranchOperation(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.cleanupPrOperationWorktrees",
      () => cleanupPullRequestOperationWorktrees(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareFileWithBranch",
      (uri?: vscode.Uri) => compareExplorerFileWithBranch(deps, uri)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.compareActiveFileWithBranch",
      () => compareActiveFileWithBranch(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.refreshChanges",
      (request?: RefreshRequest) => refreshChangesView(deps, request)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.refreshFileHistory",
      (request?: FileHistoryRefreshRequest) => refreshFileHistory(deps, request)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openFileHistoryCommit",
      (arg: OpenFileHistoryCommitArgs) => openFileHistoryCommit(arg)
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
    // Changes 섹션: 작업트리 변경 새로고침 / 항목 열기
    vscode.commands.registerCommand(
      "gitSimpleCompare.refreshWorkingChanges",
      () => refreshWorkingChanges(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openWorkingChange",
      (arg: {
        root: string;
        path: string;
        stage?: "staged" | "unstaged";
        hasStaged?: boolean;
        status?: string;
      }) =>
        openWorkingChange(deps, arg)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openFile",
      (arg: { root: string; path: string }) => openFile(arg)
    ),
    // Changes 섹션: 스테이징/해제/버리기/커밋(웹뷰가 호출하는 내부 명령)
    vscode.commands.registerCommand(
      "gitSimpleCompare.stage",
      (paths?: string[]) => stageChanges(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.unstage",
      (paths?: string[]) => unstageChanges(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.discard",
      (paths?: string[]) => discardChanges(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.addToGitignore",
      (paths?: string[]) => addToGitignore(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.addToExclude",
      (paths?: string[]) => addToExclude(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.commit",
      (op?: Parameters<typeof commitChanges>[1]) => commitChanges(deps, op)
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
    vscode.commands.registerCommand(
      "gitSimpleCompare.generateCommitMessage",
      () => generateCommitMessage(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openAiCommitPlan",
      (args?: OpenAiCommitPlanArgs) => openAiCommitPlan(deps, args)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.configureAiCli", () =>
      configureAiCli(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.configureUserProfile", () =>
      configureUserProfile(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.configureRemoteBranch", () =>
      configureRemoteBranch(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.setGitHubWebCookie", () =>
      setGitHubWebCookie(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.clearGitHubWebCookie", () =>
      clearGitHubWebCookie(deps)
    ),
    ...BLAME_DECORATOR_COMMANDS.map((command) =>
      vscode.commands.registerCommand(command, () => toggleBlameDecorator(deps))
    ),
    ...BLAME_LINE_COMMANDS.map((command) =>
      vscode.commands.registerCommand(command, () =>
        toggleBlameLineVisible(deps)
      )
    ),
    ...BLAME_BLOCK_COMMANDS.map((command) =>
      vscode.commands.registerCommand(command, () =>
        deps.blockBlameCodeLens.toggleVisible()
      )
    ),
    vscode.commands.registerCommand(SHOW_BLOCK_BLAME_COMMAND, (request) =>
      deps.blockBlamePresenter.show(request)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.loginAiCli",
      (provider?: "claude" | "codex") => loginAiCli(provider)
    ),
    // 미트볼(...) 메뉴 액션 디스패치
    vscode.commands.registerCommand(
      "gitSimpleCompare.scmAction",
      (action: string) => runScmAction(deps, action)
    ),
    // Stash: 목록 새로고침 / 선택 파일 stash / apply·pop·drop·branch / 파일 보기
    vscode.commands.registerCommand("gitSimpleCompare.refreshStashes", () =>
      refreshStashes(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.loadStashFiles",
      (ref: string) => loadStashFilesForView(deps, ref)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.stashSelected",
      (paths?: string[]) => stashSelected(deps, paths)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.applyStash",
      (ref: string) => applyStash(deps, ref)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.popStash",
      (ref: string) => popStash(deps, ref)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.dropStash",
      (arg: { ref: string; message?: string }) =>
        dropStash(deps, arg?.ref, arg?.message)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.branchStash",
      (ref: string) => branchStash(deps, ref)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openStashFile",
      (arg: { ref: string; path: string }) => openStashFile(deps, arg)
    ),
    // 보기 상태: 트리/리스트 토글 및 정렬 변경
    vscode.commands.registerCommand("gitSimpleCompare.viewAsTree", () =>
      setViewMode(deps, "tree")
    ),
    vscode.commands.registerCommand("gitSimpleCompare.viewAsList", () =>
      setViewMode(deps, "list")
    ),
    // 섹션별 트리/리스트 토글(웹뷰 섹션 헤더 버튼이 호출하는 내부 명령)
    vscode.commands.registerCommand(
      "gitSimpleCompare.toggleSectionViewMode",
      (section: TreeSection) => toggleSectionViewMode(deps, section)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.changeSortOrder", () =>
      changeSortOrder(deps)
    ),
    // diff 창: 좌측(브랜치) 내용을 우측(작업파일)에 일괄 반영
    vscode.commands.registerCommand(
      "gitSimpleCompare.applyLeftToRight",
      () => applyLeftToRight()
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openDiffFileEditor",
      () => openDiffFileEditor()
    ),
    // editable diff 안에서 선택 라인 checkbox 토글과 stage/unstage 를 수행
    vscode.commands.registerCommand(
      "gitSimpleCompare.toggleSelectedLineCheckbox",
      () => toggleSelectedLineCheckboxes(deps)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.stageSelectedLines",
      () => stageEditorHunks(deps, "selection")
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.discardSelectedLines",
      () => discardEditorHunks(deps, "selection")
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.stageCurrentHunk",
      () => stageEditorHunks(deps, "currentHunk")
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.discardCurrentHunk",
      () => discardEditorHunks(deps, "currentHunk")
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.toggleHunkLineCheckbox",
      (uri: string, lineIds: string[]) => deps.hunkCheckboxes.toggle(uri, lineIds)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.stageCheckedLines", () =>
      deps.hunkCheckboxes.stageChecked()
    ),
    vscode.commands.registerCommand("gitSimpleCompare.unstageCheckedLines", () =>
      deps.hunkCheckboxes.unstageChecked()
    ),
    vscode.commands.registerCommand("gitSimpleCompare.clearCheckedLines", () =>
      deps.hunkCheckboxes.clearChecked()
    ),
    vscode.commands.registerCommand("gitSimpleCompare.chooseHunkControlMode", () =>
      deps.hunkCheckboxes.chooseMode()
    ),
    // git 그래프 웹뷰 열기
    vscode.commands.registerCommand("gitSimpleCompare.showGraph", () =>
      showGraph(deps)
    ),
    // 변경을 여러 커밋으로 분할
    vscode.commands.registerCommand(
      "gitSimpleCompare.splitCommits",
      (focus) => showSplitCommits(deps, focus)
    ),
    // 충돌 해결
    vscode.commands.registerCommand("gitSimpleCompare.refreshConflicts", () =>
      refreshConflicts(deps.conflicts)
    ),
    // worktree 목록/생성/삭제/명칭 변경
    vscode.commands.registerCommand("gitSimpleCompare.refreshWorktrees", () =>
      refreshWorktrees(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.openWorktree", (arg) =>
      openWorktree(arg)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.createWorktree", () =>
      createWorktree(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.removeWorktree", (arg) =>
      removeWorktree(deps, arg)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.renameWorktree", (arg) =>
      renameWorktree(deps, arg)
    ),
    // GitHub PR stack 목록/원격 parent 변경/새 child PR 생성
    vscode.commands.registerCommand("gitSimpleCompare.refreshPullRequestStacks", () =>
      refreshPullRequestStacks(deps)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.openStackPullRequest", (arg) =>
      openStackPullRequest(deps, arg)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.changeStackPullRequestBase",
      (arg) => changeStackPullRequestBase(deps, arg)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.createStackPullRequest", (arg) =>
      createStackPullRequest(deps, arg)
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
      "gitSimpleCompare.takeCurrent",
      (rel: string) => takeCurrent(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.takeIncoming",
      (rel: string) => takeIncoming(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.takeBoth",
      (rel: string) => takeBoth(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.markResolved",
      (rel: string) => markResolved(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openMergeEditor",
      (rel: string) => openMergeEditor(deps.conflicts, rel)
    ),
    vscode.commands.registerCommand(
      "gitSimpleCompare.openConflictEditor",
      (arg: string | { root?: string; path?: string }) =>
        typeof arg === "string"
          ? openConflictEditor(deps.conflicts, deps.conflictOverlay, arg)
          : openConflictEditor(
              deps.conflicts,
              deps.conflictOverlay,
              arg?.path ?? "",
              arg?.root
            )
    ),
    vscode.commands.registerCommand("gitSimpleCompare.continueOperation", () =>
      continueOperation(deps.conflicts)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.abortOperation", () =>
      abortOperation(deps.conflicts)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.skipOperation", () =>
      skipOperation(deps.conflicts)
    ),
    vscode.commands.registerCommand("gitSimpleCompare.rollbackPull", () =>
      rollbackPull(deps.conflicts)
    ),
  ];
}
