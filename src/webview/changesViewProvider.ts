// CHANGES 사이드바 뷰를 웹뷰(WebviewView)로 렌더링하는 프로바이더(아코디언 3섹션).
//   Repositories(저장소+브랜치) · Changes(커밋 박스 + Staged/Unstaged 그룹, Source Control
//   과 동일 성격, 미트볼 ... 메뉴 포함) · Compare Branches(From/To + 브랜치 비교 결과).
// - 상태를 보관하고 클릭은 등록된 명령/내부 메서드로 위임한다(경계 분리).
// - 커밋 메시지는 provider 가 보유한다(입력 중엔 저장만, 커밋 후 비우며 다시 그린다).
import * as fs from "fs";
import * as vscode from "vscode";
import { BranchComparison } from "../git/gitTypes";
import type { StatusGroups } from "../git/gitService";
import {
  ChangeDiffArgs,
  SortKey,
  ViewMode,
} from "../providers/changesTreeModel";
import type { RepoInfo } from "../commands/shared";
import { buildCommitMenu, buildScmMenu } from "../commands/scmActions";
import type { StashView } from "../commands/stash";
import { FileIconThemeResolver } from "./fileIconTheme";
import { changesWebviewI18n } from "./changesI18n";
import { buildChangesRenderPayload } from "./changesRenderPayload";
import {
  TREE_SECTIONS,
  VISIBLE_SECTIONS,
  type ComparisonDraft,
  type TreeSection,
  type ViewModes,
  type VisibleSection,
  type VisibleSections,
} from "./changesViewTypes";

export { VISIBLE_SECTIONS } from "./changesViewTypes";
export type {
  ComparisonDraft,
  TreeSection,
  VisibleSection,
} from "./changesViewTypes";

/** 보기 모드/정렬을 세션 간 유지하기 위한 저장 키 */
const VIEW_MODE_STATE = "gitSimpleCompare.viewMode";
const SORT_KEY_STATE = "gitSimpleCompare.sortKey";
const VISIBLE_SECTIONS_STATE = "gitSimpleCompare.visibleSections";

