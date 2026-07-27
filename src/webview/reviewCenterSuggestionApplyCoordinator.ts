// Review Center suggestion의 local preview/apply를 안전하게 조정한다.
// - PR head와 local HEAD, source range와 working document를 모두 exact-match한 뒤 WorkspaceEdit만 적용한다.
import * as path from "node:path";
import { lstat } from "node:fs/promises";
import * as vscode from "vscode";
import { resolveSafeConflictWorkingPath } from "../git/conflictPathSafety";
import { GitService } from "../git/gitService";
import {
  createPullRequestSuggestionApplyPreview,
  matchesPullRequestSuggestionDocument,
  type PullRequestSuggestionApplyPreview,
} from "../git/pullRequestSuggestionApplyPlan";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** suggestion preview/apply 결과를 renderer로 전달하는 메시지 계약. */
export type ReviewCenterSuggestionApplyCoordinatorMessage =
  | { type: "suggestionPreview"; previewId: string; path: string; before: string; after: string }
  | { type: "suggestionApplied"; previewId: string; path: string }
  | { type: "suggestionApplyError"; message: string };

/** exact preview 뒤 apply에 필요한 문서 version과 CAS identity. */
interface PendingSuggestionPreview {
  snapshot: ReviewCenterSnapshot;
  uri: vscode.Uri;
  version: number;
  plan: PullRequestSuggestionApplyPreview;
  expiresAt: number;
}

/** panel lifecycle callback을 coordinator 의존성으로 작게 묶는다. */
export interface ReviewCenterSuggestionApplyCoordinatorOptions {
  /** renderer에 preview/result/error를 전달한다. */
  post(message: ReviewCenterSuggestionApplyCoordinatorMessage): void;
  /** panel dispose 뒤 renderer post를 막는 fence */
  isCurrent(snapshot: ReviewCenterSnapshot): boolean;
}

/** local worktree에 정확히 일치하는 suggestion만 preview·apply하는 coordinator. */
export class ReviewCenterSuggestionApplyCoordinator {
  private readonly previews = new Map<string, PendingSuggestionPreview>();
  private sequence = 0;

  /** repo-bound GitService와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly git: GitService,
    private readonly options: ReviewCenterSuggestionApplyCoordinatorOptions
  ) {}

  /** 선택 comment의 suggestion 한 건을 PR head/local document exact match로 preview한다. */
  public async preview(snapshot: ReviewCenterSnapshot | undefined, threadId: string, commentId: string, suggestionIndex: number): Promise<void> {
    try {
      if (!snapshot || !this.options.isCurrent(snapshot)) return;
      if (!vscode.workspace.isTrusted) throw new Error("Suggestion apply is unavailable because this workspace is not trusted.");
      if (snapshot.canOpenNativeDiff === false || !snapshot.headOid) throw new Error("Suggestion apply is unavailable for a pull request from another repository.");
      const target = findSuggestion(snapshot, threadId, commentId, suggestionIndex);
      if (!target) throw new Error("This suggestion is unavailable or cannot be applied safely.");
      const currentHead = await this.git.getHeadOid();
      if (currentHead !== snapshot.headOid) throw new Error("Suggestion apply requires the local worktree to be exactly at the pull request head.");
      const headText = await this.git.getFileContentAtRef(currentHead, target.path);
      const absolutePath = await resolveSafeConflictWorkingPath(this.repoRoot, target.path);
      const targetStat = await lstat(absolutePath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("Suggestion apply is unavailable for symbolic links, directories, or other non-regular files.");
      const uri = vscode.Uri.file(absolutePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const plan = createPullRequestSuggestionApplyPreview(
        headText,
        document.getText(),
        { startLine: target.startLine, endLine: target.endLine },
        target.replacement,
        document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
      );
      if (!this.options.isCurrent(snapshot)) return;
      const previewId = `suggestion-${++this.sequence}`;
      this.prune();
      this.previews.set(previewId, { snapshot, uri, version: document.version, plan, expiresAt: Date.now() + PREVIEW_TTL_MS });
      this.options.post({ type: "suggestionPreview", previewId, path: target.path, before: plan.before, after: plan.after });
      logInfo("review center suggestion preview created", { number: snapshot.number, path: target.path, startLine: target.startLine, endLine: target.endLine, replacementLines: target.replacement.split("\n").length });
    } catch (error) {
      this.postError(snapshot, error);
    }
  }

  /** preview가 아직 유효하고 문서가 바뀌지 않았을 때만 WorkspaceEdit으로 적용한다. */
  public async apply(snapshot: ReviewCenterSnapshot | undefined, previewId: string): Promise<void> {
    const pending = this.previews.get(previewId);
    try {
      if (!snapshot || !pending || pending.snapshot !== snapshot || pending.expiresAt < Date.now()) throw new Error("Suggestion preview expired. Create a new preview before applying.");
      if (!this.options.isCurrent(snapshot)) return;
      const document = await vscode.workspace.openTextDocument(pending.uri);
      if (document.version !== pending.version || !matchesPullRequestSuggestionDocument(document.getText(), pending.plan.documentHash)) {
        throw new Error("The working document changed after preview. Create a new suggestion preview.");
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(pending.uri, new vscode.Range(document.positionAt(pending.plan.startOffset), document.positionAt(pending.plan.endOffset)), pending.plan.after);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code could not apply this suggestion to the working document.");
      this.previews.delete(previewId);
      if (!this.options.isCurrent(snapshot)) return;
      this.options.post({ type: "suggestionApplied", previewId, path: relativePath(this.repoRoot, pending.uri.fsPath) });
      logInfo("review center suggestion applied", { number: snapshot.number, path: relativePath(this.repoRoot, pending.uri.fsPath) });
    } catch (error) {
      this.postError(snapshot, error);
    }
  }

  /** panel dispose/refresh 시 preview token을 버려 stale document에 적용하지 못하게 한다. */
  public clear(): void {
    this.previews.clear();
  }

  /** TTL을 지난 preview를 제거해 document identity를 오래 보관하지 않는다. */
  private prune(): void {
    for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id);
  }

  /** panel이 살아 있는 snapshot에만 단일 오류 문구를 전달하고 원인 로그는 Output에 남긴다. */
  private postError(snapshot: ReviewCenterSnapshot | undefined, error: unknown): void {
    if (!snapshot || !this.options.isCurrent(snapshot)) return;
    logError("review center suggestion apply failed", error, { number: snapshot.number });
    this.options.post({ type: "suggestionApplyError", message: error instanceof Error ? error.message.slice(0, 320) : "Unable to preview or apply this suggestion." });
  }
}

/** thread/comment/suggestion index와 current non-outdated RIGHT-side line range를 함께 검증한다. */
function findSuggestion(snapshot: ReviewCenterSnapshot, threadId: string, commentId: string, suggestionIndex: number): { path: string; startLine: number; endLine: number; replacement: string } | undefined {
  const thread = snapshot.threads.find((item) => item.id === threadId);
  const suggestion = thread?.comments.find((item) => item.id === commentId)?.suggestions[suggestionIndex];
  const path = thread?.path;
  const endLine = thread?.line;
  const startLine = thread?.startLine || endLine;
  if (!thread || thread.isOutdated || !path || !endLine || !startLine || !suggestion?.isApplicable || !safeRelativePath(path)) return undefined;
  return { path, startLine, endLine, replacement: suggestion.replacement };
}

/** 작업트리 외부·상위 경로로 탈출하는 GitHub path를 막는다. */
function safeRelativePath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.includes("\0");
}

/** log/result에만 쓸 저장소 상대 path를 보수적으로 만든다. */
function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}
