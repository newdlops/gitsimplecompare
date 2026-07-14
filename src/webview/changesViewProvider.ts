// CHANGES 웹뷰 상태/커밋 메시지를 보관하고 클릭은 하위 명령에 위임해 렌더 생명주기에 집중한다.
import * as vscode from "vscode";
import type { BranchComparison } from "../git/gitTypes";
import type { StatusGroups } from "../git/gitService";
import type { CommitFailureReport } from "../git/commitHookFailure";
import type { CommitHooksSnapshot } from "../git/commitHookService";
import { ChangeDiffArgs, SortKey, ViewMode } from "../providers/changesTreeModel";
import type { RepoInfo } from "../commands/shared";
import type { StashView } from "../commands/stash";
import { editorGutterSettingAllowsMarkers } from "../providers/comparisonScmProvider";
import { logError, logInfo } from "../ui/outputLog";
import { FileIconThemeResolver } from "./fileIconTheme";
import { buildChangesHtml } from "./changesHtml";
import { buildChangesRenderPayload } from "./changesRenderPayload";
import { loadViewModes, loadVisibleSections } from "./changesViewState";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";
import { routeCommitHookMessage } from "./changesCommitHookMessages";
import { routeChangesAiMessage } from "./changesAiMessages";
import { runCommitOperation, runWorkingTreeOperation } from "./changesWebviewOperations";
import {
  TREE_SECTIONS,
  VISIBLE_SECTIONS,
  type ComparisonDraft,
  type FileHistoryView,
  type TreeSection,
  type ViewModes,
  type VisibleSection,
  type VisibleSections,
  type WorktreeView,
} from "./changesViewTypes";
export { VISIBLE_SECTIONS } from "./changesViewTypes";
export type { ComparisonDraft, TreeSection, VisibleSection } from "./changesViewTypes";
/** 보기 모드/정렬을 세션 간 유지하기 위한 저장 키 */
const VIEW_MODE_STATE = "gitSimpleCompare.viewMode";
const SORT_KEY_STATE = "gitSimpleCompare.sortKey";
const VISIBLE_SECTIONS_STATE = "gitSimpleCompare.visibleSections";
/** CHANGES 웹뷰의 상태, 메시지 라우팅, 렌더 생명주기를 관리하는 프로바이더. */
export class ChangesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gitSimpleCompare.changes";
  private view?: vscode.WebviewView;
  private repositories: RepoInfo[] = [];
  private activeRepo?: string;
  private comparison?: BranchComparison;
  private draft: ComparisonDraft = {};
  private staged: StatusGroups["staged"] = [];
  private unstaged: StatusGroups["unstaged"] = [];
  private stashes: StashView[] = [];
  private worktrees: WorktreeView[] = [];
  private fileHistory: FileHistoryView = { commits: [] };
  private commitMessage = "";
  private commitMessageRevision = 0;
  private aiCommitGenerating = false;
  private commitHooks?: CommitHooksSnapshot;
  private commitFailure?: CommitFailureReport;
  private viewModes: ViewModes;
  private sortKey: SortKey;
  private visibleSections: VisibleSections;
  private readonly fileIcons = new FileIconThemeResolver();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderPayloadJson = "";
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly comparisonEnabled: () => boolean,
    private readonly requestRefresh: (reason: string) => void
  ) {
    this.viewModes = loadViewModes(memento.get(VIEW_MODE_STATE));
    this.sortKey = memento.get<SortKey>(SORT_KEY_STATE, "path");
    this.visibleSections = loadVisibleSections(
      memento.get(VISIBLE_SECTIONS_STATE)
    );
  }
  /**
   * 웹뷰 뷰가 생성/표시될 때 호출된다(숨겼다 다시 열면 재호출될 수 있다).
   * @param view 해석할 웹뷰 뷰
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = buildChangesHtml(this.extensionUri, view.webview);
    this.lastRenderPayloadJson = "";
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.requestRefresh("viewVisible");
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.clearRenderTimer();
    });
  }
  /**
   * 저장소 목록을 갱신한다. 활성 저장소가 목록에 없으면 현재 워크스페이스 repo 를 우선 선택한다.
   * @param repos 저장소 정보 목록(루트 + 브랜치)
   * @param preferredRoot activeRepo 가 없거나 사라졌을 때 우선 선택할 저장소 루트
   */
  setRepositories(repos: RepoInfo[], preferredRoot?: string): void {
    const previousRoot = this.activeRepo;
    this.repositories = repos;
    if (!this.activeRepo || !repos.some((r) => r.root === this.activeRepo)) {
      this.activeRepo =
        repos.find((repo) => repo.root === preferredRoot)?.root ??
        repos[0]?.root;
    }
    if (previousRoot !== this.activeRepo) {
      this.commitHooks = undefined;
      this.commitFailure = undefined;
    }
    this.render();
  }
  /** 현재 활성 저장소 루트(없으면 undefined). */
  getActiveRepo(): string | undefined {
    return this.activeRepo;
  }
  /** 전체 refresh가 workspace를 다시 탐색하지 않도록 마지막 저장소 목록의 복사본을 반환한다. */
  getRepositories(): RepoInfo[] {
    return this.repositories.map((repo) => ({ ...repo }));
  }
  /** Changes 웹뷰가 현재 화면에 보이는지 확인한다(자동 git refresh 게이트로 사용). */
  isVisible(): boolean {
    return this.view?.visible ?? false;
  }
  /** 작업트리 변경(스테이징/미스테이징)을 갱신한다(Changes 섹션). */
  setStatusGroups(groups: StatusGroups): void {
    this.staged = groups.staged;
    this.unstaged = groups.unstaged;
    this.render();
  }
  /** stash 목록(+ 각 stash 의 파일)을 갱신한다(Stashes 섹션). */
  setStashes(stashes: StashView[]): void {
    this.stashes = stashes;
    this.render();
  }
  /** git worktree 목록을 갱신한다(Worktrees 섹션). */
  setWorktrees(worktrees: WorktreeView[]): void {
    this.worktrees = worktrees;
    this.render();
  }
  /** 현재 활성 에디터 파일의 커밋 히스토리를 갱신한다(History 섹션). */
  setFileHistory(fileHistory: FileHistoryView): void {
    this.fileHistory = fileHistory;
    this.render();
  }
  /** 현재 커밋 메시지(명령 레이어가 커밋 시 읽는다). */
  getCommitMessage(): string {
    return this.commitMessage;
  }
  /** 커밋 메시지를 설정하고 다시 그린다(커밋 후 비우기 등). */
  setCommitMessage(message: string): void {
    this.commitMessage = message;
    this.commitMessageRevision++;
    this.render();
  }
  /** 활성 저장소에서 조회한 commit hook 관리 상태를 설정하고 다시 그린다. */
  setCommitHooks(snapshot: CommitHooksSnapshot | undefined): void {
    if (snapshot && snapshot.repoRoot !== this.activeRepo) {
      logInfo("commit hooks result skipped", {
        resultRoot: snapshot.repoRoot,
        activeRoot: this.activeRepo,
        reason: "stale-repository",
      });
      return;
    }
    this.commitHooks = snapshot;
    this.render();
  }
  /** 마지막 commit/hook 실패 보고서를 설정하거나 지우고 다시 그린다. */
  setCommitFailure(report: CommitFailureReport | undefined): void {
    this.commitFailure = report;
    this.render();
  }
  /** 비교 컨텍스트를 교체하고 다시 그린다. */
  setComparison(comparison: BranchComparison): void {
    const repoChanged = this.activeRepo !== comparison.repoRoot;
    if (repoChanged) {
      this.commitHooks = undefined;
      this.commitFailure = undefined;
    }
    this.comparison = comparison;
    this.activeRepo = comparison.repoRoot;
    this.render();
    if (repoChanged) {
      void vscode.commands.executeCommand("gitSimpleCompare.refreshCommitHooks");
    }
  }
  /** 현재 비교 컨텍스트를 반환한다(없으면 undefined). */
  getComparison(): BranchComparison | undefined {
    return this.comparison;
  }
  /** 현재 비교와 From/To 초안을 모두 지워 처음 브랜치 선택 상태로 되돌린다. */
  clearComparison(): void {
    this.comparison = undefined;
    this.draft = {};
    this.render();
  }
  /** 비교 전 초안(from/to)을 반환한다. */
  getDraft(): ComparisonDraft {
    return this.draft;
  }
  /** 초안의 한쪽 브랜치를 설정하고 다시 그린다. */
  setDraft(side: "from" | "to", ref: string): void {
    this.draft[side] = ref;
    this.render();
  }
  /** 특정 섹션의 보기 모드. */
  getViewMode(section: TreeSection): ViewMode {
    return this.viewModes[section];
  }
  /**
   * 툴바 토글/컨텍스트 키용 대표 보기 모드.
   * - 모든 트리 섹션이 tree 면 "tree", 하나라도 list 면 "list" 로 본다.
   *   (툴바 버튼이 "전부 tree → 전부 list" / "그 외 → 전부 tree" 를 제안하도록.)
   */
  getRepresentativeViewMode(): ViewMode {
    return TREE_SECTIONS.every((s) => this.viewModes[s] === "tree")
      ? "tree"
      : "list";
  }
  /** 현재 정렬 기준. */
  getSortKey(): SortKey {
    return this.sortKey;
  }
  /** 아코디언 섹션 표시 상태를 반환한다(view/title 메뉴 체크 상태와 payload 공용). */
  getVisibleSections(): VisibleSections {
    return { ...this.visibleSections };
  }
  /** 아코디언 섹션 표시를 토글한다. 마지막으로 보이는 섹션은 숨기지 않는다. */
  toggleVisibleSection(section: VisibleSection): void {
    if (this.visibleSections[section]) {
      const visibleCount = VISIBLE_SECTIONS.filter(
        (id) => this.visibleSections[id]
      ).length;
      if (visibleCount <= 1) {
        return;
      }
    }
    this.visibleSections[section] = !this.visibleSections[section];
    void this.memento.update(VISIBLE_SECTIONS_STATE, this.visibleSections);
    this.render();
  }
  /** 특정 섹션의 보기 모드를 바꾸고(변경 시) 저장·재렌더한다. */
  setViewMode(section: TreeSection, mode: ViewMode): void {
    if (mode !== this.viewModes[section]) {
      this.viewModes[section] = mode;
      void this.memento.update(VIEW_MODE_STATE, this.viewModes);
      this.render();
    }
  }
  /** 모든 트리 섹션을 같은 모드로 맞춘다(상단 툴바의 전역 토글). */
  setAllViewModes(mode: ViewMode): void {
    let changed = false;
    for (const section of TREE_SECTIONS) {
      if (this.viewModes[section] !== mode) {
        this.viewModes[section] = mode;
        changed = true;
      }
    }
    if (changed) {
      void this.memento.update(VIEW_MODE_STATE, this.viewModes);
      this.render();
    }
  }
  /** 정렬 기준을 바꾸고(변경 시) 다시 그린다. */
  setSortKey(key: SortKey): void {
    if (key !== this.sortKey) {
      this.sortKey = key;
      void this.memento.update(SORT_KEY_STATE, key);
      this.render();
    }
  }
  /** 강제로 다시 그린다. */
  refresh(): void {
    if (this.view) {
      this.clearRenderTimer();
      this.lastRenderPayloadJson = "";
      this.view.webview.html = buildChangesHtml(
        this.extensionUri,
        this.view.webview
      );
    } else {
      this.render();
    }
  }
  /** 비교 controller 토글만 바뀐 경우 웹뷰 문서를 재생성하지 않고 상태 배너만 다시 그린다. */
  refreshComparisonStatus(): void {
    this.render();
  }
  // ---- 내부 구현 ----
  /**
   * 저장소를 전환한다. 브랜치가 다르므로 비교/초안/작업변경을 초기화하고 다시 읽는다.
   * @param root 새 활성 저장소 루트
   */
  private selectRepo(root: string): void {
    if (root === this.activeRepo) {
      return;
    }
    this.activeRepo = root;
    this.comparison = undefined;
    this.draft = {};
    this.staged = [];
    this.unstaged = [];
    this.stashes = [];
    this.worktrees = [];
    this.commitMessage = "";
    this.commitMessageRevision++;
    this.commitHooks = undefined;
    this.commitFailure = undefined;
    this.render();
    void vscode.commands.executeCommand("gitSimpleCompare.clearExplorerComparison");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshWorkingChanges");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshStashes");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshWorktrees");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshCommitHooks");
  }
  /** 현재 상태 렌더를 다음 tick 으로 예약해 연속 상태 변경을 한 번의 postMessage 로 합친다. */
  private render(): void {
    if (!this.view) {
      return;
    }
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.postRender();
    }, 16);
  }
  /** 현재 상태로 렌더 payload 를 만들어 변경이 있을 때만 웹뷰로 보낸다. */
  private postRender(): void {
    if (!this.view) {
      return;
    }
    const payload = buildChangesRenderPayload(this.renderState(), this.fileIcons);
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === this.lastRenderPayloadJson) {
      return;
    }
    this.lastRenderPayloadJson = payloadJson;
    void this.view.webview.postMessage({ type: "render", payload });
  }
  /** payload builder 에 넘길 provider 상태 스냅샷을 만든다. */
  private renderState() {
    return {
      repositories: this.repositories,
      activeRepo: this.activeRepo,
      comparison: this.comparison,
      comparisonEnabled: this.comparisonEnabled(),
      gutterSettingEnabled: editorGutterSettingAllowsMarkers(),
      draft: this.draft,
      staged: this.staged,
      unstaged: this.unstaged,
      stashes: this.stashes,
      worktrees: this.worktrees,
      fileHistory: this.fileHistory,
      commitMessage: this.commitMessage,
      commitMessageRevision: this.commitMessageRevision,
      aiCommitGenerating: this.aiCommitGenerating,
      commitHooks: this.commitHooks,
      commitFailure: this.commitFailure,
      viewModes: this.viewModes,
      sortKey: this.sortKey,
      visibleSections: this.getVisibleSections(),
    };
  }
  /** 예약된 렌더 타이머를 취소한다. */
  private clearRenderTimer(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
  }
  /** 작업트리 stage/unstage 진행 상태를 웹뷰에 알린다. */
  setWorkingOperation(
    active: boolean,
    action: "stage" | "unstage",
    paths?: string[],
    phase?: "git" | "refresh"
  ): void {
    void this.view?.webview.postMessage({
      type: "workingOperation",
      active,
      action,
      paths,
      phase,
    });
  }
  /** AI 커밋 메시지 생성 진행 상태를 웹뷰 버튼에 알린다. */
  setAiCommitGeneration(active: boolean): void {
    this.aiCommitGenerating = active;
    // 즉각 반영용 직접 메시지 + render payload 동기화(뷰 재생성/메시지 유실에도 버튼이 stuck 되지 않게 한다).
    void this.view?.webview.postMessage({
      type: "aiCommitGeneration",
      active,
    });
    this.render();
  }
  /**
   * 웹뷰 메시지를 처리한다. 동작은 등록된 명령/내부 메서드로 위임한다.
   * @param msg 웹뷰 메시지
   */
  private handleMessage(msg: ChangesWebviewMessage): void {
    if (routeCommitHookMessage(msg, this.view?.webview)) {
      return;
    }
    if (routeChangesAiMessage(msg)) {
      return;
    }
    if (msg.type === "ready") {
      this.lastRenderPayloadJson = "";
      this.render();
      this.requestRefresh("viewReady");
    } else if (msg.type === "selectRepo" && msg.root) {
      this.selectRepo(msg.root);
    } else if (msg.type === "changeRef" && msg.side) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.changeComparisonRef",
        msg.side
      );
    } else if (msg.type === "runCompare") {
      void vscode.commands.executeCommand("gitSimpleCompare.runComparison");
    } else if (msg.type === "compareCurrentBranch") {
      void vscode.commands.executeCommand("gitSimpleCompare.compareBranches");
    } else if (msg.type === "openGutterSettings") {
      void vscode.commands.executeCommand("gitSimpleCompare.openGutterSettings");
    } else if (msg.type === "showComparisonMarkers") {
      void vscode.commands.executeCommand("gitSimpleCompare.showExplorerComparison");
    } else if (msg.type === "resetComparison") {
      void vscode.commands.executeCommand("gitSimpleCompare.clearExplorerComparison");
    } else if (msg.type === "toggleViewMode" && msg.section) {
      // 섹션 헤더의 트리/리스트 토글 — 해당 섹션만 뒤집는다(다른 섹션과 독립).
      // 토글 후 툴바 컨텍스트 키도 갱신하도록 명령에 위임한다.
      void vscode.commands.executeCommand(
        "gitSimpleCompare.toggleSectionViewMode",
        msg.section
      );
    } else if (
      msg.type === "openComparisonFile" &&
      msg.path &&
      this.comparison
    ) {
      const comparison = this.comparison;
      const change = comparison.changes.find((item) => item.path === msg.path);
      if (!change) {
        return;
      }
      const args: ChangeDiffArgs = { comparison, change };
      // 명령 등록 누락·열기 실패도 boolean false와 같은 fallback 경로로 합쳐
      // 웹뷰 이벤트 Promise가 처리되지 않은 rejection으로 남지 않게 한다.
      void Promise.resolve(
        vscode.commands.executeCommand<boolean>(
          "gitSimpleCompare.openComparisonFile",
          { repoRoot: comparison.repoRoot, path: change.path }
        )
      )
        .catch((error) => {
          logError("comparison working file command failed", error, {
            repoRoot: comparison.repoRoot,
            path: change.path,
          });
          return false;
        })
        .then(async (handled) => {
          if (handled) {
            return;
          }
          try {
            await vscode.commands.executeCommand(
              "gitSimpleCompare.openChangeDiff",
              args
            );
          } catch (error) {
            logError("comparison diff fallback failed", error, {
              repoRoot: comparison.repoRoot,
              path: change.path,
            });
          }
        });
    } else if (msg.type === "openDiff" && msg.path && this.comparison) {
      const change = this.comparison.changes.find((c) => c.path === msg.path);
      if (change) {
        const args: ChangeDiffArgs = { comparison: this.comparison, change };
        void vscode.commands.executeCommand(
          "gitSimpleCompare.openChangeDiff",
          args
        );
      }
    } else if (msg.type === "openWorkingChange" && msg.path && this.activeRepo) {
      void vscode.commands.executeCommand("gitSimpleCompare.openWorkingChange", {
        root: this.activeRepo,
        path: msg.path,
        stage: msg.stage,
        status: msg.status,
        hasStaged: this.staged.some((item) => item.path === msg.path),
      });
    } else if (msg.type === "openFile" && msg.path && this.activeRepo) {
      void vscode.commands.executeCommand("gitSimpleCompare.openFile", {
        root: this.activeRepo,
        path: msg.path,
      });
    } else if (msg.type === "stage") {
      void runWorkingTreeOperation(this, "stage", msg.paths);
    } else if (msg.type === "unstage") {
      void runWorkingTreeOperation(this, "unstage", msg.paths);
    } else if (msg.type === "discard") {
      void vscode.commands.executeCommand("gitSimpleCompare.discard", msg.paths);
    } else if (msg.type === "addToGitignore") {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.addToGitignore",
        msg.paths
      );
    } else if (msg.type === "addToExclude") {
      void vscode.commands.executeCommand("gitSimpleCompare.addToExclude", msg.paths);
    } else if (msg.type === "commitMessageChange") {
      // 입력 중에는 저장만 하고 다시 그리지 않는다(타이핑 방해 방지).
      this.commitMessage = msg.message ?? "";
    } else if (msg.type === "commit") {
      // 직전 키 입력이 누락되지 않도록 보낸 메시지로 먼저 동기화한 뒤 커밋한다.
      if (msg.message !== undefined) {
        this.commitMessage = msg.message;
      }
      void runCommitOperation(this.view?.webview, msg.op);
    } else if (msg.type === "splitCommits") {
      void vscode.commands.executeCommand("gitSimpleCompare.splitCommits", {
        path: msg.path,
        stage: msg.stage,
      });
    } else if (msg.type === "scmAction" && msg.action) {
      void vscode.commands.executeCommand("gitSimpleCompare.scmAction", msg.action);
    } else if (msg.type === "stashSelected") {
      void vscode.commands.executeCommand("gitSimpleCompare.stashSelected", msg.paths);
    } else if (msg.type === "applyStash" && msg.ref) {
      void vscode.commands.executeCommand("gitSimpleCompare.applyStash", msg.ref);
    } else if (msg.type === "popStash" && msg.ref) {
      void vscode.commands.executeCommand("gitSimpleCompare.popStash", msg.ref);
    } else if (msg.type === "dropStash" && msg.ref) {
      void vscode.commands.executeCommand("gitSimpleCompare.dropStash", {
        ref: msg.ref,
        message: msg.message,
      });
    } else if (msg.type === "branchStash" && msg.ref) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.branchStash",
        msg.ref
      );
    } else if (msg.type === "refreshWorktrees") {
      void vscode.commands.executeCommand("gitSimpleCompare.refreshWorktrees");
    } else if (msg.type === "openWorktree" && msg.path) {
      void vscode.commands.executeCommand("gitSimpleCompare.openWorktree", {
        repoRoot: msg.repoRoot,
        path: msg.path,
        isMain: msg.isMain,
        branch: msg.branch,
      });
    } else if (msg.type === "removeWorktree" && msg.repoRoot && msg.path) {
      void vscode.commands.executeCommand("gitSimpleCompare.removeWorktree", {
        repoRoot: msg.repoRoot,
        path: msg.path,
        isMain: msg.isMain,
        branch: msg.branch,
      });
    } else if (msg.type === "renameWorktree" && msg.repoRoot && msg.path) {
      void vscode.commands.executeCommand("gitSimpleCompare.renameWorktree", {
        repoRoot: msg.repoRoot,
        path: msg.path,
        isMain: msg.isMain,
        branch: msg.branch,
      });
    } else if (msg.type === "openStashFile" && msg.ref && msg.path) {
      void vscode.commands.executeCommand("gitSimpleCompare.openStashFile", {
        ref: msg.ref,
        path: msg.path,
      });
    } else if (msg.type === "openFileHistoryCommit" && msg.repoRoot &&
      msg.path && msg.baseRef && msg.headRef) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.openFileHistoryCommit",
        {
          repoRoot: msg.repoRoot,
          path: msg.path,
          oldPath: msg.oldPath,
          baseRef: msg.baseRef,
          headRef: msg.headRef,
          shortHash: msg.shortHash,
          title: msg.title,
        }
      );
    }
  }
}
