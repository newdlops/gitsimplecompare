// PR preview에서 작업 파일을 바로 열고 unified patch의 변경 위치를 editor decoration으로 표시한다.
// - 웹뷰는 파일 경로만 요청하고, 신뢰할 patch 데이터와 실제 파일 열기는 extension host가 담당한다.
import * as path from "path";
import * as vscode from "vscode";
import type { PullRequestPreviewFile } from "../git/pullRequestPreviewFiles";
import { logError, logInfo, logWarn } from "./outputLog";

/** 추가된 현재 파일 줄을 1-based 닫힌 구간으로 압축한 값이다. */
export interface PullRequestQuickEditAddedRange {
  startLine: number;
  endLine: number;
}

/** 현재 파일에서 사라져 직접 가리킬 수 없는 삭제 줄과 가장 가까운 anchor를 나타낸다. */
export interface PullRequestQuickEditDeletedAnchor {
  line: number;
  count: number;
}

/** unified patch에서 editor decoration에 필요한 최소 위치 정보만 남긴 결과다. */
export interface PullRequestQuickEditChanges {
  addedRanges: PullRequestQuickEditAddedRange[];
  deletedAnchors: PullRequestQuickEditDeletedAnchor[];
}

/** visible editor가 다시 나타날 때 같은 decoration을 복원하기 위한 작은 활성 상태다. */
interface ActiveQuickEditTarget {
  uriKey: string;
  changes: PullRequestQuickEditChanges;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

let activeTarget: ActiveQuickEditTarget | undefined;
let addedDecoration: vscode.TextEditorDecorationType | undefined;
let deletedDecoration: vscode.TextEditorDecorationType | undefined;
let visibleEditorsListener: vscode.Disposable | undefined;

/**
 * PR preview의 신뢰된 파일 정보를 사용해 실제 작업 파일을 일반 editor로 연다.
 * @param repoRoot 현재 preview가 속한 저장소 루트
 * @param file host가 마지막 preview에서 찾은 파일과 patch 정보
 * @returns Quick Edit 대상과 decoration을 정상적으로 활성화했으면 true
 */
export async function openPullRequestQuickEdit(
  repoRoot: string,
  file: Pick<PullRequestPreviewFile, "path" | "status" | "patch">
): Promise<boolean> {
  const relativePath = safeRelativePath(repoRoot, file.path);
  if (!relativePath) {
    logWarn("PR preview quick edit skipped: unsafe path", {
      repoRoot,
      path: file.path,
    });
    await vscode.window.showWarningMessage(
      vscode.l10n.t("This review file cannot be opened for quick editing.")
    );
    return false;
  }
  if (file.status === "D") {
    logWarn("PR preview quick edit skipped: deleted file", {
      repoRoot,
      path: relativePath,
    });
    await vscode.window.showWarningMessage(
      vscode.l10n.t("Deleted files cannot be quick edited.")
    );
    return false;
  }

  const fileUri = vscode.Uri.file(path.join(repoRoot, relativePath));
  try {
    const document = await vscode.workspace.openTextDocument(fileUri);
    if (document.isDirty) {
      logWarn("PR preview quick edit skipped: document already has unsaved changes", {
        repoRoot,
        path: relativePath,
      });
      await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Save or discard the existing editor changes before using Quick Edit."
        )
      );
      return false;
    }
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
    const changes = parsePullRequestQuickEditPatch(file.patch);
    ensureDecorationResources();
    clearVisibleDecorations();
    activeTarget = { uriKey: document.uri.toString(), changes };
    applyQuickEditDecorations(editor, changes);
    revealFirstChange(editor, changes);
    logInfo("PR preview quick edit opened", {
      repoRoot,
      path: relativePath,
      addedRanges: changes.addedRanges.length,
      deletedAnchors: changes.deletedAnchors.length,
    });
    return true;
  } catch (error) {
    logError("PR preview quick edit open failed", error, {
      repoRoot,
      path: relativePath,
    });
    await vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Unable to open {0} for quick editing: {1}",
        relativePath,
        error instanceof Error ? error.message : String(error)
      )
    );
    return false;
  }
}

