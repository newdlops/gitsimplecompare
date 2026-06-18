// 확장 활성화 진입점.
// - 여기서는 각 모듈을 조립(생성·등록)하고 정리(dispose)만 책임진다.
//   실제 기능 로직은 git/providers/ui/commands 모듈에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitServiceRegistry } from "./git/serviceRegistry";
import {
  BranchContentProvider,
  clearBranchContentCache,
} from "./providers/branchContentProvider";
import { ChangesViewProvider } from "./webview/changesViewProvider";
import { registerActiveDiffTracker } from "./providers/activeDiffTracker";
import { ConflictsTreeProvider } from "./providers/conflictsTreeProvider";
import { ConflictsController } from "./providers/conflictsController";
import { HunkCheckboxController } from "./providers/hunkCheckboxController";
import { NativeDiffOverlayController } from "./providers/nativeDiffOverlayController";
import { BlameDecoratorController } from "./providers/blameDecoratorController";
import {
  isAnyDiffOpenInProgress,
  onDidEndDiffOpen,
} from "./providers/diffOpenGate";
import { COMPARE_SCHEME } from "./utils/uri";
import { registerCommands } from "./commands";
import { CommandDeps } from "./commands/shared";
import { syncViewContext } from "./commands/viewState";
import { disposeOutputLog, logInfo } from "./ui/outputLog";
import { GitGraphPanel } from "./webview/graphPanel";

