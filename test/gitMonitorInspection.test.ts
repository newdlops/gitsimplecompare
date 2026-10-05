import assert from "node:assert/strict";
import test from "node:test";
import { inspectGitMonitors, stopGitMonitor, parseCodeWindowCount, applyLocalMonitorProtection, type GitMonitorInspectionDeps } from "../src/git/gitMonitorInspection";
import type { ProcessIdentity } from "../src/git/processIdentity";

/** 홈 cwd로 분리된 Git 감시자와 OS 경계만 재현하고 제품의 저장소/사용 판정은 그대로 실행한다. */
function fixture(linked = false) {
  const root = "/repos/project", gitDir = linked ? "/repos/main/.git/worktrees/project" : `${root}/.git`;
  const socket = `${gitDir}/fsmonitor--daemon.ipc`;
  const monitor: ProcessIdentity = { pid: 77, ppid: 1, pgid: 77, uid: 501, started: "Sun Oct 4 10:00:00 2026", executable: "/usr/bin/git" };
  let processes = [monitor], latest = processes;
  let cwd = "p77\0\nfcwd\0n/Users/test\0\n", codeFiles = "", socketType = true;
  const text = new Map<string, string>([[`${gitDir}/HEAD`, "ref: refs/heads/main\n"]]);
  if (linked) { text.set(`${gitDir}/gitdir`, `${root}/.git\n`); text.set(`${root}/.git`, `gitdir: ${gitDir}\n`); }
  let reads = 0;
  const deps: GitMonitorInspectionDeps = {
    platform: "darwin", uid: 501, processes: async () => ++reads === 1 ? processes : latest,
    windowCount: async pids => pids.length,
    openPaths: async args => args.includes("-d") ? cwd : args.includes("-U") ? `p77\0\nf18\0n${socket}\0\n` : codeFiles,
    readText: async file => { const value = text.get(file); if (value === undefined) throw new Error("Missing fixture file"); return value; },
    canonical: async file => file, socketIdentity: async () => socketType ? "disk:42" : undefined, owned: () => false,
  };
  return { root, socket, monitor, deps, text, setProcesses: (value: ProcessIdentity[], after = value) => { processes = value; latest = after; reads = 0; },
    setCwd: (value: string) => { cwd = value; }, setCodeFiles: (value: string) => { codeFiles = value; }, setSocketType: (value: boolean) => { socketType = value; } };
}

for (const linked of [false, true]) {
  test(`detached Git monitor with home cwd maps to its ${linked ? "linked" : "normal"} worktree socket`, async () => {
    const f = fixture(linked);
    const result = await inspectGitMonitors([], f.deps);
    assert.equal(result.complete, true);
    assert.equal(result.monitors.length, 1);
    assert.equal(result.monitors[0].repoRoot, f.root);
    assert.equal(result.monitors[0].protectedReason, undefined);
    assert.equal(result.monitors[0].socketIdentity, "disk:42");
  });
}

test("linked worktree backlink must point back to the socket Git directory", async () => {
  const f = fixture(true); f.text.set(`${f.root}/.git`, "gitdir: /other/gitdir\n");
  assert.equal((await inspectGitMonitors([], f.deps)).monitors.length, 0);
});

test("PID replacement and non-socket paths cannot become cleanup candidates", async () => {
  for (const kind of ["pid", "socket"] as const) {
    const f = fixture();
    if (kind === "pid") f.setProcesses([f.monitor], [{ ...f.monitor, started: "reused PID" }]);
    else f.setSocketType(false);
    assert.equal((await inspectGitMonitors([], f.deps)).monitors.length, 0);
  }
});

test("workspace, terminal and other Git use protect a detached monitor", async () => {
  for (const kind of ["workspace", "terminal", "git"] as const) {
    const f = fixture();
    if (kind === "terminal") f.setCwd(`p77\0\nfcwd\0n/Users/test\0\np88\0\nfcwd\0n${f.root}/src\0\n`);
    if (kind === "git") f.setProcesses([f.monitor, { ...f.monitor, pid: 88, ppid: 90, pgid: 90 }]);
    const result = await inspectGitMonitors(kind === "workspace" ? [f.root] : [], f.deps);
    assert.equal(result.monitors.length, 1);
    assert.match(result.monitors[0].protectedReason!, /open-code|active-terminal|other-git/);
  }
});

