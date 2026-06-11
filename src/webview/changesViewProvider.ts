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
  buildNodes,
} from "../providers/changesTreeModel";
import type { RepoInfo } from "../commands/shared";
import { buildCommitMenu, buildScmMenu } from "../commands/scmActions";
import type { StashView } from "../commands/stash";
import { FileIconThemeResolver } from "./fileIconTheme";

/** 보기 모드/정렬을 세션 간 유지하기 위한 저장 키 */
const VIEW_MODE_STATE = "gitSimpleCompare.viewMode";
const SORT_KEY_STATE = "gitSimpleCompare.sortKey";

/** 트리/리스트 보기를 가지는 섹션(Repositories 는 제외). */
export type TreeSection = "compare" | "changes";

/** 섹션별 보기 모드 묶음 — 섹션마다 트리/리스트를 따로 둔다. */
type ViewModes = Record<TreeSection, ViewMode>;

/** 트리 섹션 식별자 목록(순회·기본값 생성용). */
const TREE_SECTIONS: TreeSection[] = ["compare", "changes"];

/** 비교 실행 전, 사용자가 설정 중인 from/to 초안 */
export interface ComparisonDraft {
  from?: string;
  to?: string;
}

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
  private viewModes: ViewModes;
  private sortKey: SortKey;
  private readonly fileIcons = new FileIconThemeResolver();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento
  ) {
    this.viewModes = loadViewModes(memento.get(VIEW_MODE_STATE));
    this.sortKey = memento.get<SortKey>(SORT_KEY_STATE, "path");
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
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
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
    this.render();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshWorkingChanges");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshStashes");
  }

  /** 현재 상태로 렌더 payload 를 만들어 웹뷰로 보낸다. */
  private render(): void {
    if (!this.view) {
      return;
    }
    const payload = {
      repos: this.repositories.map((r) => ({
        root: r.root,
        name: baseName(r.root),
        branch: r.branch,
        active: r.root === this.activeRepo,
      })),
      compare: {
        mode: this.comparison ? ("comparison" as const) : ("draft" as const),
        from: this.comparison ? this.comparison.base : this.draft.from ?? "",
        to: this.comparison ? this.comparison.target : this.draft.to ?? "",
        viewMode: this.viewModes.compare,
        nodes: this.comparison
          ? buildNodes(
              this.comparison.changes,
              this.viewModes.compare,
              this.sortKey
            )
          : [],
      },
      changes: {
        viewMode: this.viewModes.changes,
        staged: buildNodes(this.staged, this.viewModes.changes, this.sortKey),
        unstaged: buildNodes(
          this.unstaged,
          this.viewModes.changes,
          this.sortKey
        ),
      },
      commit: {
        message: this.commitMessage,
        branch: this.repositories.find((r) => r.root === this.activeRepo)
          ?.branch,
        hasRepo: !!this.activeRepo,
      },
      stashes: this.stashes.map((s) => ({
        ref: s.ref,
        hash: s.hash,
        message: s.message,
        branch: s.branch,
        date: s.relativeDate,
        files: s.files,
      })),
      fileIcons: this.fileIcons.payloadFor(this.collectFilePaths()),
    };
    void this.view.webview.postMessage({ type: "render", payload });
  }

  /** 현재 웹뷰 payload 에 포함되는 모든 파일 경로를 모은다(아이콘 테마 해석용). */
  private collectFilePaths(): string[] {
    return [
      ...(this.comparison?.changes.map((c) => c.path) ?? []),
      ...this.staged.map((c) => c.path),
      ...this.unstaged.map((c) => c.path),
      ...this.stashes.flatMap((s) => s.files.map((f) => f.path)),
    ];
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
        void vscode.commands.executeCommand(
          "gitSimpleCompare.openChangeDiff",
          args
        );
      }
    } else if (msg.type === "openWorkingChange" && msg.path && this.activeRepo) {
      void vscode.commands.executeCommand("gitSimpleCompare.openWorkingChange", {
        root: this.activeRepo,
        path: msg.path,
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
    } else if (msg.type === "commitMessageChange") {
      // 입력 중에는 저장만 하고 다시 그리지 않는다(타이핑 방해 방지).
      this.commitMessage = msg.message ?? "";
    } else if (msg.type === "commit") {
      // 직전 키 입력이 누락되지 않도록 보낸 메시지로 먼저 동기화한 뒤 커밋한다.
      if (msg.message !== undefined) {
        this.commitMessage = msg.message;
      }
      void vscode.commands.executeCommand("gitSimpleCompare.commit", msg.op);
    } else if (msg.type === "scmAction" && msg.action) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.scmAction",
        msg.action
      );
    } else if (msg.type === "stashSelected") {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.stashSelected",
        msg.paths
      );
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
      `default-src 'none'`,
      `img-src data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // 웹뷰는 vscode.l10n 을 쓸 수 없으므로 지역화 문자열을 주입한다.
    const i18n = {
      repositories: vscode.l10n.t("Repositories"),
      compareBranches: vscode.l10n.t("Compare Branches"),
      changes: vscode.l10n.t("Changes"),
      current: vscode.l10n.t("current"),
      from: vscode.l10n.t("From:"),
      to: vscode.l10n.t("To:"),
      selectBranch: vscode.l10n.t("(select a branch)"),
      compare: vscode.l10n.t("Compare"),
      noCompare: vscode.l10n.t("No changes between the selected branches."),
      noChanges: vscode.l10n.t("No working tree changes."),
      noRepos: vscode.l10n.t("No git repository found."),
      change: vscode.l10n.t("Change branch"),
      viewAsTree: vscode.l10n.t("View as Tree"),
      viewAsList: vscode.l10n.t("View as List"),
      stagedChanges: vscode.l10n.t("Staged Changes"),
      commitPlaceholder: vscode.l10n.t("Message (Ctrl+Enter to commit)"),
      commit: vscode.l10n.t("Commit"),
      moreActions: vscode.l10n.t("More Actions..."),
      stage: vscode.l10n.t("Stage Changes"),
      unstage: vscode.l10n.t("Unstage Changes"),
      discard: vscode.l10n.t("Discard Changes"),
      stageAll: vscode.l10n.t("Stage All Changes"),
      unstageAll: vscode.l10n.t("Unstage All Changes"),
      discardAll: vscode.l10n.t("Discard All Changes"),
      openFile: vscode.l10n.t("Open File"),
      openChanges: vscode.l10n.t("Open Changes"),
      stashes: vscode.l10n.t("Stashes"),
      noStashes: vscode.l10n.t("No stashes."),
      stashSelected: vscode.l10n.t("Stash Selected Changes"),
      applyStash: vscode.l10n.t("Apply Stash"),
      popStash: vscode.l10n.t("Pop Stash"),
      dropStash: vscode.l10n.t("Drop Stash"),
      branchStash: vscode.l10n.t("Create Branch from Stash"),
    };

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

/**
 * 웹뷰 정적 리소스 캐시를 깨기 위한 버전 문자열을 만든다.
 * @param mediaRoot `media/changes` 디렉터리 URI
 */
function mediaVersion(mediaRoot: vscode.Uri): string {
  return String(
    Math.max(
      fileMtime(vscode.Uri.joinPath(mediaRoot, "changes.js")),
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

/** 경로에서 마지막 세그먼트(저장소 폴더명)를 뽑는다. */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
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