/**
 * 확장이 활성화될 때 호출된다.
 * - 공유 인스턴스를 만들고, 가상 문서 프로바이더/트리뷰/명령/추적기를 등록한 뒤
 *   모든 Disposable 을 context.subscriptions 에 모아 자동 정리되게 한다.
 * @param context VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext): void {
  logInfo("extension activating", {
    workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0,
  });
  context.subscriptions.push(new vscode.Disposable(disposeOutputLog));

  // 1) 저장소별 GitService 를 공유하는 레지스트리
  const registry = new GitServiceRegistry();

  // 2) 특정 ref 의 파일 내용을 읽기 전용 가상 문서로 제공
  const contentProvider = new BranchContentProvider(registry);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      COMPARE_SCHEME,
      contentProvider
    )
  );

  // 3) 브랜치 비교 결과를 보여줄 CHANGES 웹뷰(보기 모드/정렬은 globalState 에 보존)
  const changesView = new ChangesViewProvider(
    context.extensionUri,
    context.globalState
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChangesViewProvider.viewId,
      changesView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 4) 충돌 해결 뷰 + 컨트롤러
  const conflictsProvider = new ConflictsTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView("gitSimpleCompare.conflicts", {
      treeDataProvider: conflictsProvider,
    })
  );
  const conflicts = new ConflictsController(registry, conflictsProvider);
  const hunkCheckboxes = new HunkCheckboxController(registry);
  context.subscriptions.push(hunkCheckboxes.register());
  const blameDecorations = new BlameDecoratorController(registry);
  context.subscriptions.push(blameDecorations.register());
  const nativeDiffOverlay = new NativeDiffOverlayController(
    context.globalStorageUri,
    hunkCheckboxes
  );
  context.subscriptions.push(nativeDiffOverlay.register());

  // 5) 명령 등록(핸들러는 commands 모듈에 위임)
  const deps: CommandDeps = {
    registry,
    changesView,
    extensionUri: context.extensionUri,
    conflicts,
    hunkCheckboxes,
    blameDecorations,
  };
  for (const disposable of registerCommands(deps)) {
    context.subscriptions.push(disposable);
  }

  // 6) "좌→우 반영" 버튼 노출용 컨텍스트 키 추적기 등록
  context.subscriptions.push(registerActiveDiffTracker());

  // 7) view/title 토글 버튼이 현재 보기 모드를 반영하도록 컨텍스트 키 초기화
  syncViewContext(deps);

  // 8) 충돌/작업변경/stash/브랜치 비교를 초기화하고 파일·git 변경 이벤트에 맞춰 갱신한다.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshReason = "startup";
  let deferredDiffOpenRefresh = false;
  const pendingGraphRefreshRoots = new Set<string>();
  const refreshEverything = (reason: string): void => {
    logInfo("refresh requested", { reason });
    for (const repoRoot of pendingGraphRefreshRoots) {
      GitGraphPanel.refreshOpen(repoRoot, reason);
    }
    pendingGraphRefreshRoots.clear();
    void conflicts.refresh();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason,
    });
  };
  const scheduleRefresh = (reason: string, delay = 180): void => {
    refreshReason = refreshTimer ? `${refreshReason},${reason}` : reason;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const reason = refreshReason;
      refreshReason = "scheduled";
      if (isAnyDiffOpenInProgress() && isWorkingTreeRefreshReason(reason)) {
        deferredDiffOpenRefresh = true;
        logInfo("refresh timer skipped", { reason, active: "diffOpen" });
        return;
      }
      refreshEverything(reason);
    }, delay);
  };
  const watchRefresh = (
    watcher: vscode.FileSystemWatcher,
    source: "workspace" | "git"
  ): void => {
    watcher.onDidCreate(
      (uri) => scheduleRefreshForUri(source, "create", uri),
      undefined,
      context.subscriptions
    );
    watcher.onDidChange(
      (uri) => scheduleRefreshForUri(source, "change", uri),
      undefined,
      context.subscriptions
    );
    watcher.onDidDelete(
      (uri) => scheduleRefreshForUri(source, "delete", uri),
      undefined,
      context.subscriptions
    );
  };
  void conflicts.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "startup",
  });
  const workspaceWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.git/{HEAD,refs/**,packed-refs,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}"
  );
  const scheduleRefreshForUri = (
    source: "workspace" | "git",
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ): void => {
    if (source === "workspace" && isAnyDiffOpenInProgress()) {
      deferredDiffOpenRefresh = true;
      return;
    }
    const decision = shouldRefreshForUri(source, uri);
    if (!decision.refresh) {
      if (shouldLogIgnoredRefresh(decision.reason)) {
        logInfo("refresh event ignored", {
          source,
          event,
          path: uri.fsPath,
          reason: decision.reason,
        });
      }
      return;
    }
    registry.invalidateStatusCaches();
    if (source === "git") {
      clearBranchContentCache();
      const repoRoot = repoRootFromGitUri(uri);
      if (repoRoot) {
        pendingGraphRefreshRoots.add(repoRoot);
      }
    }
    scheduleRefresh(`${source}:${event}:${decision.reason}`);
  };
  watchRefresh(workspaceWatcher, "workspace");
  watchRefresh(gitWatcher, "git");
  context.subscriptions.push(
    workspaceWatcher,
    gitWatcher,
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      registry.invalidateStatusCaches();
      scheduleRefresh("documentSaved");
    }),
    vscode.workspace.onDidCreateFiles(() => {
      registry.invalidateStatusCaches();
      scheduleRefresh("filesCreated");
    }),
    vscode.workspace.onDidDeleteFiles(() => {
      registry.invalidateStatusCaches();
      scheduleRefresh("filesDeleted");
    }),
    vscode.workspace.onDidRenameFiles(() => {
      registry.invalidateStatusCaches();
      scheduleRefresh("filesRenamed");
    }),
    onDidEndDiffOpen(() => {
      if (!deferredDiffOpenRefresh) {
        return;
      }
      deferredDiffOpenRefresh = false;
      logInfo("diff open refresh skipped", { reason: "deferredWorkspaceEvents" });
    })
  );

  // 9) 워크스페이스 폴더가 바뀌면 저장소 목록부터 다시 찾는다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registry.invalidateResolveCache();
      registry.invalidateStatusCaches();
      clearBranchContentCache();
      scheduleRefresh("workspaceFolders", 0);
    })
  );

  // 10) 파일 아이콘/색상 테마가 바뀌면 Changes 웹뷰의 파일 아이콘도 다시 그린다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("workbench.iconTheme")) {
        logInfo("file icon theme changed");
        changesView.refresh();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      logInfo("color theme changed");
      changesView.refresh();
    })
  );
  logInfo("extension activated");
}

/**
 * 확장이 비활성화될 때 호출된다.
 * - 모든 리소스는 context.subscriptions 로 정리되므로 별도 처리는 없다.
 */
