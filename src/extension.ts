// 확장 활성화 진입점.
// - 여기서는 각 모듈을 조립(생성·등록)하고 정리(dispose)만 책임진다.
//   실제 기능 로직은 git/providers/ui/commands 모듈에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitServiceRegistry } from "./git/serviceRegistry";
import {
  BranchContentProvider,
  clearBranchContentCache,
  disposeBranchContentCache,
  releaseBranchContentDocument,
} from "./providers/branchContentProvider";
import { ChangesViewProvider } from "./webview/changesViewProvider";
import { registerActiveDiffTracker } from "./providers/activeDiffTracker";
import { ConflictsTreeProvider } from "./providers/conflictsTreeProvider";
import { ConflictsController } from "./providers/conflictsController";
import { HunkCheckboxController } from "./providers/hunkCheckboxController";
import { NativeDiffOverlayController } from "./providers/nativeDiffOverlayController";
import { BlameDecoratorController } from "./providers/blameDecoratorController";
import { ConflictMarkerDecoratorController } from "./providers/conflictMarkerDecoratorController";
import {
  CONFLICT_OVERLAY_SCHEME,
  CONFLICT_READONLY_SCHEME,
  ConflictEditorOverlayController,
} from "./providers/conflictEditorOverlayController";
import { ConflictOverlayCodeLensProvider } from "./providers/conflictOverlayCodeLensProvider";
import { ConflictEditorActions } from "./commands/conflictEditorActions";
import { PullRequestCommentController } from "./providers/pullRequestCommentController";
import { ComparisonController } from "./providers/comparisonController";
import {
  resolveComparisonRefIdentity,
  type ComparisonSnapshot,
} from "./git/comparisonService";
import { registerComparisonFileDecorations } from "./providers/comparisonFileDecorations";
import {
  ComparisonScmProvider,
  DeletedComparisonGutterController,
} from "./providers/comparisonScmProvider";
import { VscodeGitStatusProvider } from "./providers/vscodeGitStatusProvider";
import { registerLocalChangesWatcher } from "./providers/localChangesWatcher";
import { connectRefreshWatcher } from "./providers/refreshWatcher";
import { COMPARE_SCHEME } from "./utils/uri";
import { registerCommands } from "./commands";
import { CommandDeps } from "./commands/shared";
import { syncViewContext } from "./commands/viewState";
import { disposeOutputLog, logError, logInfo } from "./ui/outputLog";
import { disposePullRequestDiffComments } from "./ui/pullRequestDiffComments";
import { GitGraphPanel } from "./webview/graphPanel";
import {
  addRefreshReasons,
  HiddenRepositoryRefreshFence,
  repoRootFromGitPath,
  shouldLogIgnoredRefresh,
  shouldRefreshExplorerComparison,
  shouldRefreshPullRequestComments,
  shouldRefreshForGitPath,
} from "./utils/extensionRefreshPolicy";
import type { GitSimpleCompareApi } from "./extensionApi";
export type { GitSimpleCompareApi } from "./extensionApi";

let activeNativeDiffOverlay: NativeDiffOverlayController | undefined;

