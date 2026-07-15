// VS Code main process inspector를 찾고 CDP target URL을 준비하는 transport 보조 모듈.
// - renderer overlay의 UI 상태와 분리해 프로세스 탐색/HTTP probe/SIGUSR1 절차만 담당한다.
import { execFile } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import WebSocket = require("ws");
import { logWarn } from "../ui/outputLog";

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** 현재 extension host가 속한 VS Code main process pid를 찾는다. */
export async function findCurrentVSCodeMainPid(
  globalStorageFsPath: string
): Promise<number | undefined> {
  const rows = await listProcessRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const mainRows = rows.filter((row) => isVSCodeMainProcess(row.command));
  const userDataDir = deriveUserDataDirHint(globalStorageFsPath);
  if (userDataDir) {
    const hinted = mainRows.filter((row) =>
      commandHasUserDataDir(row.command, userDataDir)
    );
    if (hinted.length === 1) return hinted[0].pid;
  }
  const seen = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) break;
    if (isVSCodeMainProcess(row.command)) return row.pid;
    pid = row.ppid;
  }
  const envPid = Number(process.env.VSCODE_PID || "");
  if (envPid && isVSCodeMainProcess(byPid.get(envPid)?.command ?? "")) {
    return envPid;
  }
  return mainRows.length === 1 ? mainRows[0].pid : undefined;
}

/** SIGUSR1로 main process inspector를 켠다. */
export function armInspector(pid: number): void {
  try {
    process.kill(pid, "SIGUSR1");
  } catch (error) {
    logWarn("native editor overlay inspector arm failed", {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** main process pid와 일치하는 inspector WebSocket URL을 찾는다. */
export async function findInspectorWebSocketUrlForPid(
  pid: number,
  signal?: AbortSignal
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!await sleep(attempt === 0 ? 500 : 350 * attempt, signal)) return undefined;
    const targetGroups = await Promise.all(
      Array.from({ length: 21 }, (_, index) => 9229 + index)
        .map((port) => inspectorUrlsForPort(port, signal))
    );
    if (signal?.aborted) return undefined;
    // HTTP port 탐색만 병렬화하고 실제 debugger target 연결은 순차 처리해 다른 Node inspector와의 경합을 줄인다.
    const urls = [...new Set(targetGroups.flat())];
    for (const url of urls) {
      if (signal?.aborted) return undefined;
      try {
        if (await probeProcessPid(url, signal) === pid) return url;
      } catch {
        /* 다음 target 검사 */
      }
    }
    if (signal?.aborted) return undefined;
    armInspector(pid);
  }
  return undefined;
}

/** `ps`로 프로세스 테이블을 읽는다. */
async function listProcessRows(): Promise<ProcessRow[]> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-Ao", "pid=,ppid=,command="], {
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    return out.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
        : [];
    });
  } catch (error) {
    logWarn("native editor overlay process scan failed", {
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

/** main process command line이 같은 user-data-dir을 가리키는지 확인한다. */
function commandHasUserDataDir(command: string, userDataDir: string): boolean {
  return (
    command.includes(`--user-data-dir=${userDataDir}`) ||
    command.includes(`--user-data-dir ${userDataDir}`) ||
    command.includes(`--user-data-dir="${userDataDir}"`) ||
    command.includes(`--user-data-dir "${userDataDir}"`) ||
    command.includes(`--user-data-dir='${userDataDir}'`)
  );
}

/** 한 포트의 inspector target 목록에서 WebSocket URL만 안전하게 추출한다. */
async function inspectorUrlsForPort(
  port: number,
  signal?: AbortSignal
): Promise<string[]> {
  let targets: any[];
  try {
    targets = JSON.parse(await httpGet(
      `http://127.0.0.1:${port}/json/list`,
      signal
    ));
  } catch {
    return [];
  }
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => safeInspectorWebSocketUrl(
      String(target?.webSocketDebuggerUrl || ""),
      port
    ))
    .filter((url): url is string => !!url);
}

/** localhost의 예상 포트로 돌아오는 inspector WebSocket URL만 허용한다. */
function safeInspectorWebSocketUrl(value: string, expectedPort: number): string | undefined {
  try {
    const url = new URL(value);
    const localHost =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";
    return url.protocol === "ws:" && localHost && url.port === String(expectedPort)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** HTTP GET을 absolute timeout, abort, 응답 크기 제한과 함께 실행한다. */
function httpGet(url: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("inspector HTTP probe cancelled"));
      return;
    }
    let settled = false;
    let req: http.ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, body?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        try { req?.destroy(); } catch { /* 무시 */ }
        reject(error);
      } else {
        resolve(body ?? "");
      }
    };
    const onAbort = (): void =>
      finish(new Error("inspector HTTP probe cancelled"));
    timer = setTimeout(
      () => finish(new Error("inspector HTTP probe timed out")),
      500
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
        if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
          finish(new Error("inspector HTTP response was too large"));
        }
      });
      res.on("end", () => finish(undefined, body));
    });
    req.on("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error)))
    );
  });
}

/** inspector target의 process.pid 값을 읽고 shutdown signal이 오면 즉시 연결을 끝낸다. */
function probeProcessPid(wsUrl: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    let settled = false;
    const finish = (error?: Error, pid?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { ws.close(); } catch { /* 무시 */ }
      if (error) reject(error);
      else resolve(pid ?? 0);
    };
    const onAbort = (): void => finish(new Error("pid probe cancelled"));
    const timer = setTimeout(() => {
      finish(new Error("pid probe timed out"));
    }, 600);
    if (signal?.aborted) {
      finish(new Error("pid probe cancelled"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression: "process.pid", returnByValue: true },
    })));
    ws.on("message", (data) => {
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        finish(new Error("inspector pid probe returned invalid JSON"));
        return;
      }
      if (message.id !== id) return;
      finish(undefined, Number(message.result?.result?.value));
    });
    ws.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** inspector 재시도 대기를 shutdown signal로 중단할 수 있게 만든다. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