test("other Code workspaces are mapped and an unmapped renderer fails closed", async () => {
  const f = fixture(), storage = "/code/User/workspaceStorage/abc/state.vscdb";
  const renderer = { ...f.monitor, pid: 88, ppid: 90, pgid: 90, executable: "/Code Helper (Renderer)" };
  f.setProcesses([f.monitor, renderer]);
  f.setCodeFiles(`p88\0\nf6\0n${storage}\0\n`);
  f.text.set("/code/User/workspaceStorage/abc/workspace.json", JSON.stringify({ folder: `file://${f.root}` }));
  assert.equal((await inspectGitMonitors([], f.deps)).monitors[0].protectedReason, "open-code-workspace-or-document");
  f.setProcesses([f.monitor, renderer]); f.setCodeFiles("");
  assert.equal((await inspectGitMonitors([], f.deps)).complete, false);
});

test("webview renderers sharing a workbench window do not block otherwise complete workspace inspection", async () => {
  const f = fixture(), renderer = { ...f.monitor, pid: 88, executable: "/Code Helper (Renderer)" };
  f.setProcesses([f.monitor, renderer, { ...renderer, pid: 89 }]);
  f.deps.windowCount = async () => 1;
  f.setCodeFiles("p88\0\nf6\0n/code/User/workspaceStorage/abc/state.vscdb\0\n");
  f.text.set("/code/User/workspaceStorage/abc/workspace.json", JSON.stringify({ folder: "file:///other/workspace" }));
  const result = await inspectGitMonitors([], f.deps);
  assert.equal(result.complete, true);
  assert.equal(result.monitors.length, 1);
  assert.equal(result.monitors[0].protectedReason, undefined);
});

test("orphaned Code crash reporters do not stand in for an open editor workspace", async () => {
  for (const app of ["Visual Studio Code", "Visual Studio Code - Insiders", "VSCodium"]) {
    const f = fixture(), crashpad = { ...f.monitor, pid: 88,
      executable: `/Applications/${app}.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler` };
    f.setProcesses([f.monitor, crashpad]);
    const snapshot = await inspectGitMonitors([], f.deps);
    assert.equal(snapshot.complete, true, app);
    assert.equal(snapshot.monitors.length, 1);
    assert.equal(snapshot.monitors[0].protectedReason, undefined);
    assert.deepEqual(snapshot.observedCode, []);
  }
});

test("a crash reporter appearing during inspection does not invalidate an otherwise complete snapshot", async () => {
  const f = fixture(), crashpad = { ...f.monitor, pid: 88,
    executable: "/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" };
  f.setProcesses([f.monitor], [f.monitor, crashpad]);
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.monitors.length, 1);
});

test("a real Code process alongside its crash reporter still requires complete workspace mapping", async () => {
  const f = fixture(), code = { ...f.monitor, pid: 88,
    executable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" };
  const crashpad = { ...code, pid: 89,
    executable: "/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" };
  f.setProcesses([f.monitor, code, crashpad]);
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.reason, "code-window-usage-unavailable");
});

test("a mapped real Code renderer stays protected when an orphaned crash reporter is also present", async () => {
  const f = fixture(), renderer = { ...f.monitor, pid: 88, executable: "/Code Helper (Renderer)" };
  const crashpad = { ...f.monitor, pid: 89,
    executable: "/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" };
  f.setProcesses([f.monitor, renderer, crashpad]);
  f.setCodeFiles("p88\0\nf6\0n/code/User/workspaceStorage/abc/state.vscdb\0\n");
  f.text.set("/code/User/workspaceStorage/abc/workspace.json", JSON.stringify({ folder: `file://${f.root}` }));
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.monitors[0].protectedReason, "open-code-workspace-or-document");
  assert.deepEqual(snapshot.observedCode?.map(item => item.pid), [renderer.pid]);
});

test("other Code helper binaries remain subject to workspace-use verification", async () => {
  const f = fixture(), unknownHelper = { ...f.monitor, pid: 88,
    executable: "/Applications/Visual Studio Code.app/Contents/Helpers/chrome_crashpad_handler_other" };
  f.setProcesses([f.monitor, unknownHelper]);
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.reason, "code-window-usage-unavailable");
});

test("window-config counting merges auxiliary renderers and rejects missing PID or configuration", () => {
  const output = " 88 /Code Helper --type=renderer --vscode-window-config=vscode:first\n89 /Code Helper --vscode-window-config=vscode:first\n90 /Code Helper --vscode-window-config=vscode:second\n";
  assert.equal(parseCodeWindowCount(output, [88, 89, 90]), 2);
  assert.equal(parseCodeWindowCount(output, [88, 89, 99]), undefined);
  assert.equal(parseCodeWindowCount("88 /Code Helper --type=renderer", [88]), undefined);
});

