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
import { ConflictMarkerDecoratorController } from "./providers/conflictMarkerDecoratorController";
import { PullRequestCommentController } from "./providers/pullRequestCommentController";
import { VscodeGitStatusProvider } from "./providers/vscodeGitStatusProvider";
import { COMPARE_SCHEME } from "./utils/uri";
import { registerCommands } from "./commands";
import { CommandDeps } from "./commands/shared";
import { syncViewContext } from "./commands/viewState";
import { disposeOutputLog, logInfo } from "./ui/outputLog";
import { disposePullRequestDiffComments } from "./ui/pullRequestDiffComments";
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
  context.subscriptions.push(new vscode.Disposable(disposePullRequestDiffComments));

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
  const conflictsTree = vscode.window.createTreeView("gitSimpleCompare.conflicts", {
    treeDataProvider: conflictsProvider,
  });
  context.subscriptions.push(conflictsTree);
  let conflictsVisible = conflictsTree.visible;
  const conflicts = new ConflictsController(registry, conflictsProvider);
  const hunkCheckboxes = new HunkCheckboxController(registry);
  context.subscriptions.push(hunkCheckboxes.register());
  const conflictMarkerDecorations = new ConflictMarkerDecoratorController(registry);
  context.subscriptions.push(conflictMarkerDecorations.register());
  const blameDecorations = new BlameDecoratorController(registry);
  context.subscriptions.push(blameDecorations.register());
  const prCommentDecorations = new PullRequestCommentController(registry);
  context.subscriptions.push(prCommentDecorations.register());
  const nativeDiffOverlay = new NativeDiffOverlayController(
    context.globalStorageUri,
    hunkCheckboxes
  );
  context.subscriptions.push(nativeDiffOverlay.register());
  let scheduleRefresh: (reason: string, delay?: number) => void = () => undefined;
  const vscodeGitStatus = new VscodeGitStatusProvider((reason) => {
    if (!changesView.isVisible() && !conflictsVisible) {
      return;
    }
    scheduleRefresh(reason);
  });
  context.subscriptions.push(vscodeGitStatus);

  // 5) 명령 등록(핸들러는 commands 모듈에 위임)
  const deps: CommandDeps = {
    registry,
    changesView,
    extensionUri: context.extensionUri,
    conflicts,
    hunkCheckboxes,
    blameDecorations,
    vscodeGitStatus,
  };
  for (const disposable of registerCommands(deps)) {
    context.subscriptions.push(disposable);
  }

  // 6) "좌→우 반영" 버튼 노출용 컨텍스트 키 추적기 등록
  context.subscriptions.push(registerActiveDiffTracker());

  // 7) view/title 토글 버튼이 현재 보기 모드를 반영하도록 컨텍스트 키 초기화
  syncViewContext(deps);

  // 8) Git 메타데이터/VS Code Git 상태 이벤트에 맞춰 보이는 뷰만 갱신한다.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshReason = "startup";
  const pendingGraphRefreshRoots = new Set<string>();
  const refreshEverything = (reason: string): void => {
    const changesVisible = changesView.isVisible();
    logInfo("refresh requested", {
      reason,
      changesVisible,
      conflictsVisible,
    });
    for (const repoRoot of pendingGraphRefreshRoots) {
      GitGraphPanel.refreshOpen(repoRoot, reason);
    }
    pendingGraphRefreshRoots.clear();
    prCommentDecorations.refresh(reason);
    if (conflictsVisible) {
      void conflicts.refresh();
    }
    if (changesVisible) {
      void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason,
      });
    }
  };
  scheduleRefresh = (reason: string, delay = 180): void => {
    refreshReason = refreshTimer ? `${refreshReason},${reason}` : reason;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const reason = refreshReason;
      refreshReason = "scheduled";
      refreshEverything(reason);
    }, delay);
  };
  const refreshFileHistoryIfVisible = (reason: string): void => {
    if (!changesView.isVisible()) {
      return;
    }
    void vscode.commands.executeCommand("gitSimpleCompare.refreshFileHistory", {
      reason,
    });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() =>
      refreshFileHistoryIfVisible("activeEditor")
    )
  );
  type RefreshWatcherHandler = (
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ) => void;
  /** watcher 의 create/change/delete 이벤트를 같은 refresh handler 에 연결한다. */
  const watchRefresh = (
    watcher: vscode.FileSystemWatcher,
    handler: RefreshWatcherHandler
  ): void => {
    watcher.onDidCreate(
      (uri) => handler("create", uri),
      undefined,
      context.subscriptions
    );
    watcher.onDidChange(
      (uri) => handler("change", uri),
      undefined,
      context.subscriptions
    );
    watcher.onDidDelete(
      (uri) => handler("delete", uri),
      undefined,
      context.subscriptions
    );
  };
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.git/{HEAD,refs/**,packed-refs,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**,worktrees/**,info/exclude}"
  );
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.gitignore"
  );
  const scheduleRefreshForGitUri = (
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ): void => {
    const decision = shouldRefreshForGitUri(uri);
    if (!decision.refresh) {
      if (shouldLogIgnoredRefresh(decision.reason)) {
        logInfo("refresh event ignored", {
          source: "git",
          event,
          path: uri.fsPath,
          reason: decision.reason,
        });
      }
      return;
    }
    registry.invalidateStatusCaches();
    if (decision.reason !== "ignore-rules") {
      clearBranchContentCache();
      const repoRoot = repoRootFromGitUri(uri);
      if (repoRoot) {
        pendingGraphRefreshRoots.add(repoRoot);
      }
    }
    scheduleRefresh(`git:${event}:${decision.reason}`);
  };
  const scheduleRefreshForIgnoreUri = (
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ): void => {
    logInfo("ignore rules refresh requested", { event, path: uri.fsPath });
    registry.invalidateStatusCaches();
    scheduleRefresh(`working-tree-file:${event}:ignore-rules`, 0);
  };
  watchRefresh(gitWatcher, scheduleRefreshForGitUri);
  watchRefresh(gitignoreWatcher, scheduleRefreshForIgnoreUri);
  context.subscriptions.push(
    gitWatcher,
    gitignoreWatcher,
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    }),
    conflictsTree.onDidChangeVisibility((event) => {
      conflictsVisible = event.visible;
      if (event.visible) {
        void conflicts.refresh();
      }
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
 * `.git` 파일 시스템 이벤트가 refresh 로 이어져야 하는지 판정한다.
 * - 작업트리 파일 변경은 VS Code 내장 Git 상태 이벤트에 맡기고, 여기서는 ref/HEAD/merge 상태처럼
 *   그래프와 가상 문서 캐시에 직접 영향을 주는 안정적인 Git 메타데이터만 본다.
 * @param uri 변경된 `.git` 내부 파일 URI
 */
function shouldRefreshForGitUri(uri: vscode.Uri): RefreshDecision {
  const path = uri.fsPath.replace(/\\/g, "/");
  if (isGitExcludePath(path)) {
    return { refresh: true, reason: "ignore-rules" };
  }
  return isStableGitStatePath(path)
    ? { refresh: true, reason: "stable-git-state" }
    : { refresh: false, reason: "volatile-git-state" };
}

/**
 * 무시한 파일 이벤트 중 OUTPUT 에 남길 가치가 있는 것만 고른다.
 * - `.git`/fsmonitor cookie 는 git/VS Code 가 자주 만드는 정상 이벤트라 로그만 과도해진다.
 * @param reason shouldRefreshForGitUri 가 반환한 무시 사유
 */
function shouldLogIgnoredRefresh(reason: string): boolean {
  return reason !== "volatile-git-state";
}

/**
 * `.git` 내부 이벤트 중 refresh 가치가 있는 안정적인 상태 파일인지 확인한다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 */
function isStableGitStatePath(path: string): boolean {
  return /\/\.git\/(HEAD|packed-refs|refs\/|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge\/|rebase-apply\/|worktrees\/)/.test(
    path
  );
}

/**
 * `.git/info/exclude` 변경인지 확인한다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 */
function isGitExcludePath(path: string): boolean {
  return /\/\.git\/info\/exclude$/.test(path);
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
