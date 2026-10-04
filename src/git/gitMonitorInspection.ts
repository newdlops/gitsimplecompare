import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { containsPath, gitProcesses } from "./gitProcessRegistry";
import { readProcessIdentities, sameProcess } from "./processIdentity";
import { runGit } from "./gitExec";
import type { GitMonitorSnapshot, IdleGitCandidate } from "./idleGitCleanup";
import { forgetPreparedFsmonitor } from "./ownedFsmonitor";

interface OpenPath { pid: number; file: string }

/**
 * macOS에서 같은 사용자 Git의 감시 소켓과 다른 프로세스/Code 창 사용을 함께 확인한다.
 * @param protectedRoots 현재 확장의 workspace·열린 문서 등 항상 보호할 경로
 * @returns 소유권/활성 사용을 검증한 목록. 미지원·부분 관찰은 complete=false다.
 */
export async function inspectGitMonitors(protectedRoots: readonly string[]): Promise<GitMonitorSnapshot> {
  if (process.platform !== "darwin" || !process.getuid) return { complete: false, monitors: [], reason: "unsupported-monitor-ownership-platform" };
  try {
    const processes = await readProcessIdentities();
    const ownedUser = processes.filter(item => item.uid === process.getuid!());
    const git = ownedUser.filter(item => path.basename(item.executable) === "git");
    if (!git.length) return { complete: true, monitors: [] };
    const code = ownedUser.filter(item => /Visual Studio Code|Code Helper|VSCodium/.test(item.executable));
    const [cwdOutput, socketOutput, codeOutput] = await Promise.all([
      lsof(["-u", String(process.getuid()), "-d", "cwd"]),
      lsof(["-a", "-p", git.map(item => item.pid).join(","), "-U"]),
      code.length ? lsof(["-a", "-p", code.map(item => item.pid).join(",")]) : Promise.resolve(""),
    ]);
    const workingDirectories = parseLsofPaths(cwdOutput);
    const sockets = parseLsofPaths(socketOutput).filter(item => item.file.endsWith("/fsmonitor--daemon.ipc"));
    const openFiles = parseLsofPaths(codeOutput);
    const workspaceFiles = [...new Set(openFiles.filter(item => /[/\\]workspaceStorage[/\\][^/\\]+[/\\]state\.vscdb(?:-wal|-shm)?$/.test(item.file))
      .map(item => path.join(path.dirname(item.file), "workspace.json")))];
    const codeRoots: string[] = [];
    for (const file of workspaceFiles) {
      try {
        const workspace = JSON.parse(await readFile(file, "utf8")) as { folder?: string; workspace?: string };
        if (workspace.folder?.startsWith("file:")) codeRoots.push(await realpath(fileUriPath(workspace.folder)));
        else if (workspace.workspace?.startsWith("file:")) {
          const configFile = fileUriPath(workspace.workspace);
          const config = JSON.parse(await readFile(configFile, "utf8")) as { folders?: { path?: string; uri?: string }[] };
          for (const folder of config.folders ?? []) {
            if (folder.path) codeRoots.push(await realpath(path.resolve(path.dirname(configFile), folder.path)));
            else if (folder.uri?.startsWith("file:")) codeRoots.push(await realpath(fileUriPath(folder.uri)));
            else return { complete: false, monitors: [], reason: "unmapped-code-workspace" };
          }
        } else return { complete: false, monitors: [], reason: "unmapped-code-workspace" };
      } catch { return { complete: false, monitors: [], reason: "unreadable-code-workspace" }; }
    }
    const rendererCount = code.filter(item => /Code Helper \(Renderer\)|VSCodium Helper \(Renderer\)/.test(item.executable)).length;
    if (code.length && (!workspaceFiles.length || workspaceFiles.length < rendererCount)) return { complete: false, monitors: [], reason: "code-window-usage-unavailable" };
    // cwd 밖의 --git-dir/환경으로 쓰는 Git도 보호한다. 저장소를 입증하지 못한 일반 Git이 있으면 모든 감시자 정리를 보류한다.
    const monitorPids = new Set(sockets.map(item => item.pid));
    const otherGitActive = git.some(item => !monitorPids.has(item.pid));
    const monitors: GitMonitorSnapshot["monitors"] = [];
    for (const socket of sockets) {
      const identity = git.find(item => item.pid === socket.pid);
      if (!identity) continue;
      const root = await repositoryForSocket(socket.file);
      const cwd = workingDirectories.find(item => item.pid === identity.pid)?.file;
      if (!root || !cwd || !containsPath(root, await realpath(cwd))) continue;
      const info = await stat(socket.file);
      if (!info.isSocket()) continue;
      const current = (await readProcessIdentities()).find(item => item.pid === identity.pid);
      if (!sameProcess(identity, current)) continue;
      const usedByProcess = workingDirectories.some(item => item.pid !== identity.pid && containsPath(root, item.file));
      const usedByCode = [...protectedRoots, ...codeRoots].some(item => containsPath(root, item) || containsPath(item, root));
      monitors.push({ identity, repoRoot: root, socket: socket.file, socketIdentity: `${info.dev}:${info.ino}`,
        owned: gitProcesses.ownsMonitor(identity.pid, root), protectedReason: usedByCode ? "open-code-workspace-or-document" : usedByProcess ? "active-terminal-or-process" : otherGitActive ? "other-git-process-active" : undefined });
    }
    return { complete: true, monitors };
  } catch { return { complete: false, monitors: [], reason: "process-or-socket-inspection-unavailable" }; }
}

