// editable diff 에디터에서 선택 범위의 checkbox 토글과 stage/unstage 를 수행하는 명령.
// - VS Code diff 의 오른쪽 Working Tree 문서는 그대로 편집 가능하게 두고,
//   커서/선택 라인을 DiffHunkService 의 hunk 선택으로 변환해 기존 부분 적용 경로를 재사용한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { buildWorkingContentWithoutStagedView } from "../git/unstagedView";
import {
  DiffStage,
  DiffFile,
  DiffHunk,
  DiffHunkService,
  HunkSelection,
} from "../git/diffHunkService";
import {
  activeHunkDiffTarget,
  activeHunkWorkingModifiedUri,
  refreshHunkDiffDocuments,
} from "../providers/hunkDiffContext";
import { recentHunkContextLine } from "../providers/hunkContextLineStore";
import { checkboxLines } from "../providers/hunkCheckboxLines";
import { checkboxLinesForDisplayedDiff } from "../providers/hunkVisibleLineMap";
import type { ActiveHunkDiffTarget } from "../providers/hunkDiffContext";
import { logInfo } from "../ui/outputLog";
import { CommandDeps } from "./shared";

interface LineRange {
  start: number;
  end: number;
}

type HunkEditMode = "selection" | "currentHunk";
type HunkEditAction = "stage" | "unstage" | "discard";
type DiffSide = "original" | "modified";

interface HunkContext {
  editor: vscode.TextEditor;
  service: DiffHunkService;
  file: DiffFile;
  side: DiffSide;
  target?: ActiveHunkDiffTarget;
}

interface HunkEditorContext {
  editor: vscode.TextEditor;
  side: DiffSide;
  target?: ActiveHunkDiffTarget;
}

/**
 * editable diff 의 선택 라인 또는 현재 hunk 를 index 방향으로 적용한다.
 * - unstaged diff 에서는 stage, staged diff 에서는 unstage 로 동작해 메뉴를 단순하게 유지한다.
 * @param deps 공유 의존성
 * @param mode 선택 라인 기준인지 현재 hunk 기준인지
 */
export async function stageEditorHunks(
  deps: CommandDeps,
  mode: HunkEditMode
): Promise<void> {
  const action = activeHunkDiffTarget()?.stage === "staged" ? "unstage" : "stage";
  await applyEditorHunkAction(deps, mode, action);
}

/**
 * editable diff 의 선택 라인 또는 현재 hunk 를 작업트리에서 되돌린다.
 * @param deps 공유 의존성
 * @param mode 선택 라인 기준인지 현재 hunk 기준인지
 */
export async function discardEditorHunks(
  deps: CommandDeps,
  mode: HunkEditMode
): Promise<void> {
  await applyEditorHunkAction(deps, mode, "discard");
}

/**
 * editable diff 에서 현재 선택 라인의 checkbox 선택 상태를 토글한다.
 * - 사용자가 실행한 diff side 의 선택 변경 라인을 hunk line id 로 변환한 뒤,
 *   선택 라인이 모두 체크된 상태면 해제하고 하나라도 미체크면 모두 체크한다.
 * @param deps 공유 의존성
 */
export async function toggleSelectedLineCheckboxes(
  deps: CommandDeps
): Promise<void> {
  const context = await resolveHunkContext(deps);
  if (!context) {
    return;
  }
  const uri = activeHunkWorkingModifiedUri();
  const ranges = selectionRanges(context.editor.selections);
  const selection = hasExplicitSelection(context.editor)
    ? await selectionForRanges(deps, context, ranges)
    : undefined;
  if (uri && selection?.lineIds?.length) {
    deps.hunkCheckboxes.toggle(uri.toString(), selection.lineIds, undefined, context.side);
    deps.hunkCheckboxes.renderCheckedState();
    logInfo("selected hunk line checkbox toggled", {
      path: context.file.path,
      stage: context.file.stage,
      side: context.side,
      lineIds: selection.lineIds.length,
    });
    return;
  }
  const contextLine = uri ? recentHunkContextLine(uri.toString()) : undefined;
  if (uri && contextLine && !hasExplicitSelection(context.editor)) {
    await deps.hunkCheckboxes.toggleVisible(
      uri.toString(),
      {
        side: contextLine.side,
        line: contextLine.line,
        column: contextLine.column,
        marker: contextLine.marker,
        text: contextLine.text,
      },
      undefined,
      contextLine.lineIds
    );
    deps.hunkCheckboxes.renderCheckedState();
    logInfo("context hunk line checkbox toggled", {
      path: context.file.path,
      stage: context.file.stage,
      side: contextLine.side,
      line: contextLine.line,
      lineIds: contextLine.lineIds.length,
    });
    return;
  }
  if (!uri || !selection?.lineIds?.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No changed lines found in the current selection.")
    );
    return;
  }
}

