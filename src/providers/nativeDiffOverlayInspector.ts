// VS Code main process inspector를 찾고 CDP target URL을 준비하는 transport 보조 모듈.
// - renderer overlay의 UI 상태와 분리해 프로세스 탐색/HTTP probe/SIGUSR1 절차만 담당한다.
import { execFileSync } from "node:child_process";
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
export function findCurrentVSCodeMainPid(
  globalStorageFsPath: string
): number | undefined {
  const rows = listProcessRows();
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
  pid: number
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt === 0 ? 500 : 350 * attempt);
    for (let port = 9229; port <= 9249; port++) {
      const url = await inspectorUrlForPort(port, pid);
      if (url) return url;
    }
    armInspector(pid);
  }
  return undefined;
}

/** `ps`로 프로세스 테이블을 읽는다. */
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

/** 한 포트의 inspector target 목록에서 원하는 pid를 찾는다. */
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
    if (!wsUrl) continue;
    try {
      if (await probeProcessPid(wsUrl) === pid) return wsUrl;
    } catch {
      /* 다음 target 검사 */
    }
  }
  return undefined;
}

/** HTTP GET을 timeout과 함께 실행한다. */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** inspector target의 process.pid 값을 읽는다. */
function probeProcessPid(wsUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("pid probe timed out"));
    }, 900);
    ws.once("open", () => ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression: "process.pid", returnByValue: true },
    })));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== id) return;
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

/** Promise 기반 짧은 대기다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