/**
 * CHANGES 웹뷰 뷰 프로바이더.
 */
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
  private commitMessage = "";
  private commitMessageRevision = 0;
  private viewModes: ViewModes;
  private sortKey: SortKey;
  private visibleSections: VisibleSections;
  private readonly fileIcons = new FileIconThemeResolver();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderPayloadJson = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento
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
    view.webview.html = this.buildHtml(view.webview);
    this.lastRenderPayloadJson = "";
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
      this.clearRenderTimer();
    });
  }

  // ---- 상태 API ----

  /**
   * 저장소 목록을 갱신한다. 활성 저장소가 목록에 없으면 첫 저장소로 맞춘다.
   * @param repos 저장소 정보 목록(루트 + 브랜치)
   */
  setRepositories(repos: RepoInfo[]): void {
    this.repositories = repos;
    if (!this.activeRepo || !repos.some((r) => r.root === this.activeRepo)) {
      this.activeRepo = repos[0]?.root;
    }
    this.render();
  }

  /** 현재 활성 저장소 루트(없으면 undefined). */
  getActiveRepo(): string | undefined {
    return this.activeRepo;
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

  /** 비교 컨텍스트를 교체하고 다시 그린다. */
  setComparison(comparison: BranchComparison): void {
    this.comparison = comparison;
    this.activeRepo = comparison.repoRoot;
    this.render();
  }

  /** 현재 비교 컨텍스트를 반환한다(없으면 undefined). */
  getComparison(): BranchComparison | undefined {
    return this.comparison;
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
      this.view.webview.html = this.buildHtml(this.view.webview);
    } else {
      this.render();
    }
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
    this.commitMessage = "";
    this.commitMessageRevision++;
    this.render();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshWorkingChanges");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshStashes");
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
      draft: this.draft,
      staged: this.staged,
      unstaged: this.unstaged,
      stashes: this.stashes,
      commitMessage: this.commitMessage,
      commitMessageRevision: this.commitMessageRevision,
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

  /**
   * 웹뷰 메시지를 처리한다. 동작은 등록된 명령/내부 메서드로 위임한다.
   * @param msg 웹뷰 메시지
   */
  private handleMessage(msg: {
    type: string;
    side?: "from" | "to";
    path?: string;
    root?: string;
    section?: string;
    paths?: string[];
    message?: string;
    op?: string;
    action?: string;
    ref?: string;
    stage?: string;
    status?: string;
  }): void {
    if (msg.type === "ready") {
      this.render();
    } else if (msg.type === "selectRepo" && msg.root) {
      this.selectRepo(msg.root);
    } else if (msg.type === "changeRef" && msg.side) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.changeComparisonRef",
        msg.side
      );
    } else if (msg.type === "runCompare") {
      void vscode.commands.executeCommand("gitSimpleCompare.runComparison");
    } else if (msg.type === "toggleViewMode" && msg.section) {
      // 섹션 헤더의 트리/리스트 토글 — 해당 섹션만 뒤집는다(다른 섹션과 독립).
      // 토글 후 툴바 컨텍스트 키도 갱신하도록 명령에 위임한다.
      void vscode.commands.executeCommand(
        "gitSimpleCompare.toggleSectionViewMode",
        msg.section
      );
    } else if (msg.type === "openDiff" && msg.path && this.comparison) {
      const change = this.comparison.changes.find((c) => c.path === msg.path);
      if (change) {
        const args: ChangeDiffArgs = { comparison: this.comparison, change };
        void vscode.commands.executeCommand("gitSimpleCompare.openChangeDiff", args);
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
      void vscode.commands.executeCommand("gitSimpleCompare.stage", msg.paths);
    } else if (msg.type === "unstage") {
      void vscode.commands.executeCommand("gitSimpleCompare.unstage", msg.paths);
    } else if (msg.type === "discard") {
      void vscode.commands.executeCommand("gitSimpleCompare.discard", msg.paths);
    } else if (msg.type === "addToGitignore") {
      void vscode.commands.executeCommand("gitSimpleCompare.addToGitignore", msg.paths);
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
      void vscode.commands.executeCommand("gitSimpleCompare.commit", msg.op);
    } else if (msg.type === "generateCommitMessage") {
      void vscode.commands.executeCommand("gitSimpleCompare.generateCommitMessage");
    } else if (msg.type === "configureAiCli") {
      void vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
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
    } else if (msg.type === "openStashFile" && msg.ref && msg.path) {
      void vscode.commands.executeCommand("gitSimpleCompare.openStashFile", {
        ref: msg.ref,
        path: msg.path,
      });
    }
  }

  /** 웹뷰 HTML 을 만든다(CSP + nonce + codicon + 지역화 문자열 주입). */
  private buildHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "changes");
    const version = mediaVersion(mediaRoot);
    const scriptUri = webview.asWebviewUri(
      withVersion(vscode.Uri.joinPath(mediaRoot, "changes.js"), version)
    );
    const aiScriptUri = webview.asWebviewUri(
      withVersion(vscode.Uri.joinPath(mediaRoot, "changesAi.js"), version)
    );
    const styleUri = webview.asWebviewUri(
      withVersion(vscode.Uri.joinPath(mediaRoot, "changes.css"), version)
    );
    const codiconUri = webview.asWebviewUri(
      withVersion(
        vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css"),
        version
      )
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`, `img-src data:`,
      `style-src ${webview.cspSource}`, `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // 웹뷰는 vscode.l10n 을 쓸 수 없으므로 지역화 문자열을 주입한다.
    const i18n = changesWebviewI18n();

    // 미트볼(...)·커밋 캐럿 메뉴 구성(라벨은 지역화). 웹뷰가 이 데이터로 드롭다운을 그린다.
    const menu = buildScmMenu();
    const commitMenu = buildCommitMenu();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Changes</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gscI18n=${JSON.stringify(
    i18n
  )};window.__gscMenu=${JSON.stringify(
    menu
  )};window.__gscCommitMenu=${JSON.stringify(commitMenu)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${aiScriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * 저장된 보기 모드를 섹션별 묶음으로 정규화한다.
 * - 구버전(단일 전역 문자열 "tree"/"list")은 두 섹션에 동일하게 적용해 호환한다.
 * - 신버전(섹션별 객체)은 알 수 없는 값이면 "tree" 로 보정한다.
 * @param saved memento 에 저장돼 있던 원본 값(형식 불명)
 */
function loadViewModes(saved: unknown): ViewModes {
  if (saved === "tree" || saved === "list") {
    return { compare: saved, changes: saved };
  }
  if (saved && typeof saved === "object") {
    const s = saved as Partial<ViewModes>;
    return {
      compare: s.compare === "list" ? "list" : "tree",
      changes: s.changes === "list" ? "list" : "tree",
    };
  }
  return { compare: "tree", changes: "tree" };
}

/** 저장된 아코디언 섹션 표시 상태를 정규화한다. */
function loadVisibleSections(saved: unknown): VisibleSections {
  const result = {} as VisibleSections;
  const raw = saved && typeof saved === "object"
    ? (saved as Partial<VisibleSections>)
    : {};
  for (const section of VISIBLE_SECTIONS) {
    result[section] = raw[section] !== false;
  }
  if (!VISIBLE_SECTIONS.some((section) => result[section])) {
    result.changes = true;
  }
  return result;
}

/**
 * 웹뷰 정적 리소스 캐시를 깨기 위한 버전 문자열을 만든다.
 * @param mediaRoot `media/changes` 디렉터리 URI
 */
function mediaVersion(mediaRoot: vscode.Uri): string {
  return String(
    Math.max(
      fileMtime(vscode.Uri.joinPath(mediaRoot, "changes.js")),
      fileMtime(vscode.Uri.joinPath(mediaRoot, "changesAi.js")),
      fileMtime(vscode.Uri.joinPath(mediaRoot, "changes.css"))
    )
  );
}

/**
 * URI 에 query 버전을 붙여 VS Code 웹뷰의 정적 리소스 캐시를 회피한다.
 * @param uri 원본 리소스 URI
 * @param version 캐시 구분용 버전 문자열
 */
function withVersion(uri: vscode.Uri, version: string): vscode.Uri {
  return uri.with({ query: `v=${version}` });
}

/**
 * 파일 수정 시각을 읽는다. 실패하면 현재 시각을 써서 캐시에 갇히지 않게 한다.
 * @param uri 로컬 파일 URI
 */
function fileMtime(uri: vscode.Uri): number {
  try {
    return fs.statSync(uri.fsPath).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** CSP 의 script nonce(1회성 난수 문자열)를 만든다. */
function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