/**
 * 확장이 활성화될 때 호출된다.
 * - 공유 인스턴스를 만들고, 가상 문서 프로바이더/명령/추적기를 등록한 뒤
 *   모든 Disposable 을 context.subscriptions 에 모아 자동 정리되게 한다.
 * @param context VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext): GitSimpleCompareApi {
  logInfo("extension activating", {
    workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0,
  });
  context.subscriptions.push(new vscode.Disposable(disposeOutputLog));
  context.subscriptions.push(new vscode.Disposable(disposePullRequestDiffComments));
  context.subscriptions.push(new vscode.Disposable(disposeBranchContentCache));

  // 1) 저장소별 GitService 를 공유하는 레지스트리
  const registry = new GitServiceRegistry();
  const comparison = new ComparisonController();
  context.subscriptions.push(comparison);

  // 2) 특정 ref 의 파일 내용을 읽기 전용 가상 문서로 제공
  const contentProvider = new BranchContentProvider(registry);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      COMPARE_SCHEME,
      contentProvider
    ),
    vscode.workspace.onDidCloseTextDocument((document) => {
      releaseBranchContentDocument(document.uri);
    })
  );

  // 3) 선택한 브랜치/원격/PR 비교를 Explorer, 탭, SCM Quick Diff 에 함께 투영
  const comparisonScm = new ComparisonScmProvider(comparison);
  const deletedComparisonGutter = new DeletedComparisonGutterController();
  context.subscriptions.push(
    comparisonScm,
    deletedComparisonGutter,
    registerComparisonFileDecorations(comparison)
  );
  /** 기본 Explorer와 Tab Manager의 토글 버튼 조건을 controller 상태에 동기화한다. */
  const syncComparisonContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "gitSimpleCompare.explorerComparison.enabled",
      comparison.enabled
    );
    void vscode.commands.executeCommand(
      "setContext",
      "gitSimpleCompare.explorerComparison.hasComparison",
      comparison.hasComparison
    );
    void vscode.commands.executeCommand(
      "setContext",
      "gitSimpleCompare.explorerComparison.canSwap",
      comparison.peekComparison(true)?.kind === "branches"
    );
  };
  context.subscriptions.push(
    comparison.onDidChangeComparison(syncComparisonContext)
  );
  syncComparisonContext();

  // 4) 브랜치 비교 결과를 보여줄 CHANGES 웹뷰(보기 모드/정렬은 globalState 에 보존)
  let scheduleRefresh: (reason: string, delay?: number) => void = () => undefined;
  const hiddenRepositoryRefresh = new HiddenRepositoryRefreshFence();
  /** 상태 이벤트마다 즉시 generation을 올려 debounce 중간의 두 번째 Git 전환도 stale 조회를 무효화한다. */
  const invalidateStatusCachesForRefresh = (): void => {
    registry.invalidateStatusCaches();
  };
  const changesView = new ChangesViewProvider(
    context.extensionUri,
    context.globalState,
    () => comparison.enabled,
    (reason) =>
      scheduleRefresh(hiddenRepositoryRefresh.consumeVisibilityReason(reason), 0)
  );
  context.subscriptions.push(
    comparison.onDidChangeComparison(() =>
      changesView.refreshComparisonStatus()
    ),
    vscode.window.registerWebviewViewProvider(
      ChangesViewProvider.viewId,
      changesView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 5) 충돌 해결 뷰 + 컨트롤러
  const conflictsProvider = new ConflictsTreeProvider();
  const conflictsTree = vscode.window.createTreeView("gitSimpleCompare.conflicts", {
    treeDataProvider: conflictsProvider,
  });
  context.subscriptions.push(conflictsTree);
  let conflictsVisible = conflictsTree.visible;
  const conflicts = new ConflictsController(registry, conflictsProvider);
  context.subscriptions.push(conflicts);
  const conflictOverlay = new ConflictEditorOverlayController(conflicts);
  context.subscriptions.push(conflictOverlay.register());
  const conflictActions = new ConflictEditorActions(conflictOverlay);
  context.subscriptions.push(
    conflictActions.register(),
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: CONFLICT_OVERLAY_SCHEME },
        { scheme: CONFLICT_READONLY_SCHEME },
      ],
      new ConflictOverlayCodeLensProvider(conflictOverlay)
    )
  );
  const hunkCheckboxes = new HunkCheckboxController(registry);
  context.subscriptions.push(hunkCheckboxes.register());
  const conflictMarkerDecorations = new ConflictMarkerDecoratorController(
    registry,
    conflictOverlay
  );
  context.subscriptions.push(conflictMarkerDecorations.register());
  const blameDecorations = new BlameDecoratorController(registry);
  context.subscriptions.push(blameDecorations.register());
  const prCommentDecorations = new PullRequestCommentController(
    registry,
    context.secrets
  );
  context.subscriptions.push(prCommentDecorations.register());
  const nativeDiffOverlay = new NativeDiffOverlayController(
    context.globalStorageUri, context.workspaceState,
    hunkCheckboxes, conflictOverlay, conflictActions
  );
  activeNativeDiffOverlay = nativeDiffOverlay;
  context.subscriptions.push(nativeDiffOverlay.register());
  const vscodeGitStatus = new VscodeGitStatusProvider((reason) => {
    hiddenRepositoryRefresh.mark(reason, changesView.isVisible());
    if (
      !changesView.isVisible() &&
      !conflictsVisible &&
      !(comparison.enabled && reason === "vscodeGit:identity")
    ) {
      return;
    }
    // provider snapshot 자체가 최신 파일 목록이므로 state 이벤트는 캐시 세대를 다시 흔들지 않고 fast lane으로 보낸다.
    if (reason !== "vscodeGit:state") {
      invalidateStatusCachesForRefresh();
    }
    scheduleRefresh(reason, reason === "vscodeGit:state" ? 0 : undefined);
  });
  context.subscriptions.push(vscodeGitStatus);

  // 6) 명령 등록(핸들러는 commands 모듈에 위임)
  const deps: CommandDeps = {
    registry,
    changesView,
    extensionUri: context.extensionUri,
    secrets: context.secrets,
    conflicts,
    conflictOverlay,
    hunkCheckboxes,
    blameDecorations,
    vscodeGitStatus,
    refreshPullRequestComments: (reason) =>
      prCommentDecorations.invalidateCache(reason),
    comparison,
  };
  for (const disposable of registerCommands(deps)) {
    context.subscriptions.push(disposable);
  }
  context.subscriptions.push(
    ...registerLocalChangesWatcher({
      isVisible: () => changesView.isVisible(),
      getActiveRepo: () => changesView.getActiveRepo(),
      requestRefresh: (reason) => void vscode.commands.executeCommand(
        "gitSimpleCompare.refreshChanges", { reason }),
    })
  );

  // 7) "좌→우 반영" 버튼 노출용 컨텍스트 키 추적기 등록
  context.subscriptions.push(registerActiveDiffTracker());

  // 8) view/title 토글 버튼이 현재 보기 모드를 반영하도록 컨텍스트 키 초기화
  syncViewContext(deps);

  // 9) Git 메타데이터/VS Code Git 상태 이벤트에 맞춰 보이는 뷰만 갱신한다.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingRefreshReasons = new Set<string>();
  let refreshDeferredLogged = false;
  let refreshBurstStartedAt: number | undefined;
  const refreshMaxWaitMs = 600;
  const pendingGraphRefreshRoots = new Set<string>();
  const pendingBranchCacheRoots = new Set<string>();
  let pendingClearAllBranchContent = false;
  const refreshEverything = (reason: string): void => {
    const changesVisible = changesView.isVisible();
    hiddenRepositoryRefresh.mark(reason, changesVisible);
    logInfo("refresh requested", {
      reason,
      changesVisible,
      conflictsVisible,
    });
    if (pendingClearAllBranchContent) {
      clearBranchContentCache();
      pendingClearAllBranchContent = false;
      pendingBranchCacheRoots.clear();
    } else {
      for (const repoRoot of pendingBranchCacheRoots) {
        clearBranchContentCache(repoRoot);
      }
      pendingBranchCacheRoots.clear();
    }
    for (const repoRoot of pendingGraphRefreshRoots) {
      GitGraphPanel.refreshOpen(repoRoot, reason);
    }
    pendingGraphRefreshRoots.clear();
    if (shouldRefreshPullRequestComments(reason)) {
      prCommentDecorations.refresh(reason);
    }
    if (
      reason
        .split(",")
        .some((part) => part.trim() === "vscodeGit:identity")
    ) {
      void refreshComparisonIdentity(comparison, changesView, reason).catch((error) => {
        logError("comparison identity refresh failed", error, { reason });
      });
    }
    // Changes 뷰가 보이면 refreshActiveComparison 이 같은 스냅샷을 갱신한다.
    // 숨겨진 경우에만 controller 경로를 사용해 PR API/git diff 중복 조회를 피한다.
    if (
      !changesVisible &&
      shouldRefreshExplorerComparison(reason)
    ) {
      comparison.requestRefresh(reason);
    }
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
    hiddenRepositoryRefresh.mark(reason, changesView.isVisible());
    addRefreshReasons(pendingRefreshReasons, reason);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (!vscode.window.state.focused) {
      if (!refreshDeferredLogged) {
        refreshDeferredLogged = true;
        logInfo("refresh deferred", {
          reason: "window-unfocused",
          pendingReasons: pendingRefreshReasons.size,
        });
      }
      return;
    }
    const now = Date.now();
    refreshBurstStartedAt ??= now;
    // trailing debounce가 파일 이벤트 폭주 동안 끝없이 밀리지 않도록 첫 요청부터 최대 대기 시간을 둔다.
    const remainingMaxWait = Math.max(
      0,
      refreshMaxWaitMs - (now - refreshBurstStartedAt)
    );
    const boundedDelay = Math.min(Math.max(0, delay), remainingMaxWait);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!vscode.window.state.focused) {
        if (!refreshDeferredLogged) {
          refreshDeferredLogged = true;
          logInfo("refresh deferred", {
            reason: "window-unfocused-before-run",
            pendingReasons: pendingRefreshReasons.size,
          });
        }
        return;
      }
      const mergedReason = [...pendingRefreshReasons].join(",");
      pendingRefreshReasons.clear();
      refreshBurstStartedAt = undefined;
      refreshEverything(mergedReason || "scheduled");
    }, boundedDelay);
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
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.git/{HEAD,refs/**,packed-refs,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**,worktrees/**,info/exclude,hooks/**}"
  );
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.gitignore"
  );
  const commonHooksWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{.husky/**,.githooks/**}"
  );
  const scheduleRefreshForGitUri = (
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ): void => {
    const decision = shouldRefreshForGitPath(uri.fsPath);
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
    invalidateStatusCachesForRefresh();
    if (
      decision.reason !== "ignore-rules" &&
      decision.reason !== "commit-hooks"
    ) {
      const repoRoot = repoRootFromGitPath(uri.fsPath);
      if (repoRoot) {
        pendingBranchCacheRoots.add(repoRoot);
        pendingGraphRefreshRoots.add(repoRoot);
      } else {
        pendingClearAllBranchContent = true;
      }
    }
    scheduleRefresh(`git:${event}:${decision.reason}`);
  };
  const scheduleRefreshForIgnoreUri = (
    event: "create" | "change" | "delete",
    uri: vscode.Uri
  ): void => {
    logInfo("ignore rules refresh requested", { event, path: uri.fsPath });
    invalidateStatusCachesForRefresh();
    scheduleRefresh(`working-tree-file:${event}:ignore-rules`, 0);
  };
  connectRefreshWatcher(
    gitWatcher,
    scheduleRefreshForGitUri,
    context.subscriptions
  );
  connectRefreshWatcher(
    gitignoreWatcher,
    scheduleRefreshForIgnoreUri,
    context.subscriptions
  );
  connectRefreshWatcher(
    commonHooksWatcher,
    (event, uri) => {
      logInfo("commit hooks refresh requested", { event, path: uri.fsPath });
      scheduleRefresh(`custom-hook:${event}:commit-hooks`, 0);
    },
    context.subscriptions
  );
  context.subscriptions.push(
    gitWatcher,
    gitignoreWatcher,
    commonHooksWatcher,
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        return;
      }
      const hadDeferredReason = pendingRefreshReasons.size > 0;
      // Git API가 없거나 auto refresh가 꺼진 환경도 외부 편집/git add를 놓치지 않도록, 보이는 Changes는
      // 포커스 복귀 때 workingChanges 한 영역만 CLI SoT로 확인한다. 정책에서 History/stash 등은 제외된다.
      if (changesView.isVisible()) {
        addRefreshReasons(pendingRefreshReasons, "windowFocused");
      }
      if (pendingRefreshReasons.size === 0) {
        return;
      }
      refreshDeferredLogged = false;
      logInfo(
        hadDeferredReason
          ? "deferred refresh resumed"
          : "focus status refresh scheduled",
        { pendingReasons: pendingRefreshReasons.size }
      );
      scheduleRefresh("", 0);
    }),
    conflictsTree.onDidChangeVisibility((event) => {
      conflictsVisible = event.visible;
      if (event.visible) {
        void conflicts.refresh();
      }
    })
  );

  // 10) 워크스페이스 폴더가 바뀌면 저장소 목록부터 다시 찾는다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registry.invalidateResolveCache();
      invalidateStatusCachesForRefresh();
      pendingClearAllBranchContent = true;
      scheduleRefresh("workspaceFolders", 0);
    })
  );

  // 11) 파일 아이콘/색상 테마가 바뀌면 Changes 웹뷰의 파일 아이콘도 다시 그린다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("workbench.iconTheme")) {
        logInfo("file icon theme changed");
        changesView.refresh();
      }
      if (event.affectsConfiguration("scm.diffDecorations")) {
        logInfo("editor gutter setting changed");
        changesView.refresh();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      logInfo("color theme changed");
      changesView.refresh();
    })
  );
  logInfo("extension activated");
  return {
    version: 1,
    onDidChangeComparison: comparison.onDidChangeComparison,
    getComparison: () => comparison.getPublicComparison(),
  };
}

/**
 * 확장이 비활성화될 때 호출된다.
 * - renderer에 주입된 native DOM과 debugger bridge는 비동기 정리가 끝날 때까지 기다린다.
 */
export async function deactivate(): Promise<void> {
  const overlay = activeNativeDiffOverlay;
  activeNativeDiffOverlay = undefined;
  await overlay?.shutdown();
}

/**
 * VS Code Git 상태 이벤트가 단순 작업파일 변경인지 ref/checkout 변경인지 가볍게 구분한다.
 * - base/target ref가 움직였거나 localRemote 모드에서 HEAD가 바뀌면 전체 비교 refresh를 요청한다.
 * - 명시적 브랜치/PR 비교의 checkout만 바뀌면 파일 목록은 유지하고 Quick Diff gate만 갱신한다.
 * @param controller 활성 비교 상태 controller
 * @param changesView 기존 Changes 비교 카드의 HEAD 일치 상태를 함께 갱신할 provider
 * @param reason 진단 로그와 후속 refresh에 전달할 이벤트 원인
 */
async function refreshComparisonIdentity(
  controller: ComparisonController,
  changesView: ChangesViewProvider,
  reason: string
): Promise<void> {
  const before = controller.getComparison(false);
  if (!before) {
    return;
  }
  const identity = await resolveComparisonRefIdentity(
    before.repoRoot,
    before.baseRef,
    before.targetRef,
    before.sourceBaseRef
  );
  const current = controller.getComparison(false);
  if (!current || current.updatedAt !== before.updatedAt) {
    logInfo("comparison identity result skipped", { reason, state: "stale" });
    return;
  }
  const refsChanged =
    identity.baseHash !== before.resolvedBaseHash ||
    identity.sourceBaseHash !== before.resolvedSourceBaseHash ||
    identity.targetHash !== before.resolvedTargetHash;
  const headChanged = identity.headHash !== before.resolvedHeadHash;
  if (refsChanged || (headChanged && before.kind === "localRemote")) {
    // linked worktree처럼 .git 파일 watcher가 직접 잡지 못한 ref 이동도 이미 열린
    // 가상 문서가 이전 commit 내용을 재사용하지 않도록 전체 캐시를 먼저 비운다.
    clearBranchContentCache(current.repoRoot);
    controller.requestRefresh(`identity:${reason}`);
    return;
  }
  if (!headChanged) {
    return;
  }
  const updated: ComparisonSnapshot = {
    ...current,
    targetMatchesHead: Boolean(
      identity.targetHash && identity.targetHash === identity.headHash
    ),
    resolvedBaseHash: identity.baseHash,
    resolvedSourceBaseHash: identity.sourceBaseHash,
    resolvedTargetHash: identity.targetHash,
    resolvedHeadHash: identity.headHash,
    updatedAt: new Date().toISOString(),
  };
  controller.setSnapshot(updated);
  syncChangesComparisonIdentity(changesView, current, updated);
  logInfo("comparison HEAD identity refreshed", {
    reason,
    repoRoot: current.repoRoot,
    targetMatchesHead: identity.targetHash === identity.headHash,
  });
}

/**
 * controller의 HEAD gate만 바뀐 경우 같은 비교를 보여 주는 Changes 카드도 함께 갱신한다.
 * - 저장소/ref/diff 기준이 모두 같을 때만 적용해 사용자가 막 선택한 다른 비교를 덮지 않는다.
 * @param changesView 갱신할 Changes 웹뷰 provider
 * @param before identity 조회를 시작할 때의 controller 스냅샷
 * @param after 최신 HEAD identity가 반영된 controller 스냅샷
 */
function syncChangesComparisonIdentity(
  changesView: ChangesViewProvider,
  before: ComparisonSnapshot,
  after: ComparisonSnapshot
): void {
  const visible = changesView.getComparison();
  if (
    !visible ||
    visible.repoRoot !== before.repoRoot ||
    visible.base !== before.baseRef ||
    (visible.sourceBase ?? visible.base) !== before.sourceBaseRef ||
    visible.target !== before.targetRef ||
    visible.diffBase !== before.diffBase
  ) {
    return;
  }
  changesView.setComparison({
    ...visible,
    diffAvailable: after.diffAvailable,
    targetMatchesHead: after.targetMatchesHead,
  });
}
