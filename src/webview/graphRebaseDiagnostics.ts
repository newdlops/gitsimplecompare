// rebase continue 진단 결과를 그래프 진행 UI 문구로 바꾸는 모듈.
// - git 모듈은 사실 데이터만 제공하고, 사용자 안내 문구는 webview 계층에서 조립한다.
import type { RebaseContinueDiagnostics } from "../git/rebaseContinueDiagnostics";

/**
 * rebase 진단 결과를 진행 카드 상세 문구로 만든다.
 * @param diagnostics git rebase 상태 진단 결과
 */
export function rebaseDiagnosticDetail(
  diagnostics: RebaseContinueDiagnostics | undefined
): string | undefined {
  if (!diagnostics) {
    return undefined;
  }
  if (diagnostics.unmergedFiles.length > 0) {
    return `Git index still has unresolved conflict entries: ${shortList(diagnostics.unmergedFiles)}.`;
  }
  if (diagnostics.markerFiles.length > 0) {
    return `No unmerged index entries remain, but conflict marker text is still in: ${shortList(diagnostics.markerFiles)}.`;
  }
  if (diagnostics.rebaseMessageConflicts.length > 0) {
    return `Git reports all conflicts fixed, but the rebase message still names: ${shortList(diagnostics.rebaseMessageConflicts)}.`;
  }
  if (diagnostics.unstagedFiles.length > 0) {
    return `Some files changed after staging and are not in the next rebase commit yet: ${shortList(diagnostics.unstagedFiles)}.`;
  }
  if (diagnostics.stagedFiles.length > 0) {
    return "All visible changes are staged for the current rebase step. Continue should create the current commit.";
  }
  return undefined;
}

/**
 * rebase 진단 결과를 progress 카드 guidance 줄로 만든다.
 * @param diagnostics git rebase 상태 진단 결과
 */
export function rebaseDiagnosticGuidance(
  diagnostics: RebaseContinueDiagnostics | undefined
): string[] | undefined {
  if (!diagnostics) {
    return undefined;
  }
  const lines: string[] = [];
  if (diagnostics.unmergedFiles.length > 0) {
    lines.push(`Unresolved index paths: ${shortList(diagnostics.unmergedFiles)}.`);
    lines.push("Resolve each file in the Conflicts view or editor, then stage it.");
  } else {
    lines.push("Git index has no unresolved conflict entries.");
  }
  if (diagnostics.markerFiles.length > 0) {
    lines.push(`Conflict marker text remains in: ${shortList(diagnostics.markerFiles)}.`);
    lines.push("Remove marker blocks manually and stage those files before Continue.");
  }
  if (
    diagnostics.rebaseMessageConflicts.length > 0 &&
    diagnostics.markerFiles.length === 0 &&
    diagnostics.unmergedFiles.length === 0
  ) {
    lines.push(`Rebase message conflict list: ${shortList(diagnostics.rebaseMessageConflicts)}.`);
    lines.push("Those paths may already be staged; inspect them if Continue still fails.");
  }
  if (diagnostics.unstagedFiles.length > 0) {
    lines.push(`Unstaged after staging: ${shortList(diagnostics.unstagedFiles)}.`);
    lines.push("Stage these files or discard their extra changes before Continue.");
  }
  return lines.length ? lines : undefined;
}

/**
 * OUTPUT 로그에 넣을 짧은 진단 객체를 만든다.
 * @param diagnostics git rebase 상태 진단 결과
 */
export function rebaseDiagnosticLogDetail(
  diagnostics: RebaseContinueDiagnostics | undefined
): Record<string, unknown> {
  if (!diagnostics) {
    return { rebaseDiagnostics: false };
  }
  return {
    rebaseDiagnostics: true,
    rebaseOperation: diagnostics.operation,
    rebaseUnmergedFiles: diagnostics.unmergedFiles.length,
    rebaseMessageConflicts: diagnostics.rebaseMessageConflicts,
    rebaseMarkerFiles: diagnostics.markerFiles,
    rebaseStagedFiles: diagnostics.stagedFiles.length,
    rebaseUnstagedFiles: diagnostics.unstagedFiles,
  };
}

/**
 * 파일 목록을 UI 에 넣기 좋은 짧은 문자열로 만든다.
 * @param files 파일 목록
 */
function shortList(files: string[]): string {
  const shown = files.slice(0, 4);
  const suffix = files.length > shown.length ? `, +${files.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}
