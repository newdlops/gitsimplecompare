// 네이티브 VS Code editor 위에 diff checkbox와 conflict context를 얹는 renderer overlay.
// - 공식 extension API가 아닌 CDP 주입 경로이며 conflict action은 CodeLens를 안전한 폴백으로 유지한다.
import * as vscode from "vscode";
import WebSocket = require("ws");
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
import {
  conflictOverlayCleanupExpression,
  conflictOverlayInjectionExpression,
  nativeConflictOverlayRendererScript,
} from "./nativeConflictOverlayPatch";
import { activeHunkWorkingModifiedUri } from "./hunkDiffContext";
import { onDidEndDiffOpen } from "./diffOpenGate";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  armInspector,
  findCurrentVSCodeMainPid,
  findInspectorWebSocketUrlForPid,
} from "./nativeDiffOverlayInspector";
import {
  overlayBridgeReleaseExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";

const MAIN_BINDING = "gscNativeDiffOverlayEvent";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** workbench renderer overlay 의 주입/갱신/클릭 bridge 를 관리한다. */
export class NativeDiffOverlayController {
  private ws: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private requestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly renderDrain = new NativeOverlayRenderDrain();
  private readonly connectionRetry = new NativeOverlayConnectionRetry();
  private readonly lifetimeAbort = new AbortController();
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;
  private targetWindowId: number | undefined;
  // 이 activation이 실제 renderer를 열기 전에는 startup cleanup만을 위해 CDP를 켜지 않는다.
  private rendererSurfaceStateKnown = false;
  private diffSurfaceMayExist = false;
  private conflictSurfaceMayExist = false;
  private readonly persistedSurfaces: NativeDiffOverlaySurfaceState;
  private connectionRetryAfter = 0;
  private surfaceRetryCount = 0;
  private lastRenderSignature = "";
  private readonly initialPaintRetry = new NativeDiffInitialPaintRetry();
  private readonly rendererEvents: NativeDiffOverlayEvents;

  constructor(
    private readonly globalStorageUri: vscode.Uri,
    surfaceState: vscode.Memento,
    private readonly hunkCheckboxes: HunkCheckboxController,
    private readonly conflictOverlay?: ConflictEditorOverlayController,
    conflictActions?: ConflictOverlayActionHandler
  ) {
    this.rendererEvents = new NativeDiffOverlayEvents(hunkCheckboxes, conflictActions);
    this.persistedSurfaces = new NativeDiffOverlaySurfaceState(surfaceState);
    if (this.persistedSurfaces.needsRecovery()) {
      this.rendererSurfaceStateKnown = true;
      this.diffSurfaceMayExist = true;
      this.conflictSurfaceMayExist = true;
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
    if (!snapshots.length && !conflictSnapshot) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      this.lastRenderSignature = "";
      logInfo("native editor overlays skipped", { reason, snapshotCount: 0 });
      await this.cleanupRenderer("noSnapshot");
      return;
    }
    const signature = JSON.stringify({
      hunk: snapshots.length ? snapshotSignature(snapshots) : "",
      conflict: conflictSnapshot ?? null,
    });
    if (
      signature === this.lastRenderSignature &&
      !reason.startsWith("initialPaintRetry") &&
      !shouldRepaintSameSnapshot(reason)
    ) {
      logInfo("native diff overlay render skipped", { reason, sameSignature: true });
      return;
    }
    try {
      await this.ensureConnected();
      if (this.disposed || !vscode.window.state.focused) return;
      if (!this.rendererSurfaceStateKnown) {
        // 이전 extension host가 남긴 DOM은 첫 실제 사용 때만 한 번 정리 대상으로 간주한다.
        this.rendererSurfaceStateKnown = true;
        this.diffSurfaceMayExist = true;
        this.conflictSurfaceMayExist = true;
      }
      let succeeded = true;
      if (snapshots.length) {
        // shutdown cleanup가 주입 응답보다 먼저 시작돼도 surface 가능성을 놓치지 않는다.
        this.diffSurfaceMayExist = true;
        void this.persistedSurfaces.persist(true);
        try {
          if (!vscode.window.state.focused) return;
          const result = await this.evaluateMain(
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
          const result = await this.evaluateMain(
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
      this.closeSocket();
      if (!this.disposed) {
        this.connectionRetry.schedule(
          this.connectionRetryAfter - Date.now(),
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
      Boolean(this.conflictOverlay?.ownsUri(uri));
  }

  /** renderer에 남아 있는 모든 editor overlay를 제거한다. */
  private async cleanupRenderer(reason: string, connectIfNeeded = true): Promise<boolean> {
    if (!this.diffSurfaceMayExist && !this.conflictSurfaceMayExist) return true;
    if (this.ws?.readyState !== WebSocket.OPEN && !connectIfNeeded) {
      return false;
    }
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) await this.ensureConnected();
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
    let released = false;
    try {
      const result = await this.evaluateMain(overlayBridgeReleaseExpression(this.hints()), 2500);
      released = !/release-err:/.test(String(result ?? ""));
      logInfo("native overlay debugger bridge released", { reason, result: String(result ?? "") });
    } catch (error) {
      logWarn("native overlay debugger bridge release failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const surfacesCleaned = diff && conflict;
    if (surfacesCleaned) {
      this.diffSurfaceMayExist = false;
      this.conflictSurfaceMayExist = false;
      await this.persistedSurfaces.persist(false);
    }
    return surfacesCleaned && released;
  }

  /** 한 renderer surface의 cleanup 실패를 다른 overlay 정리와 분리해 관찰 가능하게 남긴다. */
  private async cleanupSurface(expression: string, surface: "diff" | "conflict", reason: string): Promise<boolean> {
    if (
      (surface === "diff" && !this.diffSurfaceMayExist) ||
      (surface === "conflict" && !this.conflictSurfaceMayExist)
    ) {
      return true;
    }
    try {
      const result = await this.evaluateMain(expression, 2500);
      this.captureTargetWindow(result);
      if (surface === "diff") this.diffSurfaceMayExist = false;
      else this.conflictSurfaceMayExist = false;
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

  /** VS Code main process inspector 에 연결하고 main binding 을 준비한다. */
  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (Date.now() < this.connectionRetryAfter) {
      throw new Error("Native overlay inspector reconnect is cooling down.");
    }
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
      this.connectionRetryAfter = 0;
      this.connectionRetry.clear();
    } catch (error) {
      // inspector가 허용되지 않는 환경에서 키 입력마다 전체 port scan을 반복하지 않는다.
      this.connectionRetryAfter = Date.now() + 15_000;
      throw error;
    } finally {
      this.connectPromise = undefined;
    }
  }

  /** 실제 CDP socket 연결 절차. ensureConnected 가 동시 호출을 단일화한다. */
  private async connect(): Promise<void> {
    this.closeSocket();
    const pid = await findCurrentVSCodeMainPid(this.globalStorageUri.fsPath);
    if (!pid) {
      throw new Error("Could not identify the current VS Code main process.");
    }
    if (this.disposed) throw new Error("Native overlay controller was disposed.");
    armInspector(pid);
    const wsUrl = await findInspectorWebSocketUrlForPid(pid, this.lifetimeAbort.signal);
    if (this.disposed) throw new Error("Native overlay controller was disposed.");
    if (!wsUrl) {
      throw new Error(`Could not find inspector WebSocket for VS Code PID ${pid}.`);
    }
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* 무시 */ }
        reject(new Error("CDP connect timed out"));
      }, 3000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    if (this.disposed) {
      try { ws.terminate(); } catch { /* 무시 */ }
      throw new Error("Native overlay controller was disposed.");
    }
    this.ws = ws;
    ws.on("message", (data) => this.onCdpMessage(data));
    ws.on("close", () => {
      if (this.ws === ws) {
        this.closeSocket(false);
      }
    });
    ws.on("error", (error) =>
      logWarn("native diff overlay CDP socket error", {
        error: error instanceof Error ? error.message : String(error),
      })
    );
    await this.cdpRequest("Runtime.enable", {}, 2000);
    await this.cdpRequest("Runtime.addBinding", { name: MAIN_BINDING }, 2000)
      .catch((error) => {
        if (!/already|exists|duplicate/i.test(String(error.message))) {
          throw error;
        }
      });
    logInfo("native diff overlay connected", { pid, wsUrl });
  }

  /** CDP Runtime.evaluate 를 main process inspector 에 보낸다. */
  private async evaluateMain(expression: string, timeoutMs: number): Promise<unknown> {
    const result = await this.cdpRequest(
      "Runtime.evaluate",
      {
        expression,
        includeCommandLineAPI: true,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs
    ) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      throw new Error(`Main process evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    const value = result.result?.value;
    const diagnostic = String(value ?? "");
    if (/(?:^|[,|])err:|^no-(?:require|target-window)/.test(diagnostic)) {
      throw new Error(`Renderer evaluation failed: ${diagnostic}`);
    }
    return value;
  }

  /** CDP 요청/응답을 매칭한다. */
  private cdpRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open."));
    }
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** CDP 응답과 renderer binding 이벤트를 처리한다. */
  private onCdpMessage(data: WebSocket.RawData): void {
    let message: { id?: number; method?: string; params?: any; error?: any; result?: any };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || String(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      message.method === "Runtime.bindingCalled" &&
      message.params?.name === MAIN_BINDING
    ) {
      this.rendererEvents.handle(String(message.params.payload || ""));
    }
  }

  /** 타이머를 멈추고 renderer DOM/debugger bridge 정리가 끝날 때까지 기다린다. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.lifetimeAbort.abort();
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
      .then(() => this.removeMainBinding());
    this.shutdownPromise = waitAtMost(cleanup, 2000)
      .finally(() => this.closeSocket());
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

  /** main process에 남은 renderer-event binding을 지원되는 CDP에서 best-effort로 제거한다. */
  private async removeMainBinding(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    await this.cdpRequest("Runtime.removeBinding", { name: MAIN_BINDING }, 1500)
      .catch((error) => logWarn("native overlay main binding removal failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  /** CDP socket 을 닫고 대기 중인 요청을 실패시킨다. */
  private closeSocket(close = true): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP socket closed."));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (close && ws) {
      try {
        ws.close();
      } catch {
        /* 무시 */
      }
    }
  }
}