/**
 * unified patch를 현재(new) 파일 기준 추가 구간과 삭제 anchor로 파싱한다.
 * - 원문 patch를 보관하지 않고 연속 추가 줄을 즉시 압축해 큰 PR에서도 메모리를 작게 유지한다.
 * @param patch GitHub 또는 로컬 git diff가 제공한 unified patch
 * @returns editor에 적용할 1-based 변경 위치
 */
export function parsePullRequestQuickEditPatch(
  patch: string | undefined
): PullRequestQuickEditChanges {
  const changes: PullRequestQuickEditChanges = {
    addedRanges: [],
    deletedAnchors: [],
  };
  if (!patch) {
    return changes;
  }

  let inHunk = false;
  let newLine = 0;
  let deletedCount = 0;
  let deletedAnchor = 1;

  /** 연속 삭제 줄을 현재 new-side 위치 하나로 압축해 결과에 추가한다. */
  const flushDeleted = (): void => {
    if (deletedCount > 0) {
      changes.deletedAnchors.push({
        line: Math.max(1, deletedAnchor),
        count: deletedCount,
      });
      deletedCount = 0;
    }
  };

  for (const line of unifiedPatchLines(patch)) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      flushDeleted();
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      continue;
    }

    const marker = line[0];
    if (marker === "-") {
      if (deletedCount === 0) {
        deletedAnchor = newLine;
      }
      deletedCount++;
      continue;
    }

    flushDeleted();
    if (marker === "+") {
      appendAddedLine(changes.addedRanges, Math.max(1, newLine));
      newLine++;
      continue;
    }
    if (marker === " ") {
      newLine++;
      continue;
    }

    // 다음 파일 header나 잘린 patch metadata를 hunk 본문으로 오인하지 않는다.
    inHunk = false;
  }
  flushDeleted();
  return changes;
}

/**
 * patch 전체를 줄 배열로 복제하지 않고 한 줄씩 잘라 parser에 공급한다.
 * @param patch unified patch 원문
 * @returns 현재 순회 중인 한 줄만 보관하는 iterable
 */
function* unifiedPatchLines(patch: string): Generator<string> {
  let start = 0;
  while (start < patch.length) {
    const newline = patch.indexOf("\n", start);
    const end = newline < 0 ? patch.length : newline;
    const contentEnd = end > start && patch[end - 1] === "\r" ? end - 1 : end;
    yield patch.slice(start, contentEnd);
    if (newline < 0) {
      return;
    }
    start = newline + 1;
  }
}

/**
 * 연속된 추가 줄을 기존 마지막 구간에 합치고 떨어진 줄만 새 구간으로 만든다.
 * @param ranges 지금까지 압축한 1-based 추가 구간
 * @param line 새로 발견한 1-based 추가 줄
 */
function appendAddedLine(
  ranges: PullRequestQuickEditAddedRange[],
  line: number
): void {
  const previous = ranges[ranges.length - 1];
  if (previous && line === previous.endLine + 1) {
    previous.endLine = line;
    return;
  }
  ranges.push({ startLine: line, endLine: line });
}

/** editor theme와 함께 바뀌는 decoration type과 visible editor listener를 지연 생성한다. */
function ensureDecorationResources(): void {
  if (!addedDecoration) {
    addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      borderColor: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      borderStyle: "solid",
      borderWidth: "0 0 0 1px",
      overviewRulerColor: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }
  if (!deletedDecoration) {
    deletedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      borderStyle: "solid",
      borderWidth: "0 0 0 1px",
      overviewRulerColor: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }
  if (!visibleEditorsListener) {
    visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => {
      applyActiveTarget();
    });
  }
}

/**
 * 한 editor에 추가 줄 배경과 삭제 수 marker를 함께 적용한다.
 * @param editor 일반 작업 파일을 표시하는 editor
 * @param changes patch에서 파싱한 변경 위치
 */
function applyQuickEditDecorations(
  editor: vscode.TextEditor,
  changes: PullRequestQuickEditChanges
): void {
  if (!addedDecoration || !deletedDecoration) {
    return;
  }
  editor.setDecorations(
    addedDecoration,
    changes.addedRanges.map((range) =>
      toEditorRange(editor.document.lineCount, range.startLine, range.endLine)
    )
  );
  editor.setDecorations(
    deletedDecoration,
    changes.deletedAnchors.map((anchor) =>
      deletedAnchorDecoration(editor.document.lineCount, anchor)
    )
  );
}