test("relative IPC socket names resolve through the daemon's open worktree directory", async () => {
  const f = fixture();
  f.deps.openPaths = async args => args.includes("-d") ? "p77\0\nfcwd\0n/Users/test\0\n"
    : args.includes("-U") ? "p77\0\nf18\0nfsmonitor--daemon.ipc\0\n" : `p77\0\nf4\0n${f.root}\0\n`;
  const result = await inspectGitMonitors([], f.deps);
  assert.equal(result.monitors.length, 1);
  assert.equal(result.monitors[0].socket, f.socket);
  assert.equal(result.monitors[0].protectedReason, undefined);
});

test("official stop is pinned to the selected Git directory and clears opaque inherited Git environment", async t => {
  const f = fixture(), previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/other/protected/.git";
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  let stopped = false;
  f.deps.stop = async (args, root, options) => {
    assert.equal(root, f.root);
    assert.ok(args.includes(`${f.root}/.git`));
    assert.ok(args.includes(f.root));
    assert.ok(options.clearEnv?.includes("GIT_DIR"));
    assert.ok(args.includes(`fsmonitor.socketDir=${f.root}/.git`));
    stopped = true; f.setProcesses([]);
  };
  const candidate = { ...(await inspectGitMonitors([], f.deps)).monitors[0], idleSince: 0 };
  await stopGitMonitor(candidate, () => true, () => [], f.deps);
  assert.equal(stopped, true);
});

test("a Code window or terminal appearing after the first stop inspection prevents official stop", async () => {
  for (const kind of ["code", "terminal"] as const) {
    const f = fixture();
    const candidate = { ...(await inspectGitMonitors([], f.deps)).monitors[0], idleSince: 0 };
    let stopped = false;
    f.deps.stop = async () => { stopped = true; };
    if (kind === "code") {
      let reads = 0;
      f.deps.processes = async () => ++reads < 3 ? [f.monitor] : [f.monitor, { ...f.monitor, pid: 88, executable: "/Code Helper (Renderer)" }];
    } else {
      let reads = 0; const original = f.deps.openPaths;
      f.deps.openPaths = async args => args.includes("-d") && ++reads > 1 ? `p77\0\nfcwd\0n/Users/test\0\np88\0\nfcwd\0n${f.root}\0\n` : original(args);
    }
    await assert.rejects(stopGitMonitor(candidate, () => true, () => [], f.deps), { name: "AbortError" });
    assert.equal(stopped, false);
  }
});

test("a new crash reporter after the stop snapshot does not prevent verified monitor shutdown", async () => {
  const f = fixture(), crashpad = { ...f.monitor, pid: 88,
    executable: "/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" };
  const candidate = { ...(await inspectGitMonitors([], f.deps)).monitors[0], idleSince: 0 };
  let reads = 0, stopped = false;
  f.deps.processes = async () => stopped ? [crashpad] : ++reads < 3 ? [f.monitor] : [f.monitor, crashpad];
  f.deps.stop = async () => { stopped = true; };
  await stopGitMonitor(candidate, () => true, () => [], f.deps);
  assert.equal(stopped, true);
});

test("cwd inspection intersects user and descriptor selections instead of protecting every open file", async () => {
  const f = fixture();
  const original = f.deps.openPaths;
  f.deps.openPaths = async args => args.includes("-d") && !args.includes("-a")
    ? `p77\0\nfcwd\0n/Users/test\0\np88\0\nf9\0n${f.root}/old-file.txt\0\n` : original(args);
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.monitors[0].protectedReason, undefined);
});

test("incomplete inspection retains a safe stage and error code without leaking command output", async () => {
  const f = fixture();
  f.deps.openPaths = async args => {
    if (args.includes("-U")) throw Object.assign(new Error("private argv and repository details"), { code: "ETIMEDOUT", killed: true });
    return "";
  };
  const snapshot = await inspectGitMonitors([], f.deps);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.monitors, []);
  const diagnostic = (snapshot as unknown as { diagnostic: { stage: string; code: string; timedOut: boolean } }).diagnostic;
  assert.equal(diagnostic?.stage, "git-sockets");
  assert.equal(diagnostic?.code, "ETIMEDOUT");
  assert.equal(diagnostic?.timedOut, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /private argv/);
});

test("shared observations apply each window's ownership and protection independently", async () => {
  const f = fixture(), shared = await inspectGitMonitors([], f.deps);
  const first = applyLocalMonitorProtection(shared, [f.root], () => true);
  const second = applyLocalMonitorProtection(shared, [], () => false);
  assert.equal(first.monitors[0].owned, true);
  assert.equal(first.monitors[0].protectedReason, "open-code-workspace-or-document");
  assert.equal(second.monitors[0].owned, false);
  assert.equal(second.monitors[0].protectedReason, undefined);
  assert.equal(shared.monitors[0].owned, false);
  assert.equal(shared.monitors[0].protectedReason, undefined);
});
