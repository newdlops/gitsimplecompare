// 활성 에디터에 GitHub PR inline review comment 를 after-line decoration 으로 표시한다.
// - 데이터 조회는 git 서비스에 맡기고, 이 모듈은 VS Code 에디터 표시와 캐싱만 담당한다.
import * as vscode from "vscode";
import {
  ActivePullRequestReviewComments,
  PullRequestReviewComment,
  PullRequestReviewCommentService,
} from "../git/pullRequestReviewComments";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logInfo } from "../ui/outputLog";

const EXT_CONFIG_SECTION = "gitSimpleCompare";
const SHOW_KEY = "pullRequestComments.show";
const FULL_SHOW_KEY = `${EXT_CONFIG_SECTION}.${SHOW_KEY}`;
const REFRESH_DELAY_MS = 220;
const CACHE_TTL_MS = 2 * 60 * 1000;
const COMMENT_CONTROLLER_ID = "gitSimpleComparePrReviewComments";
const SHOW_THREAD_COMMAND = "gitSimpleCompare.showPrEditorCommentThread";

interface PullRequestCommentCacheEntry {
  at: number;
  data?: ActivePullRequestReviewComments;
}

interface PullRequestCommentGroup {
  line: number;
  comments: PullRequestReviewComment[];
}

interface ShowThreadCommandPayload {
  uri: string;
  line: number;
}

/**
 * 활성 에디터의 GitHub PR review comment 표시를 관리한다.
 * - 라인 끝에는 작은 comment decoration 을 표시한다.
 * - CommentThread 는 hover action 을 선택했을 때만 만들어, 평소 line comment 표시와 중복되지 않게 한다.
 */
