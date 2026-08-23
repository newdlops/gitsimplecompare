// VS Code main process inspector와 통신하는 네이티브 editor overlay 공용 CDP 연결.
// - hunk, conflict, blame surface가 하나의 socket과 renderer-event binding을 공유한다.
// - 창 선택과 DOM patch 조립은 각 surface 모듈에 남기고 요청 수명주기만 이 모듈이 맡는다.
import * as vscode from "vscode";
import WebSocket = require("ws");
import { logInfo, logWarn } from "../ui/outputLog";
import {
  armInspector,
  findCurrentVSCodeMainPid,
  findInspectorWebSocketUrlForPid,
} from "./nativeDiffOverlayInspector";

const MAIN_BINDING = "gscNativeDiffOverlayEvent";
const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 2_000;
const RECONNECT_COOLDOWN_MS = 15_000;

/** 응답 ID가 같은 CDP 메시지가 돌아올 때까지 보관할 Promise 제어 정보. */
interface PendingRequest {
  /** CDP 성공 응답을 호출자에게 전달하는 함수 */
  resolve: (value: unknown) => void;
  /** socket 오류나 timeout을 호출자에게 전달하는 함수 */
  reject: (error: Error) => void;
  /** 응답이 영원히 오지 않을 때 pending entry를 정리할 timer */
  timer: ReturnType<typeof setTimeout>;
}

/** renderer binding이 전달한 직렬화 이벤트를 소비하는 callback 타입. */
export type NativeOverlayEventHandler = (payload: string) => void;

/**
 * extension host에서 VS Code main process inspector로 이어지는 연결을 관리한다.
 * - 동시에 시작된 연결 요청을 하나로 합치고 짧은 실패가 반복될 때 port scan을 제한한다.
 * - Runtime.evaluate와 renderer binding 응답을 같은 socket에서 안전하게 multiplex한다.
 */
export class NativeOverlayConnection {
  private ws: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private requestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly discoveryAbort = new AbortController();
  private retryAfter = 0;
  private shuttingDown = false;