/** 공식 Git stop만 실행하고 대상 PID가 종료/교체됐는지 확인한다. index나 lock을 삭제하지 않는다. */
export async function stopGitMonitor(candidate: IdleGitCandidate, canStop: () => boolean, protectedRoots: () => readonly string[] = () => []): Promise<void> {
  const snapshot = await inspectGitMonitors(protectedRoots());
  const target = snapshot.monitors.find(item => sameProcess(candidate.identity, item.identity) && item.repoRoot === candidate.repoRoot
    && item.socket === candidate.socket && item.socketIdentity === candidate.socketIdentity);
  if (!snapshot.complete || !target || target.protectedReason) throw new DOMException("Repository use changed before stop.", "AbortError");
  const latest = await readProcessIdentities();
  const before = latest.find(item => item.pid === candidate.identity.pid);
  const socket = await stat(candidate.socket);
  const root = await repositoryForSocket(candidate.socket);
  if (!sameProcess(candidate.identity, before) || root !== candidate.repoRoot || !socket.isSocket() || `${socket.dev}:${socket.ino}` !== candidate.socketIdentity) throw new Error("Monitor ownership changed before stop.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const knownMonitors = new Set(snapshot.monitors.map(item => item.identity.pid));
    const newGit = latest.some(item => item.uid === process.getuid?.() && path.basename(item.executable) === "git" && !knownMonitors.has(item.pid));
    const newlyProtected = protectedRoots().some(item => containsPath(candidate.repoRoot, item) || containsPath(item, candidate.repoRoot));
    if (newGit || newlyProtected || !canStop()) throw new DOMException("Repository activity resumed or cleanup was cancelled.", "AbortError");
    await runGit(["fsmonitor--daemon", "stop"], candidate.repoRoot, { retryOnLock: false, signal: controller.signal });
  }
  finally { clearTimeout(timer); }
  for (let attempt = 0; attempt < 10; attempt++) {
    const after = (await readProcessIdentities()).find(item => item.pid === candidate.identity.pid);
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

/** 일반 .git/ 및 linked worktree의 backlink만 검증하고 불명확한 소켓 배치는 보호한다. */
async function repositoryForSocket(socket: string): Promise<string | undefined> {
  const gitDir = path.dirname(socket);
  if (path.basename(gitDir) === ".git") return realpath(path.dirname(gitDir));
  try { return await realpath(path.dirname((await readFile(path.join(gitDir, "gitdir"), "utf8")).trim())); }
  catch { return undefined; }
}

/** 로컬 file URI만 OS 경로로 되돌리며 다른 호스트의 저장소는 관찰하지 않는다. */
function fileUriPath(uri: string): string {
  const value = new URL(uri);
  if (value.host && value.host !== "localhost") throw new Error("Non-local workspace.");
  return decodeURIComponent(value.pathname);
}
