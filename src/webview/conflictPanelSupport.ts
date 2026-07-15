// conflict panel의 순수 fingerprint/protocol 판정과 host-side i18n/HTML 보조 함수를 모은다.
// - 패널 생애주기에서 분리해 문서 전환 로직이 비대해지지 않게 하고 웹뷰 문자열의 단일 출처를 유지한다.
import * as vscode from "vscode";
import type { ConflictDocument } from "../git/conflictService";
import { instantTooltipResources } from "./instantTooltipResources";

const LOCALIZED_CONFLICT_ERRORS = new Set([
  "Accept Both requires two text conflict sides.",
  "Accept Both requires a text working-tree Result.",
  "Accept Both requires complete conflict marker blocks.",
  "Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.",
  "Conflict path must stay inside the repository.",
  "This file is no longer conflicted. Reload the conflict editor.",
  "The conflict sources changed outside this editor. Reload it before resolving.",
  "The conflict Result changed outside this editor. Reload it before resolving.",
  "Another Git process is updating the index. Try the conflict action again.",
  "The Git index lock changed during conflict resolution. The index was not published.",
  "Conflict path parent contains a symbolic link.",
]);
const RECOVERY_ERROR_PREFIX = "The conflict file changed again. Recovery files were preserved at ";
const UNSUPPORTED_MODE_PREFIX = "Unsupported conflict stage mode: ";

/** 알려진 content safety 오류는 지역화하고 예상하지 못한 Git 오류는 원문 진단을 보존한다. */
export function localizeConflictActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(RECOVERY_ERROR_PREFIX)) {
    return vscode.l10n.t(
      "The conflict file changed again. Recovery files were preserved at {0}",
      message.slice(RECOVERY_ERROR_PREFIX.length)
    );
  }
  if (message.startsWith(UNSUPPORTED_MODE_PREFIX)) {
    return vscode.l10n.t(
      "Unsupported conflict stage mode: {0}",
      message.slice(UNSUPPORTED_MODE_PREFIX.length)
    );
  }
  return LOCALIZED_CONFLICT_ERRORS.has(message) ? vscode.l10n.t(message) : message;
}

/**
 * 미저장 Result가 같은 index stage snapshot에서 작성됐는지 확인할 source fingerprint를 만든다.
 * @param document stage 1/2/3 mode와 OID의 opaque version을 포함한 충돌 문서
 * @returns source가 바뀌면 달라지는 안정적인 JSON 문자열
 */
export function conflictSourceSignature(document: ConflictDocument): string {
  return document.sourceVersion;
}

/** 파일/인덱스 상태를 바꾸거나 외부 편집기로 전환하는 메시지인지 판별한다. */
export function isConflictPanelSerializedMessage(message: { type: string }): boolean {
  return [
    "saveResult",
    "resolveMarked",
    "acceptCurrent",
    "acceptIncoming",
    "acceptBoth",
    "openNative",
    "reload",
    "ready",
  ].includes(message.type);
}

/** 작업트리/index를 실제로 바꾸므로 저장소 공용 lease가 필요한 메시지인지 판별한다. */
export function isConflictPanelGitMutation(message: { type: string }): boolean {
  return [
    "saveResult",
    "resolveMarked",
    "acceptCurrent",
    "acceptIncoming",
    "acceptBoth",
  ].includes(message.type);
}

/**
 * conflict webview의 모든 사용자 노출 문자열을 현재 VS Code 언어로 만든다.
 * @returns conflict.js key와 일치하는 지역화 문자열 map
 */