export function deactivate(): void {
  // 정리할 추가 리소스 없음.
}

interface RefreshDecision {
  refresh: boolean;
  reason: string;
}

/**
 * 파일 시스템 이벤트가 Changes refresh 로 이어져야 하는지 판정한다.
 * - 작업 파일 변경은 빠르게 반영하되, git status 가 만지는 `.git/index`, 빌드 산출물,
 *   로컬 인덱서 캐시처럼 refresh 자체와 무관한 대량 변경 경로는 제외해 로딩 루프를 막는다.
 * @param source 이벤트를 발생시킨 watcher 종류
 * @param uri    변경된 파일 URI
 */
function shouldRefreshForUri(
  source: "workspace" | "git",
  uri: vscode.Uri
): RefreshDecision {
  const path = uri.fsPath.replace(/\\/g, "/");
  if (source === "workspace") {
    const ignored = ignoredWorkspaceSegment(path);
    return ignored
      ? { refresh: false, reason: ignored }
      : { refresh: true, reason: "working-tree-file" };
  }
  return isStableGitStatePath(path)
    ? { refresh: true, reason: "stable-git-state" }
    : { refresh: false, reason: "volatile-git-state" };
}

/**
 * 무시한 파일 이벤트 중 OUTPUT 에 남길 가치가 있는 것만 고른다.
 * - `.git`/fsmonitor cookie 는 git/VS Code 가 자주 만드는 정상 이벤트라 로그만 과도해진다.
 * @param reason shouldRefreshForUri 가 반환한 무시 사유
 */
function shouldLogIgnoredRefresh(reason: string): boolean {
  return reason !== ".git" && reason !== "volatile-git-state";
}

/**
 * 작업 파일 watcher 에서 무시할 경로 세그먼트를 찾는다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 * @returns 무시 사유 또는 undefined
 */
function ignoredWorkspaceSegment(path: string): string | undefined {
  const segments = path.split("/");
  for (const segment of [".git", "node_modules", "dist", "out", ".vscode-test", ".codeidx", ".zoek-rs", ".lh"]) {
    if (segments.includes(segment)) {
      return segment;
    }
  }
  return undefined;
}

/**
 * `.git` 내부 이벤트 중 refresh 가치가 있는 안정적인 상태 파일인지 확인한다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 */
function isStableGitStatePath(path: string): boolean {
  return /\/\.git\/(HEAD|packed-refs|refs\/|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge\/|rebase-apply\/)/.test(
    path
  );
}

/**
 * `.git` 내부 파일 이벤트에서 저장소 루트 경로를 꺼낸다.
 * @param uri `.git/HEAD` 또는 `.git/refs/**` 아래에서 발생한 파일 이벤트 URI
 * @returns 저장소 루트 절대 경로, `.git` 내부 이벤트가 아니면 undefined
 */
function repoRootFromGitUri(uri: vscode.Uri): string | undefined {
  const path = uri.fsPath.replace(/\\/g, "/");
  const marker = "/.git/";
  const index = path.indexOf(marker);
  return index >= 0 ? uri.fsPath.slice(0, index) : undefined;
}

/** diff open 중에는 작업트리 refresh 를 건너뛸 수 있는지 확인한다. */
function isWorkingTreeRefreshReason(reason: string): boolean {
  return (
    reason.includes("working-tree-file") ||
    reason.includes("documentSaved") ||
    reason.includes("filesCreated") ||
    reason.includes("filesDeleted") ||
    reason.includes("filesRenamed")
  );
}
