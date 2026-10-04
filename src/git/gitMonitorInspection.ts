import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { containsPath, gitProcesses } from "./gitProcessRegistry";
import { readProcessIdentities, sameProcess, type ProcessIdentity } from "./processIdentity";
import { runGit, type RunGitOptions } from "./gitExec";
import type { GitMonitorSnapshot, IdleGitCandidate } from "./idleGitCleanup";
import { forgetPreparedFsmonitor } from "./ownedFsmonitor";

interface OpenPath { pid: number; file: string }

/** OS 경계만 주입해 실제 프로세스 식별·저장소 매핑·사용 보호를 독립적으로 검증한다. */
export interface GitMonitorInspectionDeps {
  platform: string; uid: number | undefined;
  processes(): Promise<ProcessIdentity[]>;
  windowCount(pids: readonly number[]): Promise<number | undefined>;
  openPaths(args: string[]): Promise<string>;
  readText(file: string): Promise<string>;
  canonical(file: string): Promise<string>;
  socketIdentity(file: string): Promise<string | undefined>;
  owned(pid: number, root: string): boolean;
  stop?(args: string[], root: string, options: RunGitOptions): Promise<unknown>;
}
const systemInspection: GitMonitorInspectionDeps = {
  platform: process.platform, uid: process.getuid?.(), processes: readProcessIdentities, openPaths: lsof,
  windowCount: readCodeWindowCount,
  readText: file => readFile(file, "utf8"), canonical: realpath,
  socketIdentity: async file => { const info = await stat(file); return info.isSocket() ? `${info.dev}:${info.ino}` : undefined; },
  owned: (pid, root) => gitProcesses.ownsMonitor(pid, root),
};

/**
 * macOS에서 같은 사용자 Git의 감시 소켓과 다른 프로세스/Code 창 사용을 함께 확인한다.
 * @param protectedRoots 현재 확장의 workspace·열린 문서 등 항상 보호할 경로
 * @returns 소유권/활성 사용을 검증한 목록. 미지원·부분 관찰은 complete=false다.
 */
