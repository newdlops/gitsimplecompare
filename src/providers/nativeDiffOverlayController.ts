// 네이티브 VS Code editor에 diff checkbox, conflict context, blame 거터를 얹는 renderer overlay.
// - 공식 extension API가 아닌 공용 CDP 연결을 사용하며 각 surface의 snapshot과 cleanup을 조정한다.
import * as vscode from "vscode";
import { HunkCheckboxController } from "./hunkCheckboxController";
import { cleanupExpression, injectionExpression, rendererPatchScript } from "./nativeDiffOverlayPatch";
import { shouldRepaintSameSnapshot, snapshotSignature, workspaceHints } from "./nativeDiffOverlaySupport";
import {
  NativeDiffInitialPaintRetry,
  NativeOverlayConnectionRetry,
  NativeOverlayRenderDrain,
  waitAtMost,
} from "./nativeDiffOverlayRetry";
import { NativeDiffOverlayEvents } from "./nativeDiffOverlayEvents";
import { NativeDiffOverlaySurfaceState } from "./nativeDiffOverlaySurfaceState";
import type { ConflictEditorOverlayController } from "./conflictEditorOverlayController";
import type { ConflictOverlayActionHandler } from "./conflictOverlayProtocol";
import type { BlockBlamePresenter } from "../ui/blockBlamePresenter";
import {
  conflictOverlayCleanupExpression,
  conflictOverlayInjectionExpression,
  nativeConflictOverlayRendererScript,
} from "./nativeConflictOverlayPatch";
import { activeHunkWorkingModifiedUri } from "./hunkDiffContext";
import { onDidEndDiffOpen } from "./diffOpenGate";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  overlayBridgeReleaseExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";
import { NativeOverlayConnection } from "./nativeOverlayConnection";
import {
  blameOverlayCleanupExpression,
  blameOverlayInjectionExpression,
  nativeBlameOverlayRendererScript,
} from "./nativeBlameOverlayPatch";

/** workbench renderer overlay 의 주입/갱신/클릭 bridge 를 관리한다. */
export class NativeDiffOverlayController {
  private readonly connection: NativeOverlayConnection;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly renderDrain = new NativeOverlayRenderDrain();
  private readonly connectionRetry = new NativeOverlayConnectionRetry();
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;
  private targetWindowId: number | undefined;
  // 이 activation이 실제 renderer를 열기 전에는 startup cleanup만을 위해 CDP를 켜지 않는다.
  private rendererSurfaceStateKnown = false;
  private diffSurfaceMayExist = false;
  private conflictSurfaceMayExist = false;
  private blameSurfaceMayExist = false;
  private readonly persistedSurfaces: NativeDiffOverlaySurfaceState;
  private surfaceRetryCount = 0;
  private lastRenderSignature = "";
  private readonly initialPaintRetry = new NativeDiffInitialPaintRetry();
  private readonly rendererEvents: NativeDiffOverlayEvents;