  /**
   * inspector 탐색에 필요한 저장소 경로와 renderer 이벤트 소비자를 보관한다.
   * @param globalStorageUri 현재 VS Code main PID를 식별할 global storage URI
   * @param onRendererEvent checkbox 등 renderer binding payload를 처리할 함수
   */
  constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly onRendererEvent: NativeOverlayEventHandler
  ) {}

  /**
   * 현재 socket이 CDP 요청을 즉시 받을 수 있는지 반환한다.
   * @returns WebSocket.OPEN 상태이면 true
   */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 이전 연결 실패 뒤 남은 cooldown 시간을 계산한다.
   * @returns 지금 바로 재시도할 수 있으면 0, 아니면 남은 밀리초
   */
  retryDelayMs(): number {
    return Math.max(0, this.retryAfter - Date.now());
  }

  /**
   * 이미 열린 socket을 재사용하거나 main process inspector 연결을 한 번만 생성한다.
   * - inspector가 허용되지 않는 환경에서는 15초 cooldown으로 반복 port scan을 피한다.
   * @returns 연결과 main binding 등록이 끝나면 resolve되는 Promise
   */
  async ensureConnected(): Promise<void> {
    if (this.isOpen()) {
      return;
    }
    if (this.shuttingDown) {
      throw new Error("Native overlay connection is shutting down.");
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (Date.now() < this.retryAfter) {
      throw new Error("Native overlay inspector reconnect is cooling down.");
    }
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
      this.retryAfter = 0;
    } catch (error) {
      this.retryAfter = Date.now() + RECONNECT_COOLDOWN_MS;
      throw error;
    } finally {
      this.connectPromise = undefined;
    }
  }

  /**
   * main process execution context에서 JavaScript expression을 평가한다.
   * - renderer patch가 반환한 `err:` 진단도 예외로 승격해 surface별 retry가 작동하게 한다.
   * @param expression main process에서 실행할 완전한 JavaScript expression
   * @param timeoutMs 평가 완료를 기다릴 최대 밀리초
   * @returns JSON 직렬화 가능한 Runtime.evaluate 결과값
   */
  async evaluateMain(expression: string, timeoutMs: number): Promise<unknown> {
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
      throw new Error(
        `Main process evaluation failed: ${JSON.stringify(result.exceptionDetails)}`
      );
    }
    const value = result.result?.value;
    const diagnostic = String(value ?? "");
    if (/(?:^|[,|])err:|^no-(?:require|target-window)/.test(diagnostic)) {
      throw new Error(`Renderer evaluation failed: ${diagnostic}`);
    }
    return value;
  }

  /**
   * 종료 중 새 inspector 탐색을 막고 진행 중인 PID/port 검색을 취소한다.
   * - 이미 열린 socket은 renderer cleanup을 위해 close 호출까지 유지한다.
   * @returns 반환값 없음
   */
  beginShutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.discoveryAbort.abort();
  }

  /**
   * main process Runtime에 등록한 renderer-event binding을 best-effort로 제거한다.
   * @returns socket이 없거나 제거가 끝나면 resolve되는 Promise
   */
  async removeMainBinding(): Promise<void> {
    if (!this.isOpen()) {
      return;
    }
    await this.cdpRequest(
      "Runtime.removeBinding",
      { name: MAIN_BINDING },
      1_500
    ).catch((error) => {
      logWarn("native overlay main binding removal failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * socket을 닫고 응답 대기 중인 모든 요청을 명시적인 오류로 종료한다.
   * @param sendCloseFrame false면 이미 닫힌 socket의 close event에서 재진입한 경우
   * @returns 반환값 없음
   */
  close(sendCloseFrame = true): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP socket closed."));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (sendCloseFrame && ws) {
      try {
        ws.close();
      } catch {
        // VS Code 종료와 socket close가 경합하면 이미 닫힌 연결은 그대로 무시한다.
      }
    }
  }

  /**
   * 현재 VS Code main PID를 찾고 inspector를 연 뒤 CDP socket과 binding을 준비한다.
   * @returns Runtime.enable과 Runtime.addBinding까지 완료되면 resolve되는 Promise
   */
  private async connect(): Promise<void> {
    this.close();
    const pid = await findCurrentVSCodeMainPid(this.globalStorageUri.fsPath);
    if (!pid) {
      throw new Error("Could not identify the current VS Code main process.");
    }
    if (this.shuttingDown) {
      throw new Error("Native overlay connection is shutting down.");
    }
    armInspector(pid);
    const wsUrl = await findInspectorWebSocketUrlForPid(
      pid,
      this.discoveryAbort.signal
    );
    if (this.shuttingDown) {
      throw new Error("Native overlay connection is shutting down.");
    }
    if (!wsUrl) {
      throw new Error(`Could not find inspector WebSocket for VS Code PID ${pid}.`);
    }

    const ws = new WebSocket(wsUrl);
    await this.waitForOpen(ws);
    if (this.shuttingDown) {
      try {
        ws.terminate();
      } catch {
        // 종료 직전 연결된 socket은 외부 상태를 남기지 않도록 가능한 경우 즉시 끊는다.
      }
      throw new Error("Native overlay connection is shutting down.");
    }
    this.ws = ws;
    ws.on("message", (data) => this.onCdpMessage(data));
    ws.on("close", () => {
      if (this.ws === ws) {
        this.close(false);
      }
    });
    ws.on("error", (error) => {
      logWarn("native editor overlay CDP socket error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.cdpRequest("Runtime.enable", {}, REQUEST_TIMEOUT_MS);
    await this.cdpRequest(
      "Runtime.addBinding",
      { name: MAIN_BINDING },
      REQUEST_TIMEOUT_MS
    ).catch((error) => {
      if (!/already|exists|duplicate/i.test(String(error.message))) {
        throw error;
      }
    });
    logInfo("native editor overlay connected", { pid, wsUrl });
  }

  /**
   * 새 WebSocket의 open 또는 error 중 먼저 도착한 결과를 timeout과 함께 기다린다.
   * @param ws 아직 연결되지 않은 main inspector WebSocket
   * @returns 연결 성공 시 resolve되고 오류나 timeout이면 reject되는 Promise
   */
  private waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // timeout과 main process 종료가 동시에 일어난 경우 별도 정리가 필요하지 않다.
        }
        reject(new Error("CDP connect timed out"));
      }, CONNECT_TIMEOUT_MS);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * 고유 ID와 timeout을 붙인 CDP 명령을 socket으로 전송한다.
   * @param method Runtime.enable 같은 Chrome DevTools Protocol method
   * @param params method별 직렬화 인자
   * @param timeoutMs 응답을 기다릴 최대 밀리초
   * @returns 같은 ID의 성공 응답 payload
   */
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

  /**
   * socket 메시지를 요청 응답과 renderer binding 이벤트로 나누어 전달한다.
   * @param data WebSocket이 전달한 JSON 문자열 또는 binary payload
   * @returns 반환값 없음
   */
  private onCdpMessage(data: WebSocket.RawData): void {
    let message: {
      id?: number;
      method?: string;
      params?: { name?: string; payload?: unknown };
      error?: { message?: string };
      result?: unknown;
    };
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
        pending.reject(
          new Error(message.error.message || String(message.error))
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      message.method === "Runtime.bindingCalled" &&
      message.params?.name === MAIN_BINDING
    ) {
      this.onRendererEvent(String(message.params.payload || ""));
    }
  }
}
