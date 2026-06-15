// PR preview 의 파일 diff 열기 동작을 담당한다.
// - 작업트리 파일이 있으면 editable diff, 없거나 삭제된 파일이면 ref↔ref diff 로 fallback 한다.
import * as path from "path";
import * as vscode from "vscode";
import type { PullRequestPreviewComment } from "../git/pullRequestPreviewFiles";
import { refreshBranchContent } from "../providers/branchContentProvider";
import { openRefVsWorkingDiff } from "./diffPresenter";
import { makeDiffTitle, makeRefUri } from "../utils/uri";
import { showPullRequestDiffComments } from "./pullRequestDiffComments";

/** PR preview 에서 diff 를 열 때 필요한 파일/기준 ref 정보 */
export interface PullRequestPreviewDiffRequest {
  path: string;
  oldPath?: string;
  status?: string;
  baseRef?: string;
  headRef?: string;
  preferEditable?: boolean;
  fallbackRef?: string;
  comments?: PullRequestPreviewComment[];
}

/**
 * PR preview 파일을 VS Code diff 로 연다.
 * @param repoRoot 저장소 루트
 * @param request 웹뷰에서 선택한 파일과 ref 정보
 */
export async function openPullRequestPreviewDiff(
  repoRoot: string,
  request: PullRequestPreviewDiffRequest
): Promise<void> {
  const relPath = safeRelativePath(request.path);
  const oldPath = request.oldPath ? safeRelativePath(request.oldPath) : undefined;
  if (!relPath) {
    return;
  }
  const baseRef = request.baseRef || "HEAD";
  const headRef = request.headRef || "HEAD";
  const fileUri = vscode.Uri.file(path.join(repoRoot, relPath));
  const fileLabel = path.basename(relPath);
  if (request.preferEditable && request.status !== "D" && await exists(fileUri)) {
    const hasWorkingDiff = !request.fallbackRef || await hasTextDiff(makeRefUri(baseRef, oldPath ?? relPath, repoRoot), fileUri);
    if (hasWorkingDiff) {
      await openRefVsWorkingDiff(repoRoot, baseRef, fileUri, relPath, {
        leftRelPath: oldPath,
        fileLabel,
      });
      showPullRequestDiffComments(fileUri, request.comments || []);
      return;
    }
  }
  if (request.fallbackRef) {
    await openRefDiffWithComments(repoRoot, baseRef, request.fallbackRef, relPath, oldPath, fileLabel, request.comments || []);
    return;
  }
  if (headRef !== "HEAD") {
    await openRefDiffWithComments(repoRoot, baseRef, headRef, relPath, oldPath, fileLabel, request.comments || []);
    return;
  }
  if (request.status !== "D" && await exists(fileUri)) {
    await openRefVsWorkingDiff(repoRoot, baseRef, fileUri, relPath, {
      leftRelPath: oldPath,
      fileLabel,
    });
    showPullRequestDiffComments(fileUri, request.comments || []);
    return;
  }
  await openRefDiffWithComments(repoRoot, baseRef, headRef, relPath, oldPath, fileLabel, request.comments || []);
}

/** ref 간 diff 를 열고 오른쪽 문서에 PR review comment 를 표시한다. */
async function openRefDiffWithComments(
  repoRoot: string,
  baseRef: string,
  headRef: string,
  relPath: string,
  oldPath: string | undefined,
  fileLabel: string,
  comments: PullRequestPreviewComment[]
): Promise<void> {
  const left = makeRefUri(baseRef, oldPath ?? relPath, repoRoot);
  const right = makeRefUri(headRef, relPath, repoRoot);
  refreshBranchContent(left);
  refreshBranchContent(right);
  await vscode.commands.executeCommand("vscode.diff", left, right, makeDiffTitle(baseRef, headRef, fileLabel), { preview: false });
  showPullRequestDiffComments(right, comments);
}

/** 기준 ref 문서와 작업트리 파일이 실제로 다른지 확인한다. */
async function hasTextDiff(left: vscode.Uri, right: vscode.Uri): Promise<boolean> {
  try {
    refreshBranchContent(left);
    const [leftDoc, rightBytes] = await Promise.all([
      vscode.workspace.openTextDocument(left),
      vscode.workspace.fs.readFile(right),
    ]);
    return leftDoc.getText() !== Buffer.from(rightBytes).toString("utf8");
  } catch {
    return true;
  }
}

/** 저장소 밖 경로나 절대 경로를 걸러낸다. */
function safeRelativePath(value: string): string | undefined {
  const relPath = String(value || "");
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    return undefined;
  }
  return relPath;
}

/** 작업트리 실제 파일이 열 수 있는 상태인지 확인한다. */
async function exists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(() => true, () => false);
}