export async function inspectGitMonitors(protectedRoots: readonly string[], deps: GitMonitorInspectionDeps = systemInspection): Promise<GitMonitorSnapshot> {
  if (deps.platform !== "darwin" || deps.uid === undefined) return { complete: false, monitors: [], reason: "unsupported-monitor-ownership-platform" };
  try {
    const processes = await deps.processes();
    const ownedUser = processes.filter(item => item.uid === deps.uid);
    const git = ownedUser.filter(item => path.basename(item.executable) === "git");
    if (!git.length) return { complete: true, monitors: [] };
    const code = ownedUser.filter(item => /Visual Studio Code|Code Helper|VSCodium/.test(item.executable));
    const [cwdOutput, socketOutput, codeOutput] = await Promise.all([
      deps.openPaths(["-u", String(deps.uid), "-d", "cwd"]),
      deps.openPaths(["-a", "-p", git.map(item => item.pid).join(","), "-U"]),
      code.length ? deps.openPaths(["-a", "-p", code.map(item => item.pid).join(",")]) : Promise.resolve(""),
    ]);
    const workingDirectories = parseLsofPaths(cwdOutput);
    const sockets = parseLsofPaths(socketOutput).filter(item => item.file.endsWith("/fsmonitor--daemon.ipc"));
    const relativePids = relativeSocketPids(socketOutput);
    if (relativePids.length) {
      const open = parseLsofPaths(await deps.openPaths(["-a", "-p", relativePids.join(",")]));
      for (const pid of relativePids) {
        const possible = new Set<string>();
        for (const item of open.filter(item => item.pid === pid)) {
          const socket = await socketForOpenWorktree(item.file, deps);
          if (socket) possible.add(socket);
        }
        // 모호한 여러 저장소를 추측하지 않는다. 확인하지 못한 Git은 아래에서 다른 작업으로 보호한다.
        if (possible.size === 1) sockets.push({ pid, file: [...possible][0] });
      }
    }
    const openFiles = parseLsofPaths(codeOutput);
    const workspaceFiles = [...new Set(openFiles.filter(item => /[/\\]workspaceStorage[/\\][^/\\]+[/\\]state\.vscdb(?:-wal|-shm)?$/.test(item.file))
      .map(item => path.join(path.dirname(item.file), "workspace.json")))];
    const codeRoots: string[] = [];
    for (const file of workspaceFiles) {
      try {
        const workspace = JSON.parse(await deps.readText(file)) as { folder?: string; workspace?: string };
        if (workspace.folder?.startsWith("file:")) codeRoots.push(await deps.canonical(fileUriPath(workspace.folder)));
        else if (workspace.workspace?.startsWith("file:")) {
          const configFile = fileUriPath(workspace.workspace);
          const config = JSON.parse(await deps.readText(configFile)) as { folders?: { path?: string; uri?: string }[] };
          for (const folder of config.folders ?? []) {
            if (folder.path) codeRoots.push(await deps.canonical(path.resolve(path.dirname(configFile), folder.path)));
            else if (folder.uri?.startsWith("file:")) codeRoots.push(await deps.canonical(fileUriPath(folder.uri)));
            else return { complete: false, monitors: [], reason: "unmapped-code-workspace" };
          }
        } else return { complete: false, monitors: [], reason: "unmapped-code-workspace" };
      } catch { return { complete: false, monitors: [], reason: "unreadable-code-workspace" }; }
    }
    const rendererPids = code.filter(item => /Code Helper \(Renderer\)|VSCodium Helper \(Renderer\)/.test(item.executable)).map(item => item.pid);
    // 웹뷰는 별도 renderer라도 같은 window-config를 상속한다. renderer 개수로 창을 세면 정상 매핑도 항상 불완전해진다.
    const windowCount = await deps.windowCount(rendererPids);
    if (code.length && (!workspaceFiles.length || windowCount === undefined || workspaceFiles.length < windowCount)) return { complete: false, monitors: [], reason: "code-window-usage-unavailable" };
    // cwd 밖의 --git-dir/환경으로 쓰는 Git도 보호한다. 저장소를 입증하지 못한 일반 Git이 있으면 모든 감시자 정리를 보류한다.
    const monitorPids = new Set(sockets.map(item => item.pid));
    const otherGitActive = git.some(item => !monitorPids.has(item.pid));
    const monitors: GitMonitorSnapshot["monitors"] = [];
    for (const socket of sockets) {
      const identity = git.find(item => item.pid === socket.pid);
      if (!identity) continue;
      const root = await repositoryForSocket(socket.file, deps);
      const cwd = workingDirectories.find(item => item.pid === identity.pid)?.file;
      // Git은 detach 뒤 홈 디렉터리로 이동한다. 저장소 증거는 cwd가 아니라 실제 IPC 소켓과 .git/backlink다.
      if (!root || !cwd) continue;
      const socketIdentity = await deps.socketIdentity(socket.file);
      if (!socketIdentity) continue;
      const usedByProcess = workingDirectories.some(item => item.pid !== identity.pid && containsPath(root, item.file));
      const usedByCode = [...protectedRoots, ...codeRoots].some(item => containsPath(root, item) || containsPath(item, root));
      monitors.push({ identity, repoRoot: root, socket: socket.file, socketIdentity,
        owned: deps.owned(identity.pid, root), protectedReason: usedByCode ? "open-code-workspace-or-document" : usedByProcess ? "active-terminal-or-process" : otherGitActive ? "other-git-process-active" : undefined });
    }
    const latest = await deps.processes();
    if (latest.some(item => item.uid === deps.uid && /Visual Studio Code|Code Helper|VSCodium/.test(item.executable)
      && !code.some(before => sameProcess(before, item)))) return { complete: false, monitors: [], reason: "code-window-usage-changed" };
    return { complete: true, observedCode: code, monitors: monitors.filter(item => sameProcess(item.identity, latest.find(current => current.pid === item.identity.pid))) };
  } catch { return { complete: false, monitors: [], reason: "process-or-socket-inspection-unavailable" }; }
}