export class PullRequestCommentController implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly commentController: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, PullRequestCommentCacheEntry>();
  private readonly activeGroups = new Map<string, PullRequestCommentGroup>();
  private readonly activeThreads = new Map<string, vscode.CommentThread>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private requestSeq = 0;
  private disposed = false;

  constructor(private readonly registry: GitServiceRegistry) {
    this.decoration = createDecorationType();
    this.commentController = vscode.comments.createCommentController(
      COMMENT_CONTROLLER_ID,
      vscode.l10n.t("GitHub PR Comments")
    );
  }

  /**
   * 에디터/설정 이벤트를 등록하고 현재 활성 에디터를 한 번 갱신한다.
   * @returns 확장 비활성화 시 정리할 Disposable
   */
  register(): vscode.Disposable {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.scheduleRefresh("activeEditor")
      ),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.scheduleRefresh("visibleEditors")
      ),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isActiveDocument(document)) {
          void this.invalidateActiveRepoCache().finally(() =>
            this.scheduleRefresh("documentSaved")
          );
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(FULL_SHOW_KEY)) {
          this.applyConfiguration("configuration");
        }
      }),
      vscode.commands.registerCommand(
        SHOW_THREAD_COMMAND,
        (payload: ShowThreadCommandPayload) => this.showThread(payload)
      )
    );
    this.applyConfiguration("register");
    return this;
  }

  /**
   * 외부 git 상태 변화에 맞춰 활성 에디터의 PR comment 를 다시 읽도록 예약한다.
   * @param reason refresh 를 요청한 상위 이벤트 이름
   */
  refresh(reason: string): void {
    this.scheduleRefresh(reason);
  }

  /**
   * timer, decoration, comment thread, event listener 를 모두 정리한다.
   * - VS Code 가 확장을 비활성화할 때 context.subscriptions 를 통해 호출된다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.requestSeq++;
    this.clearVisibleDecorations();
    this.clearActiveGroups();
    this.decoration.dispose();
    this.commentController.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * 설정값을 읽어 표시 상태를 반영한다.
   * @param reason 상태 변경을 일으킨 이벤트 이름
   */
  private applyConfiguration(reason: string): void {
    if (!isEnabled()) {
      this.requestSeq++;
      this.clearVisibleDecorations();
      this.clearActiveGroups();
      logInfo("pr editor comments disabled", { reason });
      return;
    }
    logInfo("pr editor comments enabled", { reason });
    this.scheduleRefresh(reason);
  }

  /**
   * 짧은 지연 후 활성 에디터의 PR comment 를 다시 읽는다.
   * - 빠른 탭 이동/저장 이벤트를 한 번으로 합쳐 gh 호출을 줄인다.
   * @param reason refresh 를 예약한 이벤트 이름
   */
  private scheduleRefresh(reason: string): void {
    if (!isEnabled() || this.disposed) {
      return;
    }
    const requestId = ++this.requestSeq;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshActiveEditor(reason, requestId);
    }, REFRESH_DELAY_MS);
  }

  /**
   * 활성 에디터 파일에 해당하는 PR review comment 를 적용한다.
   * - 저장소 밖 파일, PR 이 없는 브랜치, comment 없는 파일은 조용히 비운다.
   * @param reason refresh 를 유발한 이벤트 이름
   * @param requestId 오래된 비동기 응답을 무시하기 위한 요청 번호
   */
  private async refreshActiveEditor(
    reason: string,
    requestId: number
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    this.clearVisibleDecorations();
    this.clearActiveGroups();
    if (!isEnabled() || !editor) {
      return;
    }
    if (editor.document.uri.scheme !== "file") {
      logInfo("pr editor comments skipped", { reason, target: "non-file" });
      return;
    }

    const service = await this.registry.resolve(dirname(editor.document.uri.fsPath));
    if (requestId !== this.requestSeq || !isEnabled()) {
      return;
    }
    if (!service) {
      logInfo("pr editor comments skipped", { reason, target: "no-repo" });
      return;
    }

    const relativePath = normalizeGitPath(
      service.toRepoRelative(editor.document.uri.fsPath)
    );
    try {
      const prComments = await this.loadComments(service.repoRoot);
      if (requestId !== this.requestSeq || !isEnabled()) {
        return;
      }
      if (!prComments) {
        logInfo("pr editor comments skipped", {
          reason,
          target: "no-active-pr",
          path: relativePath,
        });
        return;
      }
      const fileComments = prComments.comments.filter(
        (comment) => normalizeGitPath(comment.path) === relativePath
      );
      if (!fileComments.length) {
        logInfo("pr editor comments skipped", {
          reason,
          target: "no-comments-for-file",
          pr: prComments.number,
          path: relativePath,
        });
        return;
      }
      const groups = groupedComments(editor.document, fileComments);
      if (!groups.length) {
        logInfo("pr editor comments skipped", {
          reason,
          target: "no-display-line",
          pr: prComments.number,
          path: relativePath,
          comments: fileComments.length,
        });
        return;
      }
      this.applyGroups(editor, groups);
      logInfo("pr editor comments applied", {
        reason,
        pr: prComments.number,
        path: relativePath,
        comments: fileComments.length,
        lines: groups.length,
      });
    } catch (error) {
      if (requestId !== this.requestSeq) {
        return;
      }
      logInfo("pr editor comments failed", {
        reason,
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 저장소별 현재 브랜치 PR comment 를 캐시와 함께 읽는다.
   * @param repoRoot 저장소 루트
   * @returns 활성 PR comment 데이터. PR 이 없으면 undefined
   */
  private async loadComments(
    repoRoot: string
  ): Promise<ActivePullRequestReviewComments | undefined> {
    const service = new PullRequestReviewCommentService(repoRoot);
    const branch = await service.getCurrentBranch();
    if (!branch) {
      return undefined;
    }
    const cacheKey = `${repoRoot}\0${branch}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await service.getActiveBranchReviewComments(branch);
    this.cache.set(cacheKey, { at: Date.now(), data });
    logInfo("pr editor comments loaded", {
      repoRoot,
      branch,
      pr: data?.number,
      comments: data?.comments.length ?? 0,
    });
    return data;
  }

  /**
   * 활성 파일의 저장소 캐시를 무효화한다.
   * - 저장 후 GitHub comment line 과 작업 파일의 관계가 바뀔 수 있으므로 다음 refresh 에서 다시 읽는다.
   */
  private async invalidateActiveRepoCache(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }
    const service = await this.registry.resolve(dirname(editor.document.uri.fsPath));
    if (!service) {
      return;
    }
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${service.repoRoot}\0`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 계산된 comment group 을 after-line decoration 으로 표시한다.
   * @param editor 적용 대상 에디터
   * @param groups 라인별 comment 그룹
   */
  private applyGroups(
    editor: vscode.TextEditor,
    groups: PullRequestCommentGroup[]
  ): void {
    const uri = editor.document.uri.toString();
    for (const group of groups) {
      this.activeGroups.set(groupKey(uri, group.line), group);
    }
    editor.setDecorations(
      this.decoration,
      groups.map((group) => commentDecoration(editor.document.uri, group))
    );
  }

  /** 현재 보이는 에디터의 PR comment decoration 을 모두 제거한다. */
  private clearVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  /**
   * hover action 에서 요청한 라인의 CommentThread 를 펼친다.
   * @param payload hover command link 가 전달한 파일 URI 와 0-base line
   */
  private showThread(payload: ShowThreadCommandPayload | undefined): void {
    if (!payload || typeof payload.uri !== "string" || typeof payload.line !== "number") {
      return;
    }
    const key = groupKey(payload.uri, payload.line);
    const group = this.activeGroups.get(key);
    if (!group) {
      logInfo("pr editor comment thread skipped", {
        target: "missing-group",
        uri: payload.uri,
        line: payload.line,
      });
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === payload.uri
    );
    if (!editor || payload.line < 0 || payload.line >= editor.document.lineCount) {
      logInfo("pr editor comment thread skipped", {
        target: "missing-editor",
        uri: payload.uri,
        line: payload.line,
      });
      return;
    }
    this.activeThreads.get(key)?.dispose();
    const thread = this.commentController.createCommentThread(
      editor.document.uri,
      editor.document.lineAt(payload.line).range,
      group.comments.map(toVsCodeComment)
    );
    thread.label = vscode.l10n.t("PR review comments");
    thread.contextValue = "gitSimpleCompare.prReviewComments";
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.activeThreads.set(key, thread);
    logInfo("pr editor comment thread opened", {
      uri: payload.uri,
      line: payload.line,
      comments: group.comments.length,
    });
  }

  /** 현재 활성 comment group 과 펼쳐진 thread 를 모두 정리한다. */
  private clearActiveGroups(): void {
    this.activeGroups.clear();
    for (const thread of this.activeThreads.values()) {
      thread.dispose();
    }
    this.activeThreads.clear();
  }
}

/**
 * PR comment line marker 용 decoration type 을 만든다.
 * @returns 라인 끝 comment 아이콘과 overview ruler 표시를 가진 decoration type
 */
function createDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 0.65rem",
      width: "14px",
      height: "14px",
      color: new vscode.ThemeColor("button.foreground"),
      backgroundColor: new vscode.ThemeColor("button.background"),
      border: "1px solid",
      borderColor: new vscode.ThemeColor("focusBorder"),
      fontWeight: "700",
      textDecoration:
        "none; display: inline-block; font-family: codicon; font-size: 12px; line-height: 14px; text-align: center; padding: 0 2px; border-radius: 999px; transform: scale(1.35); transform-origin: center",
    },
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
}

/**
 * comment group 을 라인 끝 decoration option 으로 변환한다.
 * @param group 같은 라인의 PR comment 묶음
 * @returns VS Code decoration option
 */
function commentDecoration(
  uri: vscode.Uri,
  group: PullRequestCommentGroup
): vscode.DecorationOptions {
  return {
    range: new vscode.Range(
      group.line,
      Number.MAX_SAFE_INTEGER,
      group.line,
      Number.MAX_SAFE_INTEGER
    ),
    hoverMessage: hoverMarkdown(uri, group),
    renderOptions: { after: { contentText: "\ueac7" } },
  };
}

/**
 * 같은 표시 라인의 comment 를 하나로 묶는다.
 * @param document lineCount 와 range clamp 를 위한 문서
 * @param comments 파일에 달린 PR comment 목록
 * @returns line 오름차순 comment group
 */
function groupedComments(
  document: vscode.TextDocument,
  comments: PullRequestReviewComment[]
): PullRequestCommentGroup[] {
  const byLine = new Map<number, PullRequestReviewComment[]>();
  for (const comment of comments) {
    const line = clampLine(document.lineCount, targetLine(comment));
    if (line === undefined) {
      continue;
    }
    const list = byLine.get(line) || [];
    list.push(comment);
    byLine.set(line, list);
  }
  return Array.from(byLine.entries())
    .sort(([a], [b]) => a - b)
    .map(([line, list]) => ({ line, comments: list }));
}

/**
 * GitHub comment 의 side 정보를 고려해 표시할 대상 line 을 고른다.
 * @param comment GitHub inline review comment
 * @returns 1-base line 번호
 */
function targetLine(comment: PullRequestReviewComment): number | undefined {
  const side = (comment.side || "").toUpperCase();
  if (side === "LEFT") {
    return comment.originalLine || comment.line;
  }
  return comment.line || comment.originalLine;
}

/**
 * 1-base line 번호를 문서 범위 안의 0-base line 번호로 바꾼다.
 * @param lineCount 문서 전체 라인 수
 * @param oneBased GitHub 가 준 1-base line 번호
 * @returns VS Code 0-base line 번호. line 이 없으면 undefined
 */
function clampLine(lineCount: number, oneBased: number | undefined): number | undefined {
  if (!oneBased || lineCount <= 0) {
    return undefined;
  }
  return Math.min(Math.max(0, oneBased - 1), Math.max(0, lineCount - 1));
}

/**
 * hover 에서 comment 본문 요약을 markdown 으로 보여준다.
 * @param comments 같은 라인에 달린 comment 목록
 * @returns hover 에 표시할 MarkdownString
 */
function hoverMarkdown(
  uri: vscode.Uri,
  group: PullRequestCommentGroup
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = false;
  markdown.isTrusted = { enabledCommands: [SHOW_THREAD_COMMAND] };
  const args = encodeURIComponent(JSON.stringify([{ uri: uri.toString(), line: group.line }]));
  markdown.appendMarkdown(`[${vscode.l10n.t("Open PR comments")}](command:${SHOW_THREAD_COMMAND}?${args})`);
  group.comments.forEach((comment, index) => {
    markdown.appendMarkdown(index ? "\n\n---\n\n" : "\n\n");
    markdown.appendMarkdown(`**${escapeMarkdown(comment.author || "unknown")}**`);
    if (comment.createdAt) {
      markdown.appendMarkdown(`  ${escapeMarkdown(formatDate(comment.createdAt))}`);
    }
    markdown.appendMarkdown("\n\n");
    markdown.appendMarkdown(comment.body?.trim() || `_${vscode.l10n.t("No comment body.")}_`);
    if (comment.url) {
      markdown.appendMarkdown(`\n\n[GitHub](${comment.url})`);
    }
  });
  return markdown;
}

/**
 * GitHub review comment 를 VS Code Comment API 객체로 변환한다.
 * @param comment GitHub inline review comment
 * @returns 읽기 전용 preview comment 객체
 */
function toVsCodeComment(comment: PullRequestReviewComment): vscode.Comment {
  return {
    author: { name: comment.author || "unknown" },
    body: commentBodyMarkdown(comment),
    contextValue: "gitSimpleCompare.prReviewComment",
    mode: vscode.CommentMode.Preview,
    timestamp: parseDate(comment.createdAt),
  };
}

/**
 * CommentThread 본문용 markdown 을 만든다.
 * @param comment GitHub inline review comment
 * @returns VS Code Comment body 로 사용할 MarkdownString
 */
function commentBodyMarkdown(comment: PullRequestReviewComment): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = false;
  markdown.isTrusted = false;
  markdown.appendMarkdown(comment.body?.trim() || `_${vscode.l10n.t("No comment body.")}_`);
  if (comment.url) {
    markdown.appendMarkdown(`\n\n[GitHub](${comment.url})`);
  }
  return markdown;
}

/** GitHub ISO 날짜를 Comment API timestamp 로 바꾼다. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Comment group 을 파일 URI 와 line 으로 찾기 위한 key 를 만든다. */
function groupKey(uri: string, line: number): string {
  return `${uri}\0${line}`;
}

/** markdown 제어 문자가 작성자/날짜 표시를 깨지 않도록 escape 한다. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

/** GitHub ISO 날짜를 hover 표시용 문자열로 바꾼다. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** 현재 활성 에디터 문서와 같은 문서인지 확인한다. */
function isActiveDocument(document: vscode.TextDocument): boolean {
  return vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString();
}

/** 파일 경로의 디렉터리 부분을 플랫폼 구분자와 무관하게 반환한다. */
function dirname(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index >= 0 ? fsPath.slice(0, index) : fsPath;
}

/** GitHub/Git 경로 비교를 위해 슬래시 구분으로 정규화한다. */
function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** 설정에서 PR comment 표시 여부를 읽는다. */
function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(EXT_CONFIG_SECTION)
    .get<boolean>(SHOW_KEY, true);
}
