// hunk stage/discard 가 동작할 수 있는 VS Code diff 탭을 판별하는 공용 provider 유틸.
// - HEAD ↔ Working Tree 는 전체 작업파일 변경을 보여준다.
// - HEAD ↔ Unstaged 는 staged 변경을 제거한 가상 문서로 남은 변경만 보여준다.
import * as vscode from "vscode";
import { DiffStage } from "../git/diffHunkService";
import { refreshBranchContent } from "./branchContentProvider";
import { COMPARE_SCHEME, parseRefUri } from "../utils/uri";
import { logInfo } from "../ui/outputLog";

export interface ActiveHunkDiffTarget {
  original: vscode.Uri;
  modified: vscode.Uri;
  viewColumn?: number;
  repoRoot: string;
  relPath: string;
  baseRef: string;
  stage: DiffStage;
  virtualUnstaged: boolean;
}

/** 현재 문서가 active hunk 작업트리 diff 의 오른쪽 파일인지 확인한다. */
export function isActiveHunkWorkingDocument(uri: vscode.Uri): boolean {
  return activeHunkWorkingModifiedUri()?.toString() === uri.toString();
}

/** 현재 active tab 이 hunk 작업트리 diff 라면 오른쪽 파일 URI 를 반환한다. */
export function activeHunkWorkingModifiedUri(): vscode.Uri | undefined {
  return activeHunkDiffTarget()?.modified;
}

/** 현재 active tab 의 hunk diff 기준 ref 를 읽는다. */
export function activeHunkDiffBaseRef(): string | undefined {
  return activeHunkDiffTarget()?.baseRef;
}

/** 현재 active tab 의 hunk 대상 파일 정보를 읽는다. */
export function activeHunkDiffTarget(): ActiveHunkDiffTarget | undefined {
  return hunkDiffTargetFromTab(vscode.window.tabGroups.activeTabGroup.activeTab);
}

/** hunk stage UI 가 지원하는 왼쪽 기준 ref 인지 확인한다. */
export function isHunkDiffBaseRef(ref: string): boolean {
  return ref === "HEAD" || ref === ":0";
}

/** 현재 diff 탭의 index/unstaged 가상 문서만 갱신해 같은 탭에서 변경 반영을 유도한다. */
export function refreshHunkDiffDocuments(
  target = activeHunkDiffTarget()
): void {
  if (!target) {
    return;
  }
  const refreshed = [target.original, target.modified].filter(refreshDynamicRef);
  if (!refreshed.length) {
    return;
  }
  logInfo("hunk diff documents refreshed", {
    relPath: target.relPath,
    refs: refreshed.map((uri) => parseRefUri(uri).ref),
  });
}

/** 주어진 탭이 지원 가능한 hunk 작업트리 diff 인지 확인한다. */
export function isHunkDiffTab(tab: vscode.Tab | undefined): boolean {
  return !!activeHunkDiffInput(tab);
}

/** 주어진 탭이 지원 가능한 hunk diff 라면 대상 파일 정보를 반환한다. */
export function hunkDiffTargetFromTab(
  tab: vscode.Tab | undefined
): ActiveHunkDiffTarget | undefined {
  const input = activeHunkDiffInput(tab);
  return input ? targetFromInput(input) : undefined;
}

/** 지원 가능한 hunk 작업트리 diff 라면 diff input 을 반환한다. */
function activeHunkDiffInput(tab: vscode.Tab | undefined): vscode.TabInputTextDiff | undefined {
  const input = tab?.input;
  if (
    input instanceof vscode.TabInputTextDiff &&
    input.original.scheme === COMPARE_SCHEME &&
    isSupportedModifiedSide(input) &&
    isHunkDiffBaseRef(parseRefUri(input.original).ref)
  ) {
    return input;
  }
  return undefined;
}

/** diff 오른쪽이 실제 파일, 남은 unstaged, staged index 가상 문서인지 확인한다. */
function isSupportedModifiedSide(input: vscode.TabInputTextDiff): boolean {
  if (input.modified.scheme === "file") {
    return true;
  }
  if (input.modified.scheme !== COMPARE_SCHEME) {
    return false;
  }
  try {
    const ref = parseRefUri(input.modified).ref;
    return ref === ":unstaged" || ref === ":0";
  } catch {
    return false;
  }
}

/** diff input 에서 repo/path/ref 정보를 추출한다. */
function targetFromInput(input: vscode.TabInputTextDiff): ActiveHunkDiffTarget {
  const original = parseRefUri(input.original);
  if (input.modified.scheme === COMPARE_SCHEME) {
    const modified = parseRefUri(input.modified);
    return {
      original: input.original,
      modified: input.modified,
      repoRoot: modified.repoRoot || original.repoRoot,
      relPath: stripLeadingSlash(modified.path || original.path),
      baseRef: original.ref,
      stage: modified.ref === ":0" ? "staged" : "unstaged",
      virtualUnstaged: modified.ref === ":unstaged",
    };
  }
  return {
    original: input.original,
    modified: input.modified,
    repoRoot: original.repoRoot,
    relPath: stripLeadingSlash(original.path),
    baseRef: original.ref,
    stage: "unstaged",
    virtualUnstaged: false,
  };
}

/** URI path 의 선행 슬래시를 제거해 저장소 상대 경로로 만든다. */
function stripLeadingSlash(value: string): string {
  return value.replace(/^\//, "");
}

/** index/unstaged 처럼 git 상태에 따라 내용이 바뀌는 가상 문서만 갱신한다. */
function refreshDynamicRef(uri: vscode.Uri): boolean {
  if (uri.scheme !== COMPARE_SCHEME) {
    return false;
  }
  const ref = parseRefUri(uri).ref;
  if (ref !== ":0" && ref !== ":unstaged") {
    return false;
  }
  refreshBranchContent(uri);
  return true;
}