/** 실행 옵션 전체는 보관/로그하지 않고 동일 창을 나타내는 window-config 식별자 개수만 반환한다. */
function readCodeWindowCount(pids: readonly number[]): Promise<number | undefined> {
  if (!pids.length) return Promise.resolve(0);
  return new Promise((resolve, reject) => execFile("/bin/ps", ["-p", pids.join(","), "-o", "pid=,args="],
    { encoding: "utf8", timeout: 2000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      if (error) reject(error); else resolve(parseCodeWindowCount(output, pids));
    }));
}

/** 보조 웹뷰의 중복 window-config를 합치며 식별자가 없는 renderer는 미확인으로 보호한다. */
export function parseCodeWindowCount(output: string, pids: readonly number[]): number | undefined {
  const identities = new Map<number, string>();
  for (const line of output.split("\n")) {
    const pid = /^\s*(\d+)\s+/.exec(line)?.[1];
    const config = /(?:^|\s)--vscode-window-config=(vscode:[^\s]+)/.exec(line)?.[1];
    if (pid && config) identities.set(Number(pid), config);
  }
  return pids.every(pid => identities.has(pid)) ? new Set(pids.map(pid => identities.get(pid))).size : undefined;
}

/** 공식 Git stop만 실행하고 대상 PID가 종료/교체됐는지 확인한다. index나 lock을 삭제하지 않는다. */
export async function stopGitMonitor(candidate: IdleGitCandidate, canStop: () => boolean, protectedRoots: () => readonly string[] = () => [], deps: GitMonitorInspectionDeps = systemInspection): Promise<void> {
  const snapshot = await inspectGitMonitors(protectedRoots(), deps);
  const target = snapshot.monitors.find(item => sameProcess(candidate.identity, item.identity) && item.repoRoot === candidate.repoRoot
    && item.socket === candidate.socket && item.socketIdentity === candidate.socketIdentity);
  if (!snapshot.complete || !target || target.protectedReason) throw new DOMException("Repository use changed before stop.", "AbortError");
  const cwd = parseLsofPaths(await deps.openPaths(["-u", String(deps.uid), "-d", "cwd"]));
  const latest = await deps.processes();
  const before = latest.find(item => item.pid === candidate.identity.pid);
  const socketIdentity = await deps.socketIdentity(candidate.socket);
  const root = await repositoryForSocket(candidate.socket, deps);
  if (!sameProcess(candidate.identity, before) || root !== candidate.repoRoot || socketIdentity !== candidate.socketIdentity) throw new Error("Monitor ownership changed before stop.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const knownMonitors = new Set(snapshot.monitors.map(item => item.identity.pid));
    const newGit = latest.some(item => item.uid === deps.uid && path.basename(item.executable) === "git" && !knownMonitors.has(item.pid));
    const newCode = latest.some(item => item.uid === deps.uid && /Visual Studio Code|Code Helper|VSCodium/.test(item.executable)
      && !snapshot.observedCode?.some(previous => sameProcess(previous, item)));
    const terminalUse = cwd.some(item => item.pid !== candidate.identity.pid && containsPath(candidate.repoRoot, item.file));
    const newlyProtected = protectedRoots().some(item => containsPath(candidate.repoRoot, item) || containsPath(item, candidate.repoRoot));
    if (newGit || newCode || terminalUse || newlyProtected || !canStop()) throw new DOMException("Repository activity resumed or cleanup was cancelled.", "AbortError");
    // cwd만 지정하면 상속 GIT_DIR/socketDir가 다른 저장소를 가리킬 수 있어 검증한 IPC 경계를 직접 고정한다.
    const gitDir = path.dirname(candidate.socket);
    await (deps.stop ?? runGit)(["--git-dir", gitDir, "--work-tree", candidate.repoRoot, "-c", `fsmonitor.socketDir=${gitDir}`, "fsmonitor--daemon", "stop"],
      candidate.repoRoot, { retryOnLock: false, signal: controller.signal, clearEnv: Object.keys(process.env).filter(name => name.startsWith("GIT_")) });
  }
  finally { clearTimeout(timer); }
  for (let attempt = 0; attempt < 10; attempt++) {
    const after = (await deps.processes()).find(item => item.pid === candidate.identity.pid);
    if (!sameProcess(candidate.identity, after)) { forgetPreparedFsmonitor(candidate.repoRoot); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Git did not confirm monitor shutdown.");
}

/** lsof는 파일이 하나도 없을 때만 exit=1을 허용하며 경고/잘린 출력은 완전한 관찰로 쓰지 않는다. */
function lsof(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("/usr/sbin/lsof", ["-nP", ...args, "-F0pn"],
    { encoding: "utf8", timeout: 8000, maxBuffer: 32 * 1024 * 1024 }, (error, output, stderr) => {
      if (stderr.trim() || (error && !(error.code === 1 && !output))) reject(error ?? new Error("Partial lsof output."));
      else resolve(output);
    }));
}

/** 개행이 포함된 파일명도 NUL 필드 경계로 읽으며 PID 없는 경로는 무시한다. */
export function parseLsofPaths(output: string): OpenPath[] {
  const result: OpenPath[] = []; let pid: number | undefined;
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (field.startsWith("p")) pid = Number(field.slice(1));
    else if (pid && field.startsWith("n/")) result.push({ pid, file: field.slice(1) });
  }
  return result;
}