export function conflictPanelI18n() {
  const t = vscode.l10n.t;
  return {
    resolveConflict: t("Resolve Conflict"),
    nativeEditor: t("Native Merge Editor"),
    nativeEditorTooltip: t("Open this conflict in VS Code's native merge editor"),
    useCurrent: t("Use Current"),
    useCurrentTooltip: t("Replace the whole Result with exact Current (index stage 2) and mark resolved"),
    useIncoming: t("Use Incoming"),
    useIncomingTooltip: t("Replace the whole Result with exact Incoming (index stage 3) and mark resolved"),
    useBoth: t("Use Both"),
    useBothTooltip: t("Replace the whole Result by combining Current then Incoming conflict blocks and mark resolved"),
    saveResult: t("Save Result"),
    saveResultTooltip: t("Save Result without marking this file resolved"),
    resolveMarked: t("Resolve Marked"),
    resolveMarkedTooltip: t("Save Result and stage the file as resolved"),
    current: t("Current"),
    incoming: t("Incoming"),
    result: t("Result"),
    proposedResult: t("Proposed Result"),
    base: t("Base"),
    currentContent: t("Current content"),
    incomingContent: t("Incoming content"),
    resultContent: t("Editable Result content"),
    baseContent: t("Base content"),
    workingTree: t("working tree"),
    accumulatedResult: t("Accumulated result"),
    commitBeingReplayed: t("Commit being replayed"),
    mergeTargetDuringRebase: t("Merge target inside rebase"),
    cherryPickTargetDuringRebase: t("Cherry-picked commit inside rebase"),
    revertSideDuringRebase: t("Reverse side inside rebase"),
    nestedSourceDuringRebase: t("Active nested operation inside rebase"),
    resultAfterStep: t("Result after this step"),
    currentBranchVersion: t("Current branch before the operation"),
    mergeTargetVersion: t("Version from the commit being merged"),
    cherryPickTargetVersion: t("Version from the commit being cherry-picked"),
    revertReverseVersion: t("Reverse side derived from the commit being reverted"),
    genericCurrentVersion: t("Index stage 2 (Ours)"),
    genericIncomingVersion: t("Index stage 3 (Theirs)"),
    rebaseCurrentDetail: t("Whole-file choice: replaces Result with the accumulated rebase-side file and discards all Result edits plus this step's Incoming changes in this file."),
    rebaseIncomingDetail: t("Whole-file choice: replaces Result with the entire file from the original commit being replayed and may discard accumulated or manual Result changes in this file."),
    rebaseNestedIncomingDetail: t("Stage 3 comes from a nested merge, cherry-pick, or revert inside rebase. Choosing it replaces the whole Result with this side."),
    mergeCurrentDetail: t("Content on HEAD before the merge result is recorded."),
    mergeIncomingDetail: t("Content from the merge target commit."),
    cherryCurrentDetail: t("Content on HEAD before the selected commit is applied."),
    cherryIncomingDetail: t("Content from the commit currently being cherry-picked."),
    revertCurrentDetail: t("Content on HEAD before the reverse patch is recorded."),
    revertIncomingDetail: t("Reverse side of the reverted change; it is not the REVERT_HEAD snapshot itself."),
    genericCurrentDetail: t("Current/Ours content stored in index stage 2."),
    genericIncomingDetail: t("Incoming/Theirs content stored in index stage 3."),
    branchResult: t("Branch result"),
    rebaseResultDetail: t("Continue records this Result in the rewritten version of the current todo commit."),
    rebaseNestedResultDetail: t("Resolve the active nested operation with this working-tree Result; rebase continues afterward and later steps may still change it."),
    mergeResultDetail: t("Continuing the merge records this Result in the merge commit."),
    cherryResultDetail: t("Continuing records this Result in the new cherry-pick commit."),
    revertResultDetail: t("Continuing records this Result in the new revert commit."),
    genericResultDetail: t("This working-tree Result is staged when you mark the file resolved."),
    stepOf: t("Step {0} of {1}"),
    remainingSteps: t("{0} later commit(s)"),
    futurePathChanges: t("{0} later commit(s) touch this file and may change or conflict with it"),
    noFuturePathChanges: t("No later todo commit changes this path"),
    futurePathAnalysisUnavailable: t("Later path changes could not be determined safely"),
    moreFutureChanges: t("+{0} more"),
    expectedFinalTitle: t("Expected to remain in the final branch"),
    expectedFinalDetail: t("No remaining todo commit changes this path. Based on the current todo, this Result should remain when rebase finishes."),
    changedLaterTitle: t("Later commits still touch this file"),
    changedLaterDetail: t("Later todo commits touch this path after Continue. They may change the Result, become empty, or conflict again."),
    uncertainFinalTitle: t("Final file content cannot be predicted safely"),
    uncertainFinalDetail: t("The current edit/complex step, remaining exec steps, hooks, or path rewrites may change this file after Continue."),
    originalTip: t("Original tip"),
    ontoBase: t("New base"),
    fileLastChangedBy: t("This file was last changed by {0} {1}"),
    deletedOrAbsent: t("Deleted / absent on this side"),
    binaryContent: t("Binary content cannot be shown as text"),
    submoduleContent: t("Submodule entry {0}"),
    submoduleWorkingTree: t("Submodule working tree"),
    nonFileContent: t("Directory or unsupported non-regular working-tree entry"),
    symlinkContent: t("Symbolic link target: {0}"),
    truncatedContent: t("Large content is truncated for display; use the native editor or accept an exact side"),
    emptyFile: t("Empty file"),
    showBase: t("Show Base (index stage 1)"),
    baseDetailRebase: t("The original parent snapshot used as the starting point for the replayed commit's patch."),
    baseDetailGeneric: t("The common/original snapshot stored in index stage 1."),
    block: t("Block {0}"),
    noConflictBlocks: t("No conflict blocks remain in Result"),
    applyCurrentBlock: t("Apply Current block {0} to Result"),
    applyIncomingBlock: t("Apply Incoming block {0} to Result"),
    applyBothBlock: t("Apply Both block {0} to Result"),
    emptyBlock: t("empty block"),
    loaded: t("Loaded"),
    draftRestored: t("Restored unsaved Result from the closed conflict editor"),
    openingNative: t("Opening native merge editor..."),
    applyingCurrent: t("Applying exact Current version..."),
    applyingIncoming: t("Applying exact Incoming version..."),
    applyingBoth: t("Applying both sides..."),
    savingResult: t("Saving Result..."),
    resolving: t("Resolving..."),
    markersRemain: t("Apply or edit all conflict blocks before Resolve Marked"),
    blockAlreadyResolved: t("Conflict block was already resolved"),
    appliedBlock: t("Applied {0} block {1} to Result"),
    resolvedCurrent: t("Resolved with Current. The source context remains visible for review."),
    resolvedIncoming: t("Resolved with Incoming. The source context remains visible for review."),
    resolvedBoth: t("Resolved with both sides. The source context remains visible for review."),
    resolvedManual: t("Result was staged as resolved. The source context remains visible for review."),
    actionFailed: t("Action failed"),
    actionCancelled: t("Action cancelled"),
    resolutionContext: t("Conflict source and result context"),
    operationCommit: t("Operation commit"),
    unknownCommit: t("commit metadata unavailable"),
    operationMerge: t("merge"),
    operationRebase: t("rebase"),
    operationCherryPick: t("cherry-pick"),
    operationRevert: t("revert"),
    operationNone: t("unmerged index"),
  };
}

/** JSON을 inline script 종료 태그와 HTML 특수문자로부터 안전하게 만든다. */
export function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** HTML attribute 안에 넣을 host 문자열의 특수문자를 이스케이프한다. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 문서 session, switch request와 CSP에 공통으로 쓸 충분히 긴 nonce를 만든다. */
export function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/** conflict panel의 CSP, 지역화 데이터, media URI를 포함한 최초 HTML shell을 만든다. */
export function buildConflictPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "conflict");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "conflict.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "conflict.css"));
  const codiconStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css")
  );
  const tooltipResources = instantTooltipResources(webview, extensionUri);
  const nonce = makeNonce();
  const strings = safeInlineJson(conflictPanelI18n());
  const language = escapeHtmlAttribute(vscode.env.language || "en");
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${tooltipResources.styleUri}" rel="stylesheet" />
  <title>${escapeHtmlAttribute(vscode.l10n.t("Resolve Conflict"))}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__gscConflictI18n = ${strings};</script>
  <script nonce="${nonce}" src="${tooltipResources.scriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