/**
 * 에디터 상태를 hunk 선택으로 바꾼 뒤 stage/unstage/discard 를 실행한다.
 * @param deps 공유 의존성
 * @param mode 선택 라인/현재 hunk 모드
 * @param action stage/unstage/discard 중 적용할 동작
 */
async function applyEditorHunkAction(
  deps: CommandDeps,
  mode: HunkEditMode,
  action: HunkEditAction
): Promise<void> {
  if (action === "stage" && deps.hunkCheckboxes.hasCheckedForActiveDiff()) {
    logInfo("editor hunk stage redirected to checked lines", { mode });
    const staged = await deps.hunkCheckboxes.stageChecked(false);
    if (staged) {
      return;
    }
    logInfo("editor hunk stage fallback to editor selection", { mode });
  }
  if (action === "unstage" && deps.hunkCheckboxes.hasCheckedForActiveDiff()) {
    logInfo("editor hunk unstage redirected to checked lines", { mode });
    const unstaged = await deps.hunkCheckboxes.unstageChecked(false);
    if (unstaged) {
      return;
    }
    logInfo("editor hunk unstage fallback to editor selection", { mode });
  }
  const expectedStage = action === "unstage" ? "staged" : "unstaged";
  const context = await resolveHunkContext(deps, expectedStage);
  if (!context) {
    return;
  }
  const activeTarget = activeHunkDiffTarget();
  const selection = await selectionForMode(deps, context, mode);
  if (!selection) {
    vscode.window.showWarningMessage(
      mode === "currentHunk"
        ? vscode.l10n.t("No hunk found at the cursor.")
        : vscode.l10n.t("No changed lines found in the current selection.")
    );
    return;
  }
  if (action === "discard") {
    const choice = await vscode.window.showWarningMessage(
      mode === "currentHunk"
        ? vscode.l10n.t("Discard current hunk? This is irreversible.")
        : vscode.l10n.t("Discard selected line(s)? This is irreversible."),
      { modal: true },
      vscode.l10n.t("Discard Changes")
    );
    if (!choice) {
      return;
    }
  }

  logInfo("editor hunk action requested", {
    action,
    mode,
    path: context.file.path,
    hunkIds: selection.hunkIds.length,
    lineIds: selection.lineIds?.length ?? 0,
  });
  try {
    if (action === "stage") {
      await context.service.stageSelections([context.file], [selection]);
      vscode.window.showInformationMessage(
        mode === "currentHunk"
          ? vscode.l10n.t("Current hunk staged.")
          : vscode.l10n.t("Selected line(s) staged.")
      );
    } else if (action === "unstage") {
      await context.service.unstageSelections([context.file], [selection]);
      vscode.window.showInformationMessage(
        mode === "currentHunk"
          ? vscode.l10n.t("Current hunk unstaged.")
          : vscode.l10n.t("Selected line(s) unstaged.")
      );
    } else {
      await context.service.discardSelections([context.file], [selection]);
      vscode.window.showInformationMessage(
        mode === "currentHunk"
          ? vscode.l10n.t("Current hunk discarded.")
          : vscode.l10n.t("Selected line(s) discarded.")
      );
    }
    refreshHunkDiffDocuments(activeTarget);
    deps.hunkCheckboxes.refresh();
    await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: `editorHunks:${action}`,
    });
    logInfo("editor hunk diff reopen deferred", {
      action,
      path: context.file.path,
      reason: "preserve-active-diff-context",
    });
  } catch (error) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Action failed: {0}",
        error instanceof Error ? error.message : String(error)
      )
    );
  }
}

/**
 * 현재 active diff 의 오른쪽 Working Tree 에디터와 해당 파일의 unstaged diff 를 찾는다.
 * @param deps 공유 의존성
 */
