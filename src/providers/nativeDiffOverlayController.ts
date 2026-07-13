// 네이티브 VS Code diff margin 에 실제 HTML checkbox 를 얹는 renderer overlay.
// - 공식 extension API 가 아니라 VS Code workbench renderer 에 CDP 로 주입하는 배포용 overlay 경로다.
// - 실패 시 decoration/CodeLens fallback 없이 OUTPUT 로그로 상태를 관찰한다.
import { execFileSync } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import WebSocket = require("ws");
import { HunkCheckboxController } from "./hunkCheckboxController";
import { cleanupExpression, injectionExpression, rendererPatchScript } from "./nativeDiffOverlayPatch";
import { shouldRepaintSameSnapshot, snapshotSignature, workspaceHints } from "./nativeDiffOverlaySupport";
import { NativeDiffInitialPaintRetry } from "./nativeDiffOverlayRetry";
import { NativeDiffOverlayEvents } from "./nativeDiffOverlayEvents";
import { activeHunkWorkingModifiedUri } from "./hunkDiffContext";
import { onDidEndDiffOpen } from "./diffOpenGate";
import { logError, logInfo, logWarn } from "../ui/outputLog";

const MAIN_BINDING = "gscNativeDiffOverlayEvent";

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

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
  private disposed = false;
  private lastRenderSignature = "";
  private readonly initialPaintRetry = new NativeDiffInitialPaintRetry();
  private readonly rendererEvents: NativeDiffOverlayEvents;

  constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly hunkCheckboxes: HunkCheckboxController
  ) {
    this.rendererEvents = new NativeDiffOverlayEvents(hunkCheckboxes);
  }
  /** overlay 갱신에 필요한 VS Code 이벤트를 등록한다. */
  register(): vscode.Disposable {
    const disposable = vscode.Disposable.from(
      this.hunkCheckboxes.onDidChangeHunkControls(() =>
        this.scheduleRender("hunkControls")
      ),
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
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRender("save")),
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
      void this.render(reason);
    }, delay);
  }

  /** 현재 설정/active diff 상태를 보고 overlay 를 주입하거나 제거한다. */
  private async render(reason: string): Promise<void> {
    if (this.disposed || !vscode.window.state.focused) {
      return;
    }
    if (this.hunkCheckboxes.mode() !== "nativeOverlay") {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      await this.cleanupRenderer("mode");
      return;
    }
    const snapshots = await this.hunkCheckboxes.overlaySnapshots();
    if (!snapshots.length) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      this.lastRenderSignature = "";
      logInfo("native diff overlay skipped", { reason, snapshotCount: 0 });
      await this.cleanupRenderer("noSnapshot");
      return;
    }
    const signature = snapshotSignature(snapshots);
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
      const result = await this.evaluateMain(
        injectionExpression(rendererPatchScript(), snapshots, workspaceHints()),
        8000
      );
      this.lastRenderSignature = signature;
      this.hunkCheckboxes.setNativeOverlayAvailable(true);
      this.initialPaintRetry.schedule(signature, result, reason, (r, d) => this.scheduleRender(r, d));
      logInfo("native diff overlay rendered", {
        reason,
        paths: snapshots.map((snapshot) => snapshot.path),
        revisions: snapshots.map((snapshot) => snapshot.revision),
        lines: snapshots.reduce((sum, snapshot) => sum + snapshot.lines.length, 0),
        lineBreakdown: snapshots.map((snapshot) => ({
          path: snapshot.path,
          action: snapshot.action,
          lines: snapshot.lines.length,
          original: snapshot.lines.filter((line) => line.side === "original").length,
          modified: snapshot.lines.filter((line) => line.side === "modified").length,
          checked: snapshot.lines.filter((line) => line.checked).length,
          sample: snapshot.lines.slice(0, 5).map((line) =>
            `${line.side}:${line.line}:${line.lineIds.join(",")}${line.checked ? ":checked" : ""}`
          ),
        })),
        result: String(result ?? ""),
      });
    } catch (error) {
      this.hunkCheckboxes.setNativeOverlayAvailable(false);
      logError("native diff overlay render failed", error, { reason });
      this.closeSocket();
    }
  }

  /**
   * 문서 변경 이벤트 중 overlay 재주입이 필요한 대상만 고른다.
   * - OUTPUT 채널 로그 변경도 TextDocument 변경으로 들어오므로 active diff 문서만 통과시킨다.
   * @param uri 변경된 문서 URI
   */
  private shouldRenderForDocumentChange(uri: vscode.Uri): boolean {
    const modified = activeHunkWorkingModifiedUri();
    return !!modified && modified.toString() === uri.toString();
  }

  /** renderer 에 남아 있는 checkbox overlay 를 제거한다. */
  private async cleanupRenderer(reason: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      await this.evaluateMain(cleanupExpression(workspaceHints()), 2500);
      logInfo("native diff overlay cleaned", { reason });
    } catch (error) {
      logWarn("native diff overlay cleanup failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
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
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  /** 실제 CDP socket 연결 절차. ensureConnected 가 동시 호출을 단일화한다. */
  private async connect(): Promise<void> {
    this.closeSocket();
    const pid = findCurrentVSCodeMainPid(this.globalStorageUri.fsPath);
    if (!pid) {
      throw new Error("Could not identify the current VS Code main process.");
    }
    armInspector(pid);
    const wsUrl = await findInspectorWebSocketUrlForPid(pid);
    if (!wsUrl) {
      throw new Error(`Could not find inspector WebSocket for VS Code PID ${pid}.`);
    }
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connect timed out")),
        3000
      );
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
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
    return result.result?.value;
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

  /** 타이머/socket/pending 요청을 정리한다. */
  private dispose(): void {
    this.disposed = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.initialPaintRetry.clear();
    this.closeSocket();
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

/** 현재 확장 host 가 속한 VS Code main process pid 를 찾는다. */
function findCurrentVSCodeMainPid(globalStorageFsPath: string): number | undefined {
  const rows = listProcessRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const mainRows = rows.filter((row) => isVSCodeMainProcess(row.command));
  const userDataDir = deriveUserDataDirHint(globalStorageFsPath);
  if (userDataDir) {
    const hinted = mainRows.filter((row) =>
      commandHasUserDataDir(row.command, userDataDir)
    );
    if (hinted.length === 1) {
      return hinted[0].pid;
    }
  }
  const seen = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) {
      break;
    }
    if (isVSCodeMainProcess(row.command)) {
      return row.pid;
    }
    pid = row.ppid;
  }
  const envPid = Number(process.env.VSCODE_PID || "");
  if (envPid && isVSCodeMainProcess(byPid.get(envPid)?.command ?? "")) {
    return envPid;
  }
  return mainRows.length === 1 ? mainRows[0].pid : undefined;
}

/** `ps` 로 프로세스 테이블을 읽는다. */
function listProcessRows(): ProcessRow[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    return out.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
        : [];
    });
  } catch (error) {
    logWarn("native diff overlay process scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** VS Code/Electron main process 명령인지 판별한다. */
function isVSCodeMainProcess(command: string): boolean {
  return /\/Contents\/MacOS\/(?:Code|Code - Insiders|Code - OSS|Electron)(?:\s+--|$)/.test(command);
}

/** globalStorage 경로에서 user-data-dir 힌트를 역산한다. */
function deriveUserDataDirHint(globalStorageFsPath: string): string | undefined {
  const marker = `${path.sep}User${path.sep}globalStorage${path.sep}`;
  const index = globalStorageFsPath.indexOf(marker);
  return index >= 0 ? globalStorageFsPath.slice(0, index) : undefined;
}

/** main process command line 이 같은 user-data-dir 을 가리키는지 확인한다. */
function commandHasUserDataDir(command: string, userDataDir: string): boolean {
  return (
    command.includes(`--user-data-dir=${userDataDir}`) ||
    command.includes(`--user-data-dir ${userDataDir}`) ||
    command.includes(`--user-data-dir="${userDataDir}"`) ||
    command.includes(`--user-data-dir "${userDataDir}"`) ||
    command.includes(`--user-data-dir='${userDataDir}'`)
  );
}

/** SIGUSR1 로 main process inspector 를 켠다. */
function armInspector(pid: number): void {
  try {
    process.kill(pid, "SIGUSR1");
  } catch (error) {
    logWarn("native diff overlay inspector arm failed", {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** main process pid 와 일치하는 inspector WebSocket URL 을 찾는다. */
async function findInspectorWebSocketUrlForPid(pid: number): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt === 0 ? 500 : 350 * attempt);
    for (let port = 9229; port <= 9249; port++) {
      const url = await inspectorUrlForPort(port, pid);
      if (url) {
        return url;
      }
    }
    armInspector(pid);
  }
  return undefined;
}

/** 한 포트의 inspector target 목록에서 원하는 pid 를 찾는다. */
async function inspectorUrlForPort(
  port: number,
  pid: number
): Promise<string | undefined> {
  let targets: any[];
  try {
    targets = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
  } catch {
    return undefined;
  }
  for (const target of targets) {
    const wsUrl = String(target?.webSocketDebuggerUrl || "");
    if (!wsUrl) {
      continue;
    }
    try {
      const value = await probeProcessPid(wsUrl);
      if (value === pid) {
        return wsUrl;
      }
    } catch {
      /* 다음 target 검사 */
    }
  }
  return undefined;
}

/** HTTP GET 을 timeout 과 함께 실행한다. */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** inspector target 의 process.pid 값을 읽는다. */
function probeProcessPid(wsUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("pid probe timed out"));
    }, 900);
    ws.once("open", () => {
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
        expression: "process.pid",
        returnByValue: true,
      } }));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(Number(message.result?.result?.value));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** Promise 기반 sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
