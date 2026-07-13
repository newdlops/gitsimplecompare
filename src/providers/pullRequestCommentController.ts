// 활성 에디터에 GitHub PR inline review comment 를 접힌 comment thread 로 표시한다.
// - 데이터 조회/캐싱은 전용 로더에 맡기고, 이 모듈은 VS Code 에디터 표시와 refresh 생명주기만 담당한다.
import * as vscode from "vscode";
import { PullRequestReviewComment } from "../git/pullRequestReviewComments";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { pullRequestCommentMarkdown } from "../ui/pullRequestCommentMarkdown";
import {
  groupPullRequestThreadComments,
  PullRequestThreadGroup,
} from "../ui/pullRequestCommentThreads";
import {
  countAttachedSuggestedChangesets,
  countBodySuggestedChangeHints,
  suggestedCommentIds,
} from "./pullRequestCommentDiagnostics";
import { logInfo } from "../ui/outputLog";
import { PullRequestCommentCache } from "./pullRequestCommentCache";

const EXT_CONFIG_SECTION = "gitSimpleCompare";
const SHOW_KEY = "pullRequestComments.show";
const FULL_SHOW_KEY = `${EXT_CONFIG_SECTION}.${SHOW_KEY}`;
const REFRESH_DELAY_MS = 220;
const COMMENT_CONTROLLER_ID = "gitSimpleComparePrReviewComments";

type PullRequestCommentGroup = PullRequestThreadGroup<PullRequestReviewComment>;

/**
 * 활성 에디터의 GitHub PR review comment 표시를 관리한다.
 * - 코멘트가 있는 라인은 VS Code CommentThread marker 로 표시해 gutter 영역에서 접고 펼치게 한다.
 * - decoration 은 본문 뒤 여백을 쓰지 않고 overview ruler 표시만 담당한다.
 */
