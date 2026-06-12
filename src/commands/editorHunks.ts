// editable diff 에디터에서 선택 범위/현재 hunk 를 바로 stage/discard 하는 명령.
// - VS Code diff 의 오른쪽 Working Tree 문서는 그대로 편집 가능하게 두고,
//   커서/선택 라인을 DiffHunkService 의 hunk 선택으로 변환해 기존 부분 적용 경로를 재사용한다.
import * as path from "node:path";
import * as vscode from "vscode";
import {
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
import { logInfo } from "../ui/outputLog";
import { CommandDeps } from "./shared";

interface LineRange {
  start: number;
  end: number;
}

type HunkEditMode = "selection" | "currentHunk";
type HunkEditAction = "stage" | "discard";

interface HunkContext {
  editor: vscode.TextEditor;
  service: DiffHunkService;
  file: DiffFile;
}

/**
 * editable diff 의 선택 라인 또는 현재 hunk 를 stage 한다.
 * @param deps 공유 의존성
 * @param mode 선택 라인 기준인지 현재 hunk 기준인지
 */
export async function stageEditorHunks(
  deps: CommandDeps,
  mode: HunkEditMode
): Promise<void> {
  await applyEditorHunkAction(deps, mode, "stage");
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
 * 에디터 상태를 hunk 선택으로 바꾼 뒤 stage/discard 를 실행한다.
 * @param deps 공유 의존성
 * @param mode 선택 라인/현재 hunk 모드
 * @param action stage 또는 discard
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

  const context = await resolveHunkContext(deps);
  if (!context) {
    return;
  }
  const activeTarget = activeHunkDiffTarget();
  const selection = selectionForMode(context.editor, context.file, mode);
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
    } else {
      await context.service.discardSelections([context.file], [selection]);
      vscode.window.showInformationMessage(
        mode === "currentHunk"
          ? vscode.l10n.t("Current hunk discarded.")
          : vscode.l10n.t("Selected line(s) discarded.")
      );
    }
    refreshHunkDiffDocuments(activeTarget);
    await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: `editorHunks:${action}`,
    });
    deps.hunkCheckboxes.refresh();
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
  deps: CommandDeps
): Promise<HunkContext | undefined> {
  const editor = findWorkingTreeEditor();
  if (!editor) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Place the cursor in the Working Tree side of the diff.")
    );
    return undefined;
  }
  if (editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      return undefined;
    }
  }
  const activeTarget = activeHunkDiffTarget();
  if (
    activeTarget &&
    activeTarget.modified.toString() === editor.document.uri.toString() &&
    activeTarget.stage !== "unstaged"
  ) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Open an unstaged diff to stage or discard selected lines.")
    );
    return undefined;
  }
  const resolvedTarget =
    activeTarget &&
    activeTarget.modified.toString() === editor.document.uri.toString()
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
  const file = files.find(
    (item) => item.stage === "unstaged" && item.path === resolvedTarget.relPath
  );
  if (!file || file.binary) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No unstaged changes found for this file.")
    );
    return undefined;
  }
  return { editor, service, file };
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

/** active diff 의 modified(Working Tree) 쪽 TextEditor 를 찾는다. */
function findWorkingTreeEditor(): vscode.TextEditor | undefined {
  const modified = activeHunkWorkingModifiedUri();
  const active = vscode.window.activeTextEditor;
  if (!modified) {
    return undefined;
  }
  if (active?.document.uri.toString() === modified.toString()) {
    return active;
  }
  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === modified.toString()
  );
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
function selectionForMode(
  editor: vscode.TextEditor,
  file: DiffFile,
  mode: HunkEditMode
): HunkSelection | undefined {
  if (mode === "currentHunk") {
    return selectionForCurrentHunk(file, editor.selection.active.line + 1);
  }
  return selectionForRanges(file, selectionRanges(editor.selections));
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

/** 선택 범위에 걸친 변경 라인을 HunkSelection 으로 만든다. */
function selectionForRanges(
  file: DiffFile,
  ranges: LineRange[]
): HunkSelection | undefined {
  const lineIds = file.hunks.flatMap((hunk) => lineIdsForRanges(hunk, ranges));
  if (!lineIds.length) {
    return undefined;
  }
  return {
    stage: file.stage,
    path: file.path,
    hunkIds: [],
    lineIds,
    binary: false,
  };
}

/** 커서가 들어있는 hunk 전체를 HunkSelection 으로 만든다. */
function selectionForCurrentHunk(
  file: DiffFile,
  line: number
): HunkSelection | undefined {
  const hunk = file.hunks.find((item) => hunkContainsNewLine(item, line));
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

/** 선택 범위와 겹치는 hunk 내부 변경 line id 를 반환한다. */
function lineIdsForRanges(hunk: DiffHunk, ranges: LineRange[]): string[] {
  const [, ...body] = hunk.text.split("\n");
  const parsed = parseHunkHeader(hunk);
  if (!parsed) {
    return [];
  }
  const ids: string[] = [];
  let index = 0;
  let oldNo = parsed.oldStart;
  let newNo = parsed.newStart;
  while (index < body.length) {
    const line = body[index];
    if (line.startsWith("-") || line.startsWith("+")) {
      const deletions: number[] = [];
      const additions: { index: number; line: number }[] = [];
      while (index < body.length && body[index].startsWith("-")) {
        deletions.push(index);
        oldNo++;
        index++;
      }
      while (index < body.length && body[index].startsWith("+")) {
        additions.push({ index, line: newNo++ });
        index++;
      }
      const selectedAdds = additions.filter((item) =>
        ranges.some((range) => item.line >= range.start && item.line <= range.end)
      );
      if (selectedAdds.length && deletions.length) {
        ids.push(
          ...deletions.map((lineIndex) => lineId(hunk, lineIndex)),
          ...additions.map((item) => lineId(hunk, item.index))
        );
      } else {
        ids.push(...selectedAdds.map((item) => lineId(hunk, item.index)));
      }
      continue;
    }
    if (!line.startsWith("\\")) {
      oldNo++;
      newNo++;
    }
    index++;
  }
  return ids;
}

/** 커서 라인이 hunk 의 변경 후(new) 범위 안에 있는지 확인한다. */
function hunkContainsNewLine(hunk: DiffHunk, line: number): boolean {
  const parsed = parseHunkHeader(hunk);
  if (!parsed) {
    return false;
  }
  const end =
    parsed.newCount > 0
      ? parsed.newStart + parsed.newCount - 1
      : parsed.newStart;
  return line >= parsed.newStart && line <= end;
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

/** DiffHunkService 와 동일한 hunk line id 규칙을 사용한다. */
function lineId(hunk: DiffHunk, index: number): string {
  return `${hunk.id}:${index}`;
}