async function resolveHunkContext(
  deps: CommandDeps,
  expectedStage?: DiffStage
): Promise<HunkContext | undefined> {
  const hunkEditor = findHunkEditor();
  if (!hunkEditor) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Place the cursor in a changed side of the diff.")
    );
    return undefined;
  }
  const { editor, side, target } = hunkEditor;
  if (editor.document.isDirty && editor.document.uri.scheme === "file") {
    const saved = await editor.document.save();
    if (!saved) {
      return undefined;
    }
  }
  const activeTarget = target ?? activeHunkDiffTarget();
  if (
    expectedStage &&
    activeTarget &&
    (activeTarget.modified.toString() === editor.document.uri.toString() ||
      activeTarget.original.toString() === editor.document.uri.toString()) &&
    activeTarget.stage !== expectedStage
  ) {
    vscode.window.showWarningMessage(
      expectedStage === "staged"
        ? vscode.l10n.t("Open a staged diff to unstage selected lines.")
        : vscode.l10n.t("Open an unstaged diff to stage selected lines.")
    );
    return undefined;
  }
  const resolvedTarget =
    activeTarget &&
    (activeTarget.modified.toString() === editor.document.uri.toString() ||
      activeTarget.original.toString() === editor.document.uri.toString())
      ? {
          repoRoot: activeTarget.repoRoot,
          relPath: activeTarget.relPath,
        }
      : await resolveFileTarget(deps, editor.document.uri);
  if (!resolvedTarget) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("This file is not inside a git repository.")
    );
    return undefined;
  }
  const service = new DiffHunkService(resolvedTarget.repoRoot);
  const files = await service.getWorkingDiff();
  const editorMatchesActiveTarget =
    activeTarget &&
    (activeTarget.modified.toString() === editor.document.uri.toString() ||
      activeTarget.original.toString() === editor.document.uri.toString());
  const stage =
    expectedStage ??
    (editorMatchesActiveTarget
      ? activeTarget.stage
      : "unstaged");
  const file = files.find(
    (item) => item.stage === stage && item.path === resolvedTarget.relPath
  );
  if (!file || file.binary) {
    vscode.window.showWarningMessage(
      stage === "staged"
        ? vscode.l10n.t("No staged changes found for this file.")
        : vscode.l10n.t("No unstaged changes found for this file.")
    );
    return undefined;
  }
  return { editor, service, file, side, target: activeTarget };
}

/**
 * 실제 file URI 에서 저장소 루트와 상대 경로를 찾는다.
 * @param deps 공유 의존성
 * @param uri 작업트리 파일 URI
 */
async function resolveFileTarget(
  deps: CommandDeps,
  uri: vscode.Uri
): Promise<{ repoRoot: string; relPath: string } | undefined> {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const gitService = await deps.registry.resolve(path.dirname(uri.fsPath));
  if (!gitService) {
    return undefined;
  }
  const relPath = relativeRepoPath(gitService.repoRoot, uri.fsPath);
  return relPath ? { repoRoot: gitService.repoRoot, relPath } : undefined;
}

/**
 * active hunk diff 에서 사용자가 실제로 조작한 editor side 를 찾는다.
 * - 좌측(original)에서 context menu 를 실행하면 삭제 라인 checkbox 를 선택해야 하므로,
 *   항상 오른쪽 editor 로 보정하지 않고 active editor 의 URI 를 먼저 확인한다.
 */
function findHunkEditor(): HunkEditorContext | undefined {
  const target = activeHunkDiffTarget();
  const active = vscode.window.activeTextEditor;
  if (target) {
    if (active?.document.uri.toString() === target.modified.toString()) {
      return { editor: active, side: "modified", target };
    }
    if (active?.document.uri.toString() === target.original.toString()) {
      return { editor: active, side: "original", target };
    }
    const modified = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === target.modified.toString()
    );
    if (modified) {
      return { editor: modified, side: "modified", target };
    }
    const original = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === target.original.toString()
    );
    return original ? { editor: original, side: "original", target } : undefined;
  }

  const modified = activeHunkWorkingModifiedUri();
  if (!modified) {
    return undefined;
  }
  if (active?.document.uri.toString() === modified.toString()) {
    return { editor: active, side: "modified" };
  }
  const editor = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === modified.toString()
  );
  return editor ? { editor, side: "modified" } : undefined;
}

/**
 * 절대 경로를 저장소 상대 경로로 변환한다.
 * @param repoRoot 저장소 루트
 * @param fsPath 파일 절대 경로
 */