export class PullRequestCommentController implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly commentController: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly commentCache: PullRequestCommentCache;
  private readonly activeThreads = new Map<string, vscode.CommentThread>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private requestSeq = 0;
  private refreshDeferred = false;
  private disposed = false;

  constructor(
    private readonly registry: GitServiceRegistry,
    secrets: vscode.SecretStorage
  ) {
    this.commentCache = new PullRequestCommentCache(secrets);
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
      vscode.window.onDidChangeWindowState((state) => {
        // 포커스 자체로 Git/GitHub 조회를 반복하지 않고, 백그라운드에서 놓친 실제 요청만 재개한다.
        if (state.focused && this.refreshDeferred) {
          this.refreshDeferred = false;
          this.scheduleRefresh("windowFocused");
        }
      }),
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
      })
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
   * 저장소별 PR comment 캐시를 모두 비우고 활성 에디터를 다시 읽는다.
   * - GitHub 웹 쿠키처럼 인증 상태가 바뀐 뒤 TTL 때문에 이전 빈 결과가 유지되지 않도록 한다.
   * @param reason 캐시 무효화를 일으킨 이벤트 이름
   */
  invalidateCache(reason: string): void {
    this.commentCache.invalidate(reason);
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
    this.refreshDeferred = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.requestSeq++;
    this.commentCache.dispose();
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
      this.refreshDeferred = false;
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
    if (!vscode.window.state.focused) {
      this.refreshDeferred = true;
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      return;
    }
    this.refreshDeferred = false;
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
    // 백그라운드 창은 원격 PR 조회를 시작하지 않는다. 기존 thread/decorations 는 보존하고,
    // 창이 다시 포커스되면 onDidChangeWindowState 경로가 최신 상태를 예약한다.
    if (!vscode.window.state.focused) {
      this.refreshDeferred = true;
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!isEnabled() || !editor) {
      this.clearVisibleDecorations();
      this.clearActiveGroups();
      return;
    }
    if (editor.document.uri.scheme !== "file") {
      this.clearVisibleDecorations();
      this.clearActiveGroups();
      logInfo("pr editor comments skipped", { reason, target: "non-file" });
      return;
    }

    const service = await this.registry.resolve(dirname(editor.document.uri.fsPath));
    if (!vscode.window.state.focused) {
      this.refreshDeferred = true;
      return;
    }
    if (
      requestId !== this.requestSeq ||
      !isEnabled()
    ) {
      return;
    }
    if (!service) {
      this.clearVisibleDecorations();
      this.clearActiveGroups();
      logInfo("pr editor comments skipped", { reason, target: "no-repo" });
      return;
    }

    const relativePath = normalizeGitPath(
      service.toRepoRelative(editor.document.uri.fsPath)
    );
    try {
      const prComments = await this.commentCache.load(service.repoRoot);
      if (!vscode.window.state.focused) {
        this.refreshDeferred = true;
        return;
      }
      if (
        requestId !== this.requestSeq ||
        !isEnabled()
      ) {
        return;
      }
      if (!prComments) {
        this.clearVisibleDecorations();
        this.clearActiveGroups();
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
        this.clearVisibleDecorations();
        this.clearActiveGroups();
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
        this.clearVisibleDecorations();
        this.clearActiveGroups();
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
        suggestedChangesets: countAttachedSuggestedChangesets(fileComments),
        bodySuggestedChangeHints: countBodySuggestedChangeHints(fileComments),
        suggestedCommentIds: suggestedCommentIds(fileComments),
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
    this.commentCache.invalidateRepository(service.repoRoot);
  }

  /**
   * 계산된 comment group 을 thread marker 와 overview ruler 로 표시한다.
   * - 이미 존재하는 thread 는 dispose 하지 않고 갱신해, 사용자가 펼친 상태를 refresh 뒤에도 유지한다.
   * @param editor 적용 대상 에디터
   * @param groups 라인별 comment 그룹
   */
  private applyGroups(
    editor: vscode.TextEditor,
    groups: PullRequestCommentGroup[]
  ): void {
    const uri = editor.document.uri.toString();
    const nextKeys = new Set(groups.map((group) => groupKey(uri, group.line)));
    this.removeStaleThreads(nextKeys);
    this.applyVisibleDecorations(editor, groups);
    for (const group of groups) {
      this.upsertThread(editor, uri, group);
    }
  }

  /**
   * 이번 refresh 결과에 없는 thread 만 정리한다.
   * @param nextKeys 유지해야 할 URI/line thread key 목록
   */
  private removeStaleThreads(nextKeys: Set<string>): void {
    for (const [key, thread] of Array.from(this.activeThreads.entries())) {
      if (nextKeys.has(key)) {
        continue;
      }
      thread.dispose();
      this.activeThreads.delete(key);
    }
  }

  /**
   * active editor 에는 PR comment overview marker 를, 다른 visible editor 에는 빈 decoration 을 적용한다.
   * @param editor active editor
   * @param groups active editor 에 표시할 comment group
   */
  private applyVisibleDecorations(
    editor: vscode.TextEditor,
    groups: PullRequestCommentGroup[]
  ): void {
    const uri = editor.document.uri.toString();
    for (const visible of vscode.window.visibleTextEditors) {
      visible.setDecorations(
        this.decoration,
        visible.document.uri.toString() === uri
          ? groups.map((group) => overviewDecoration(group))
          : []
      );
    }
  }

  /** 현재 활성 comment group 과 펼쳐진 thread 를 모두 정리한다. */
  private clearActiveGroups(): void {
    for (const thread of this.activeThreads.values()) {
      thread.dispose();
    }
    this.activeThreads.clear();
  }

  /** 현재 보이는 에디터의 PR comment overview decoration 을 모두 제거한다. */
  private clearVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  /**
   * comment group 하나를 CommentThread 로 만들거나 기존 thread 를 갱신한다.
   * - 기존 thread 의 collapsibleState 는 건드리지 않아 펼쳐 둔 thread 가 refresh 로 접히지 않게 한다.
   * @param editor 적용 대상 에디터
   * @param uri    thread key 로 사용할 문서 URI 문자열
   * @param group  같은 줄에 묶인 PR review comment
   */
  private upsertThread(
    editor: vscode.TextEditor,
    uri: string,
    group: PullRequestCommentGroup
  ): void {
    const key = groupKey(uri, group.line);
    const existing = this.activeThreads.get(key);
    if (existing) {
      existing.range = editor.document.lineAt(group.line).range;
      existing.comments = group.comments.map(toVsCodeComment);
      existing.label = vscode.l10n.t("PR review comments");
      existing.contextValue = "gitSimpleCompare.prReviewComments";
      existing.canReply = false;
      return;
    }
    const thread = this.commentController.createCommentThread(
      editor.document.uri,
      editor.document.lineAt(group.line).range,
      group.comments.map(toVsCodeComment)
    );
    thread.label = vscode.l10n.t("PR review comments");
    thread.contextValue = "gitSimpleCompare.prReviewComments";
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.activeThreads.set(key, thread);
  }
}

/**
 * PR comment 위치를 overview ruler 에만 표시하는 decoration type 을 만든다.
 * @returns 본문 여백을 쓰지 않는 overview ruler 전용 decoration type
 */
function createDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
}

/**
 * comment group 을 overview ruler decoration option 으로 변환한다.
 * @param group 같은 라인의 PR comment 묶음
 * @returns VS Code decoration option
 */
function overviewDecoration(group: PullRequestCommentGroup): vscode.DecorationOptions {
  return {
    range: new vscode.Range(
      group.line,
      Number.MAX_SAFE_INTEGER,
      group.line,
      Number.MAX_SAFE_INTEGER
    ),
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
  return groupPullRequestThreadComments(document.lineCount, comments);
}

/**
 * GitHub review comment 를 VS Code Comment API 객체로 변환한다.
 * @param comment GitHub inline review comment
 * @returns 읽기 전용 preview comment 객체
 */
function toVsCodeComment(comment: PullRequestReviewComment): vscode.Comment {
  return {
    author: { name: comment.author || "unknown" },
    body: pullRequestCommentMarkdown(comment),
    contextValue: "gitSimpleCompare.prReviewComment",
    mode: vscode.CommentMode.Preview,
    timestamp: parseDate(comment.createdAt),
  };
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