/** 현재 활성 대상과 같은 URI가 다시 보이면 기존 변경 표시를 복원한다. */
function applyActiveTarget(): void {
  if (!activeTarget) {
    return;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === activeTarget.uriKey) {
      applyQuickEditDecorations(editor, activeTarget.changes);
    }
  }
}

/**
 * 삭제된 줄을 직접 선택할 수 없으므로 가장 가까운 현재 줄 앞 또는 파일 끝에 `−N` marker를 붙인다.
 * @param lineCount 현재 문서 줄 수
 * @param anchor patch new-side 기준 삭제 위치와 줄 수
 */
function deletedAnchorDecoration(
  lineCount: number,
  anchor: PullRequestQuickEditDeletedAnchor
): vscode.DecorationOptions {
  const afterFile = anchor.line > Math.max(1, lineCount);
  const range = toEditorRange(lineCount, anchor.line, anchor.line);
  const marker = `−${anchor.count}`;
  const attachment = {
    contentText: afterFile ? ` ${marker}` : `${marker} `,
    color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
    fontWeight: "600",
  };
  return {
    range,
    hoverMessage: new vscode.MarkdownString(
      vscode.l10n.t(
        "{0} removed line(s) in this reviewed change.",
        anchor.count
      )
    ),
    renderOptions: afterFile ? { after: attachment } : { before: attachment },
  };
}

/**
 * 1-based patch 줄 범위를 현재 문서 범위 안으로 제한해 VS Code Range로 바꾼다.
 * @param lineCount 현재 문서 줄 수
 * @param startLine 시작 줄(포함)
 * @param endLine 끝 줄(포함)
 */
function toEditorRange(
  lineCount: number,
  startLine: number,
  endLine: number
): vscode.Range {
  const lastLine = Math.max(0, lineCount - 1);
  const start = Math.min(lastLine, Math.max(0, startLine - 1));
  const end = Math.min(lastLine, Math.max(start, endLine - 1));
  return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
}

/** 새 quick edit를 열기 전에 보이는 editor에 남은 이전 decoration을 제거한다. */
function clearVisibleDecorations(): void {
  if (!addedDecoration || !deletedDecoration) {
    return;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(addedDecoration, []);
    editor.setDecorations(deletedDecoration, []);
  }
}

/**
 * 첫 변경 위치가 화면 밖이면 editor를 그 근처로 이동해 quick edit 진입점을 즉시 보여 준다.
 * @param editor 방금 연 작업 파일 editor
 * @param changes patch에서 파싱한 변경 위치
 */
function revealFirstChange(
  editor: vscode.TextEditor,
  changes: PullRequestQuickEditChanges
): void {
  const firstAdded = changes.addedRanges[0]?.startLine;
  const firstDeleted = changes.deletedAnchors[0]?.line;
  const candidates = [firstAdded, firstDeleted].filter(
    (line): line is number => typeof line === "number"
  );
  if (!candidates.length) {
    return;
  }
  const firstLine = Math.min(...candidates);
  editor.revealRange(
    toEditorRange(editor.document.lineCount, firstLine, firstLine),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/**
 * 저장소 밖으로 나가는 절대 경로와 `..` 경로를 거부하고 정규화된 상대 경로를 반환한다.
 * @param repoRoot preview 저장소 루트
 * @param value 웹뷰 메시지와 preview 파일에 들어 있던 경로
 */
function safeRelativePath(repoRoot: string, value: string): string | undefined {
  const candidate = String(value || "");
  if (!candidate || path.isAbsolute(candidate)) {
    return undefined;
  }
  const normalized = path.normalize(candidate);
  if (normalized.split(path.sep).includes("..")) {
    return undefined;
  }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, normalized);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  return normalized;
}

/** 확장 비활성화 시 quick edit decoration과 listener를 모두 해제한다. */
export function disposePullRequestQuickEdit(): void {
  clearVisibleDecorations();
  activeTarget = undefined;
  addedDecoration?.dispose();
  deletedDecoration?.dispose();
  visibleEditorsListener?.dispose();
  addedDecoration = undefined;
  deletedDecoration = undefined;
  visibleEditorsListener = undefined;
}