  constructor(
    globalStorageUri: vscode.Uri,
    surfaceState: vscode.Memento,
    private readonly hunkCheckboxes: HunkCheckboxController,
    private readonly conflictOverlay?: ConflictEditorOverlayController,
    conflictActions?: ConflictOverlayActionHandler,
    private readonly blockBlame?: BlockBlamePresenter
  ) {
    this.rendererEvents = new NativeDiffOverlayEvents(hunkCheckboxes, conflictActions);
    this.connection = new NativeOverlayConnection(
      globalStorageUri,
      (payload) => this.rendererEvents.handle(payload)
    );
    this.persistedSurfaces = new NativeDiffOverlaySurfaceState(surfaceState);
    if (this.persistedSurfaces.needsRecovery()) {
      this.rendererSurfaceStateKnown = true;
      this.diffSurfaceMayExist = true;
      this.conflictSurfaceMayExist = true;
      this.blameSurfaceMayExist = true;
    }
  }
  /** overlay 갱신에 필요한 VS Code 이벤트를 등록한다. */
  register(): vscode.Disposable {
    const disposable = vscode.Disposable.from(
      this.hunkCheckboxes.onDidChangeHunkControls(() =>
        this.scheduleRender("hunkControls")
      ),
      ...(this.conflictOverlay
        ? [this.conflictOverlay.onDidChangeOverlay(() =>
            this.scheduleRender("conflictOverlay", 0)
          )]
        : []),
      ...(this.blockBlame
        ? [this.blockBlame.onDidChangeGutter(() =>
            this.scheduleRender("blockBlame", 0)
          )]
        : []),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleRender("tabs")),
      vscode.window.tabGroups.onDidChangeTabGroups(() =>
        this.scheduleRender("tabGroups")
      ),
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.scheduleRender("activeEditor")
      ),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.scheduleRender("visibleEditors")
      ),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleRender("windowFocused", 0);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.shouldRenderForDocumentChange(event.document.uri)) {
          this.scheduleRender("documentChanged", 350);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.shouldRenderForDocumentChange(document.uri)) {
          this.scheduleRender("save");
        }
      }),
      onDidEndDiffOpen(() => this.scheduleRender("diffOpenFinished", 0)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("gitSimpleCompare.hunkControlMode")) {
          this.scheduleRender("config");
        }
      }),
      new vscode.Disposable(() => this.dispose())
    );
    this.scheduleRender("startup", 0);
    return disposable;
  }

  /** 짧은 debounce 뒤 renderer overlay 를 다시 그린다. */
  scheduleRender(reason: string, delay = 80): void {
    // 백그라운드 창은 기존 overlay를 보존하고, 포커스를 되찾을 때 최신 snapshot을 한 번 그린다.
    if (this.disposed || !vscode.window.state.focused) {
      return;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.renderDrain.enqueue(
        reason,
        (nextReason) => this.render(nextReason),
        (error, failedReason) =>
          logError("native editor overlay snapshot refresh failed", error, {
            reason: failedReason,
          })
      );
    }, delay);
  }

  /** 현재 설정/active diff 상태를 보고 overlay 를 주입하거나 제거한다. */
  private async render(reason: string): Promise<void> {
    if (this.disposed || !vscode.window.state.focused) {
      return;
    }
    const hunkEnabled = this.hunkCheckboxes.mode() === "nativeOverlay";
    if (!hunkEnabled) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
    }
    const snapshots = hunkEnabled
      ? await this.hunkCheckboxes.overlaySnapshots()
      : [];
    if (this.disposed || !vscode.window.state.focused) return;
    const conflictSnapshot = this.conflictOverlay?.overlaySnapshot();
    const blameSnapshot = this.blockBlame?.gutterSnapshot();
    if (!snapshots.length && !conflictSnapshot && !blameSnapshot) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      this.lastRenderSignature = "";
      logInfo("native editor overlays skipped", { reason, snapshotCount: 0 });
      await this.cleanupRenderer("noSnapshot");
      return;
    }
    const signature = JSON.stringify({
      hunk: snapshots.length ? snapshotSignature(snapshots) : "",
      conflict: conflictSnapshot ?? null,
      blame: blameSnapshot ?? null,
    });
    if (
      signature === this.lastRenderSignature &&
      !reason.startsWith("initialPaintRetry") &&
      !shouldRepaintSameSnapshot(reason)
    ) {
      logInfo("native editor overlay render skipped", { reason, sameSignature: true });
      return;
    }
    try {
      await this.connection.ensureConnected();
      this.connectionRetry.clear();
      if (this.disposed || !vscode.window.state.focused) return;
      if (!this.rendererSurfaceStateKnown) {
        // 이전 extension host가 남긴 DOM은 첫 실제 사용 때만 한 번 정리 대상으로 간주한다.
        this.rendererSurfaceStateKnown = true;
        this.diffSurfaceMayExist = true;
        this.conflictSurfaceMayExist = true;
        this.blameSurfaceMayExist = true;
      }
      let succeeded = true;
      if (snapshots.length) {
        // shutdown cleanup가 주입 응답보다 먼저 시작돼도 surface 가능성을 놓치지 않는다.
        this.diffSurfaceMayExist = true;
        void this.persistedSurfaces.persist(true);
        try {
          if (!vscode.window.state.focused) return;
          const result = await this.connection.evaluateMain(
            injectionExpression(rendererPatchScript(), snapshots, this.hints()),
            8000
          );
          this.captureTargetWindow(result);
          if (this.disposed) return;
          this.diffSurfaceMayExist = true;
          this.hunkCheckboxes.setNativeOverlayAvailable(true);
          this.initialPaintRetry.schedule(
            signature,
            result,
            reason,
            (retryReason, delay) => this.scheduleRender(retryReason, delay)
          );
          logInfo("native diff overlay rendered", {
            reason,
            paths: snapshots.map((snapshot) => snapshot.path),
            revisions: snapshots.map((snapshot) => snapshot.revision),
            lines: snapshots.reduce((sum, snapshot) => sum + snapshot.lines.length, 0),
            result: String(result ?? ""),
          });
        } catch (error) {
          succeeded = false;
          this.hunkCheckboxes.setNativeOverlayAvailable(false);
          logError("native diff overlay render failed", error, { reason });
        }
      } else {
        this.hunkCheckboxes.setNativeOverlayAvailable(false);
        if (!await this.cleanupSurface(cleanupExpression(this.hints()), "diff", reason)) {
          succeeded = false;
        }
      }
      if (this.disposed) return;
      if (conflictSnapshot) {
        this.conflictSurfaceMayExist = true;
        void this.persistedSurfaces.persist(true);
        try {
          if (!vscode.window.state.focused) return;
          const result = await this.connection.evaluateMain(
            conflictOverlayInjectionExpression(
              nativeConflictOverlayRendererScript(),
              conflictSnapshot,
              this.hints()
            ),
            8000
          );
          this.captureTargetWindow(result);
          if (this.disposed) return;
          this.conflictSurfaceMayExist = true;
          logInfo("native conflict overlay rendered", {
            reason,
            uri: conflictSnapshot.uri,
            revision: conflictSnapshot.revision,
            result: String(result ?? ""),
          });
        } catch (error) {
          succeeded = false;
          logError("native conflict overlay render failed; CodeLens remains available", error, {
            reason,
            uri: conflictSnapshot.uri,
          });
        }
      } else {
        if (!await this.cleanupSurface(
          conflictOverlayCleanupExpression(this.hints()),
          "conflict",
          reason
        )) succeeded = false;
      }
      if (this.disposed) return;
      if (blameSnapshot) {
        this.blameSurfaceMayExist = true;
        void this.persistedSurfaces.persist(true);
        try {
          if (!vscode.window.state.focused) return;
          const result = await this.connection.evaluateMain(
            blameOverlayInjectionExpression(
              nativeBlameOverlayRendererScript(),
              blameSnapshot,
              this.hints()
            ),
            12_000
          );
          this.captureTargetWindow(result);
          if (this.disposed) return;
          this.blameSurfaceMayExist = true;
          logInfo("native blame gutter rendered", {
            reason,
            uri: blameSnapshot.uri,
            revision: blameSnapshot.revision,
            lines: blameSnapshot.lines.length,
            widthCh: blameSnapshot.columnWidthCh,
            result: String(result ?? ""),
          });
        } catch (error) {
          succeeded = false;
          logError("native blame gutter render failed", error, {
            reason,
            uri: blameSnapshot.uri,
          });
        }
      } else if (!await this.cleanupSurface(
        blameOverlayCleanupExpression(this.hints()),
        "blame",
        reason
      )) {
        succeeded = false;
      }
      this.lastRenderSignature = succeeded ? signature : "";
      if (succeeded) {
        this.surfaceRetryCount = 0;
      } else if (this.surfaceRetryCount < 3) {
        this.surfaceRetryCount++;
        this.scheduleRender(`surfaceRetry:${this.surfaceRetryCount}`, 350);
      }
    } catch (error) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      this.lastRenderSignature = "";
      logError("native editor overlay connection failed", error, { reason });
      if (/no-target-window/i.test(error instanceof Error ? error.message : String(error))) {
        this.targetWindowId = undefined;
      }
      this.connection.close();
      if (!this.disposed) {
        this.connectionRetry.schedule(
          this.connection.retryDelayMs(),
          () => this.scheduleRender("connectionRetry", 0)
        );
      }
    }
  }

  /**
   * 문서 변경 이벤트 중 overlay 재주입이 필요한 대상만 고른다.
   * - OUTPUT 채널 로그 변경도 TextDocument 변경으로 들어오므로 active diff 문서만 통과시킨다.
   * @param uri 변경된 문서 URI
   */
  private shouldRenderForDocumentChange(uri: vscode.Uri): boolean {
    const modified = activeHunkWorkingModifiedUri();
    return (!!modified && modified.toString() === uri.toString()) ||
      Boolean(this.conflictOverlay?.ownsUri(uri)) ||
      this.blockBlame?.gutterSnapshot()?.uri === uri.toString();
  }

  /** renderer에 남아 있는 모든 editor overlay를 제거한다. */
  private async cleanupRenderer(reason: string, connectIfNeeded = true): Promise<boolean> {
    if (
      !this.diffSurfaceMayExist &&
      !this.conflictSurfaceMayExist &&
      !this.blameSurfaceMayExist
    ) return true;
    if (!this.connection.isOpen() && !connectIfNeeded) {
      return false;
    }
    try {
      if (!this.connection.isOpen()) await this.connection.ensureConnected();
      this.connectionRetry.clear();
    } catch (error) {
      logWarn("native overlay cleanup connection failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const diff = await this.cleanupSurface(cleanupExpression(this.hints()), "diff", reason);
    const conflict = await this.cleanupSurface(
      conflictOverlayCleanupExpression(this.hints()),
      "conflict",
      reason
    );
    const blame = await this.cleanupSurface(
      blameOverlayCleanupExpression(this.hints()),
      "blame",
      reason
    );
    let released = false;
    try {
      const result = await this.connection.evaluateMain(
        overlayBridgeReleaseExpression(this.hints()),
        2500
      );
      released = !/release-err:/.test(String(result ?? ""));
      logInfo("native overlay debugger bridge released", { reason, result: String(result ?? "") });
    } catch (error) {
      logWarn("native overlay debugger bridge release failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const surfacesCleaned = diff && conflict && blame;
    if (surfacesCleaned) {
      this.diffSurfaceMayExist = false;
      this.conflictSurfaceMayExist = false;
      this.blameSurfaceMayExist = false;
      await this.persistedSurfaces.persist(false);
    }
    return surfacesCleaned && released;
  }

  /** 한 renderer surface의 cleanup 실패를 다른 overlay 정리와 분리해 관찰 가능하게 남긴다. */
  private async cleanupSurface(
    expression: string,
    surface: "diff" | "conflict" | "blame",
    reason: string
  ): Promise<boolean> {
    if (
      (surface === "diff" && !this.diffSurfaceMayExist) ||
      (surface === "conflict" && !this.conflictSurfaceMayExist) ||
      (surface === "blame" && !this.blameSurfaceMayExist)
    ) {
      return true;
    }
    try {
      const result = await this.connection.evaluateMain(expression, 2500);
      this.captureTargetWindow(result);
      if (surface === "diff") this.diffSurfaceMayExist = false;
      else if (surface === "conflict") this.conflictSurfaceMayExist = false;
      else this.blameSurfaceMayExist = false;
      logInfo(`native ${surface} overlay cleaned`, { reason });
      return true;
    } catch (error) {
      logWarn(`native ${surface} overlay cleanup failed`, {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 타이머를 멈추고 renderer DOM/debugger bridge 정리가 끝날 때까지 기다린다. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.connection.beginShutdown();
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderDrain.clear();
    this.connectionRetry.clear();
    this.initialPaintRetry.clear();
    // 진행 중 injection 뒤에 cleanup을 연결해 두 작업이 엇갈리지 않게 하되 reload 대기는 2초로 제한한다.
    const cleanup = this.renderDrain.completion()
      .catch(() => undefined)
      .then(() => this.cleanupRenderer("dispose", false))
      .then(() => this.connection.removeMainBinding());
    this.shutdownPromise = waitAtMost(cleanup, 2000)
      .finally(() => this.connection.close());
    return this.shutdownPromise;
  }

  /** VS Code Disposable 계약에서는 비동기 shutdown을 시작하고 deactivate가 별도로 await한다. */
  private dispose(): void {
    void this.shutdown();
  }

  /** 첫 renderer 응답의 BrowserWindow id를 이후 render/cleanup 대상으로 고정한다. */
  private captureTargetWindow(result: unknown): void {
    const match = /(?:^|[,|])ok:(\d+):/.exec(String(result ?? ""));
    if (match && this.targetWindowId === undefined) this.targetWindowId = Number(match[1]);
  }

  /** 현재 extension host가 처음 선택한 renderer 창 id를 workspace 힌트에 결합한다. */
  private hints(): NativeOverlayWorkspaceHints {
    return { ...workspaceHints(), windowId: this.targetWindowId };
  }

}