/** 상대 이름으로 bind된 서버 소켓 PID만 추출하고 일반 Git IPC 클라이언트는 포함하지 않는다. */
function relativeSocketPids(output: string): number[] {
  const pids = new Set<number>(); let pid: number | undefined;
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (field.startsWith("p")) pid = Number(field.slice(1));
    else if (pid && field === "nfsmonitor--daemon.ipc") pids.add(pid);
  }
  return [...pids];
}

/** Git이 열어 둔 worktree 디렉터리의 .git marker와 실제 IPC 소켓을 함께 입증한다. */
async function socketForOpenWorktree(directory: string, deps: GitMonitorInspectionDeps): Promise<string | undefined> {
  try {
    let gitDir = path.join(directory, ".git");
    try {
      const target = /^gitdir:\s*(.+)\s*$/i.exec((await deps.readText(gitDir)).trim())?.[1];
      if (!target) return undefined;
      gitDir = path.resolve(directory, target);
    } catch { /* 일반 .git directory는 readText 대신 아래 HEAD/backlink로 확인한다. */ }
    const socket = path.join(gitDir, "fsmonitor--daemon.ipc");
    if (await repositoryForSocket(socket, deps) !== await deps.canonical(directory)) return undefined;
    return await deps.socketIdentity(socket) ? socket : undefined;
  } catch { return undefined; }
}

/** socket의 Git directory와 실제 .git/backlink를 양방향 확인해 홈 cwd에 의존하지 않는다. */
async function repositoryForSocket(socket: string, deps: GitMonitorInspectionDeps = systemInspection): Promise<string | undefined> {
  try {
    const gitDir = await deps.canonical(path.dirname(socket));
    if (!(await deps.readText(path.join(gitDir, "HEAD"))).trim()) return undefined;
    if (path.basename(gitDir) === ".git") {
      const root = await deps.canonical(path.dirname(gitDir));
      return await deps.canonical(path.join(root, ".git")) === gitDir ? root : undefined;
    }
    const marker = (await deps.readText(path.join(gitDir, "gitdir"))).trim();
    const root = await deps.canonical(path.dirname(marker));
    const target = /^gitdir:\s*(.+)\s*$/i.exec((await deps.readText(path.join(root, ".git"))).trim())?.[1];
    return target && await deps.canonical(path.resolve(root, target)) === gitDir ? root : undefined;
  }
  catch { return undefined; }
}

/** 로컬 file URI만 OS 경로로 되돌리며 다른 호스트의 저장소는 관찰하지 않는다. */
function fileUriPath(uri: string): string {
  const value = new URL(uri);
  if (value.host && value.host !== "localhost") throw new Error("Non-local workspace.");
  return decodeURIComponent(value.pathname);
}