function relativeRepoPath(repoRoot: string, fsPath: string): string | undefined {
  const rel = path.relative(repoRoot, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

/** 모드에 맞는 HunkSelection 을 만든다. */
async function selectionForMode(
  deps: CommandDeps,
  context: HunkContext,
  mode: HunkEditMode
): Promise<HunkSelection | undefined> {
  if (mode === "currentHunk") {
    return selectionForCurrentHunk(
      context.file,
      context.editor.selection.active.line + 1,
      context.side
    );
  }
  return selectionForRanges(
    deps,
    context,
    selectionRanges(context.editor.selections)
  );
}

/** VS Code selection 을 1-based line range 배열로 변환한다. */
function selectionRanges(selections: readonly vscode.Selection[]): LineRange[] {
  return selections.map((selection) => {
    const start = selection.start.line + 1;
    const end =
      !selection.isEmpty && selection.end.character === 0
        ? Math.max(start, selection.end.line)
        : selection.end.line + 1;
    return { start, end };
  });
}

/** 사용자가 실제 범위를 선택했는지 확인한다. */
function hasExplicitSelection(editor: vscode.TextEditor): boolean {
  return editor.selections.some((selection) => !selection.isEmpty);
}

/** 선택 범위에 걸친 표시 diff 변경 라인만 HunkSelection 으로 만든다. */
async function selectionForRanges(
  deps: CommandDeps,
  context: HunkContext,
  ranges: LineRange[]
): Promise<HunkSelection | undefined> {
  const displayLines = await displayedCheckboxLines(deps, context);
  const lineIds = displayLines
    .filter(
      (item) =>
        item.side === context.side &&
        ranges.some((range) => rangeContains(range, item.line))
    )
    .flatMap((item) => item.lineIds);
  if (!lineIds.length) {
    return undefined;
  }
  return {
    stage: context.file.stage,
    path: context.file.path,
    hunkIds: [],
    lineIds,
    binary: false,
  };
}

/** 선택 range 안에 line 이 들어오는지 확인한다. */
function rangeContains(range: LineRange, line: number): boolean {
  return line >= range.start && line <= range.end;
}

/** 커서가 들어있는 hunk 전체를 HunkSelection 으로 만든다. */
function selectionForCurrentHunk(
  file: DiffFile,
  line: number,
  side: DiffSide
): HunkSelection | undefined {
  const hunk = file.hunks.find((item) => hunkContainsLine(item, line, side));
  if (!hunk) {
    return undefined;
  }
  return {
    stage: file.stage,
    path: file.path,
    hunkIds: [hunk.id],
    lineIds: [],
    binary: false,
  };
}

/**
 * 화면에 실제로 표시되는 checkbox line 을 반환한다.
 * - :unstaged 가상 문서는 git diff 좌표와 표시 문서 좌표가 달라질 수 있으므로,
 *   overlay 와 같은 visible-line mapping 을 사용해 사용자가 선택한 줄만 line id 로 바꾼다.
 */
async function displayedCheckboxLines(
  deps: CommandDeps,
  context: HunkContext
) {
  if (!context.target) {
    return checkboxLines(context.file);
  }
  const [leftText, rightText] = await Promise.all([
    documentText(context.target.original),
    documentText(context.target.modified),
  ]);
  const view =
    context.target.virtualUnstaged && context.file.stage === "unstaged"
      ? await virtualUnstagedView(deps, context)
      : undefined;
  return checkboxLinesForDisplayedDiff(context.file, leftText, rightText, {
    virtualUnstagedView: view,
  }).lines;
}

/** VS Code 에 열린 문서 텍스트를 읽고, 없으면 URI 로 문서를 연다. */
async function documentText(uri: vscode.Uri): Promise<string> {
  const opened = vscode.workspace.textDocuments.find(
    (item) => item.uri.toString() === uri.toString()
  );
  return (opened ?? (await vscode.workspace.openTextDocument(uri))).getText();
}

/** :unstaged 가상 문서의 표시 좌표를 만들기 위한 staged 제거 view 를 만든다. */
async function virtualUnstagedView(
  deps: CommandDeps,
  context: HunkContext
) {
  const gitService = deps.registry.get(context.service.repoRoot);
  const [head, index, working] = await Promise.all([
    gitService.getFileContentAtRef("HEAD", context.file.path),
    gitService.getFileContentAtRef(":0", context.file.path),
    context.service.readWorkingFile(context.file.path).catch(() => ""),
  ]);
  return buildWorkingContentWithoutStagedView(head, index, working);
}

/** 커서 라인이 hunk 의 선택 side 범위 안에 있는지 확인한다. */
function hunkContainsLine(hunk: DiffHunk, line: number, side: DiffSide): boolean {
  const parsed = parseHunkHeader(hunk);
  if (!parsed) {
    return false;
  }
  const start = side === "original" ? parsed.oldStart : parsed.newStart;
  const count = side === "original" ? parsed.oldCount : parsed.newCount;
  const end = count > 0 ? start + count - 1 : start;
  return line >= start && line <= end;
}

/** hunk header 에서 old/new 시작 줄과 길이를 읽는다. */
function parseHunkHeader(
  hunk: DiffHunk
):
  | { oldStart: number; oldCount: number; newStart: number; newCount: number }
  | undefined {
  const header = hunk.text.split("\n", 1)[0] ?? "";
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}
