// 사용자 설정·native 메뉴를 git 계층의 소유권/유휴 판정 서비스에 연결한다.
import * as vscode from "vscode";
import path from "node:path";
import { IdleGitCleanup, type IdleGitCandidate, type GitCleanupResult } from "../git/idleGitCleanup";
import { readSharedGitMonitorInspection, stopGitMonitor } from "../git/gitMonitorInspection";
import { gitProcesses, type OwnedGitProcess } from "../git/gitProcessRegistry";
import { GitCleanupScheduler } from "../git/gitCleanupScheduler";
import { setGitReadTimeoutResolver } from "../git/gitProcessRunner";
import { setOwnedFsmonitorPolicy } from "../git/ownedFsmonitor";
import { setWorkingTreeSnapshotPolicy, invalidateWorkingTreeSnapshots, disposeWorkingTreeSnapshots } from "../git/workingTreeSnapshot";
import { setBlameReadCancellationPolicy, disposeSharedBlameReads } from "../git/sharedBlameReads";
import { beginGitHubReadLifetime } from "../git/githubReadCache";
import { beginFileHistoryReadLifetime } from "../git/fileHistoryReadCache";
import { clearGitHubRepositoryNameCache } from "../git/githubRepositoryName";
import { logError, logInfo } from "./outputLog";

type Scope = "user" | "workspace";
type CandidateItem = vscode.QuickPickItem & ({ processKind: "monitor"; candidate: IdleGitCandidate } | { processKind: "read"; candidate: OwnedGitProcess });
const ENABLED = "gitProcessCleanup.enabled", MINUTES = "gitProcessCleanup.idleMinutes";
let activeShutdown: (() => Promise<void>) | undefined;

/** Extension Host 종료 전에 소유 조회의 close와 private cache 삭제를 끝까지 기다린다. */
export async function shutdownGitProcessManagement(): Promise<void> { await activeShutdown?.(); }

/** 저장소별 리소스 설정으로 사용자 기본값과 workspace/folder 우선순위를 유지한다. */
function configuration(root?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("gitSimpleCompare", root ? vscode.Uri.file(root) : undefined);
}

/** 비정상 수동 JSON 값도 안전한 유휴 범위로 보정한다. */
function idleMinutes(root?: string): number {
  const value = configuration(root).get<number>(MINUTES, 5);
  return Number.isFinite(value) ? Math.max(1, Math.min(1440, value)) : 5;
}

/** 활성 workspace·열린 파일은 감시자 정리에서 항상 보호한다. */
function protectedPaths(): string[] {
  return [...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
    ...vscode.workspace.textDocuments.filter(document => document.uri.scheme === "file").map(document => document.uri.fsPath)];
}

/**
 * 조회 제한·자동 정리·사용자/워크스페이스 UI를 등록하며 모든 timer와 구독을 소유한다.
 * @param activeRoot Changes에서 선택한 저장소. 전역 설정의 우선순위를 결정할 때만 사용한다.
 * @param storageDirectory 사용자별 확장 저장 공간. 있으면 세션 간 전용 index 캐시를 보존한다.
 * @returns extension dispose 때 해제할 전체 기능 구독
 */
export function registerGitProcessManagement(activeRoot: () => string | undefined, storageDirectory?: string): vscode.Disposable {
  const stopGitHubReads = beginGitHubReadLifetime();
  const stopHistoryReads = beginFileHistoryReadLifetime(repo => configuration(repo).get<boolean>("cancelUnusedGitReads", true), logInfo,
    storageDirectory ? path.join(storageDirectory, "git-file-history-v1") : undefined);
  const subscriptions: vscode.Disposable[] = [];
  const root = () => activeRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const enabled = (repoRoot: string) => configuration(repoRoot).get<boolean>(ENABLED, false);
  const resetLogger = gitProcesses.setLogger(logInfo);
  const resetTimeout = setGitReadTimeoutResolver(cwd => {
    const seconds = configuration(cwd).get<number>("gitReadTimeoutSeconds", 30);
    return Number.isFinite(seconds) ? Math.max(0, Math.min(3600, seconds)) * 1000 : 30_000;
  });
  const resetMonitor = setOwnedFsmonitorPolicy(logInfo);
  const hostExit = () => gitProcesses.stopOnHostExit();
  process.once("exit", hostExit);
  const resetBlame = setBlameReadCancellationPolicy(repo => configuration(repo).get<boolean>("cancelUnusedGitReads", true));
  const resetStatusPolicy = setWorkingTreeSnapshotPolicy(repo => ({ useCache: configuration(repo).get<boolean>("workingTreeStatusCache", true),
    cancelUnused: configuration(repo).get<boolean>("cancelUnusedGitReads", true) }), logInfo,
    storageDirectory ? path.join(storageDirectory, "git-status-index-v1") : undefined);
  const service = new IdleGitCleanup({ inspect: async () => {
    const snapshot = await readSharedGitMonitorInspection(protectedPaths());
    if (snapshot.complete) logInfo("git monitor inspection completed", { ...snapshot.diagnostic, monitors: snapshot.monitors.length });
    return snapshot;
  }, stop: (candidate, canStop) => stopGitMonitor(candidate,
    () => canStop() && Date.now() - Math.max(candidate.idleSince, gitProcesses.lastUsed(candidate.repoRoot) ?? 0) >= idleMinutes(candidate.repoRoot) * 60_000, protectedPaths),
    busy: repo => gitProcesses.isBusy(repo), lastUsed: repo => gitProcesses.lastUsed(repo), enabled, log: logInfo });
  let manualBusy = false, settingsBusy = false, disposed = false;
  const scheduler = new GitCleanupScheduler(async signal => {
    if (manualBusy || disposed || signal.aborted) return;
    const candidates = await service.candidates(1, true);
    for (const candidate of candidates) {
      if (signal.aborted || manualBusy || disposed) break;
      await service.cleanup([candidate], idleMinutes(candidate.repoRoot), true, signal);
    }
    for (const read of gitProcesses.idleReads()) {
      if (signal.aborted || disposed) break;
      if (enabled(read.repoRoot)) await gitProcesses.cleanupRead(read.id);
    }
  });

  /** 메뉴의 체크와 workspace 상속 표시를 선택 저장소의 실제 설정에 맞춘다. */
  const sync = () => {
    const config = configuration(root()), inspected = config.inspect<boolean>(ENABLED);
    void vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.userEnabled", inspected?.globalValue ?? inspected?.defaultValue ?? false);
    void vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.workspaceEnabled", config.get<boolean>(ENABLED, false));
    void vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.inherited", inspected?.workspaceValue === undefined && inspected?.workspaceFolderValue === undefined);
    const roots = [...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath), ...gitProcesses.roots()];
    scheduler.configure(configuration().get<boolean>(ENABLED, false) || roots.some(enabled));
  };

  /** 중복 설정 쓰기를 막고 전역 기본값과 workspace의 유효 값을 각각 반전한다. */
  const toggle = async (scope: Scope) => {
    if (settingsBusy || disposed || (scope === "workspace" && !vscode.workspace.workspaceFolders?.length)) return;
    settingsBusy = true;
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.settingsBusy", true);
    try {
      const config = configuration(root()), inspected = config.inspect<boolean>(ENABLED);
      const current = scope === "user" ? inspected?.globalValue ?? inspected?.defaultValue ?? false : config.get<boolean>(ENABLED, false);
      await config.update(ENABLED, !current, scope === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
      if (scope === "workspace") for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const scoped = configuration(folder.uri.fsPath);
        if (scoped.inspect<boolean>(ENABLED)?.workspaceFolderValue !== undefined) await scoped.update(ENABLED, !current, vscode.ConfigurationTarget.WorkspaceFolder);
      }
      logInfo("git process cleanup setting changed", { scope, enabled: !current, effective: configuration(root()).get<boolean>(ENABLED, false) });
      void vscode.window.showInformationMessage(vscode.l10n.t("Automatic Git cleanup: {0}. User settings are inherited unless the workspace or folder overrides them.",
        configuration(root()).get<boolean>(ENABLED, false) ? vscode.l10n.t("On") : vscode.l10n.t("Off")));
    } catch (error) { logError("git cleanup setting failed", error); }
    finally { settingsBusy = false; sync(); await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.settingsBusy", false); }
  };

  /** 현재 상속/유휴 시간을 표시하고 숫자 입력 전 저장할 범위를 선택한다. */
  const configure = async () => {
    if (settingsBusy || disposed) return;
    settingsBusy = true;
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.settingsBusy", true);
    try {
    const inspected = configuration(root()).inspect<boolean>(ENABLED);
    const inherited = inspected?.workspaceValue === undefined && inspected?.workspaceFolderValue === undefined;
    const choices = [
      { label: vscode.l10n.t("User settings"), target: vscode.ConfigurationTarget.Global },
      ...(vscode.workspace.workspaceFolders?.length ? [{ label: vscode.l10n.t("Workspace settings"), target: vscode.ConfigurationTarget.Workspace }] : []),
    ];
    const scope = await vscode.window.showQuickPick(choices, { title: vscode.l10n.t("Idle Git Cleanup"),
      placeHolder: vscode.l10n.t("Current: {0} · Idle after {1} min · {2}. Choose where to save the idle time.", configuration(root()).get<boolean>(ENABLED, false) ? vscode.l10n.t("On") : vscode.l10n.t("Off"), idleMinutes(root()), inherited ? vscode.l10n.t("Inherited") : vscode.l10n.t("Workspace override")) });
    if (!scope || disposed) return;
    const minutes = await vscode.window.showInputBox({ title: vscode.l10n.t("Idle Git Cleanup"), value: String(idleMinutes(root())),
      prompt: vscode.l10n.t("Idle minutes before cleanup (1–1440). Active work and unverified processes are preserved."),
      validateInput: value => /^\d+$/.test(value) && +value >= 1 && +value <= 1440 ? undefined : vscode.l10n.t("Enter a whole number from 1 to 1440.") });
    if (minutes === undefined || disposed) return;
    try { await configuration(root()).update(MINUTES, Number(minutes), scope.target); logInfo("git cleanup idle interval changed", { minutes: Number(minutes), scope: scope.target }); }
    catch (error) { logError("git cleanup interval setting failed", error); }
    } finally { settingsBusy = false; sync(); await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.settingsBusy", false); }
  };

  /** 자동 설정에 관계없이 후보를 다중 선택하게 하고 취소 때는 종료 명령을 실행하지 않는다. */
  const cleanup = async () => {
    if (manualBusy || disposed) return;
    manualBusy = true;
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.busy", true);
    try {
      const monitors = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Checking idle Git processes…") }, () => service.candidates(1));
      if (disposed) return;
      const now = Date.now();
      const items: CandidateItem[] = monitors.filter(candidate => now - candidate.idleSince >= idleMinutes(candidate.repoRoot) * 60_000).map(candidate => ({
        processKind: "monitor" as const, candidate, label: `$(eye) ${path.basename(candidate.repoRoot)}`,
        description: vscode.l10n.t("PID {0} · fsmonitor · Idle {1} min", candidate.identity.pid, Math.floor((now - candidate.idleSince) / 60_000)),
        detail: candidate.repoRoot, tooltip: new vscode.MarkdownString(candidate.repoRoot),
      }));
      items.push(...gitProcesses.idleReads().map(candidate => ({ processKind: "read" as const, candidate,
        label: `$(terminal) ${path.basename(candidate.repoRoot)}`, description: vscode.l10n.t("PID {0} · {1} · Cancelled read", candidate.pid ?? "?", candidate.command), detail: candidate.repoRoot, tooltip: new vscode.MarkdownString(candidate.repoRoot) })));
      if (!items.length) { void vscode.window.showInformationMessage(vscode.l10n.t("No idle Git processes to clean.")); return; }
      const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Clean Idle Git Processes"), canPickMany: true,
        placeHolder: vscode.l10n.t("Select idle processes to stop. Active repositories and Git writes are protected."), matchOnDescription: true, matchOnDetail: true });
      if (!selected?.length || disposed) { logInfo("manual git cleanup cancelled"); return; }
      const result: GitCleanupResult = { stopped: 0, kept: 0, failed: 0 };
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Cleaning idle Git processes…"), cancellable: true }, async (progress, token) => {
        const controller = new AbortController(), subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { for (const item of selected) {
          if (disposed || controller.signal.aborted) { result.kept++; continue; }
          progress.report({ message: item.label });
          if (item.processKind === "read") { if (await gitProcesses.cleanupRead(item.candidate.id)) result.stopped++; else result.kept++; }
          else { const part = await service.cleanup([item.candidate], idleMinutes(item.candidate.repoRoot), false, controller.signal); result.stopped += part.stopped; result.kept += part.kept; result.failed += part.failed; }
        } } finally { subscription.dispose(); }
      });
      logInfo("manual git cleanup finished", { ...result });
      void vscode.window.showInformationMessage(vscode.l10n.t("Git cleanup: {0} stopped, {1} kept, {2} failed. Details are in Git Simple Compare Output.", result.stopped, result.kept, result.failed));
    } catch (error) { logError("manual git cleanup failed", error); void vscode.window.showErrorMessage(vscode.l10n.t("Could not inspect or clean Git processes. See Git Simple Compare Output.")); }
    finally { manualBusy = false; await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitProcessCleanup.busy", false); }
  };

  for (const [name, scope] of [["toggleGitProcessCleanupUser", "user"], ["toggleGitProcessCleanupWorkspace", "workspace"]] as const) {
    for (const suffix of ["", ".checked", ".unchecked"]) subscriptions.push(vscode.commands.registerCommand(`gitSimpleCompare.${name}${suffix}`, () => toggle(scope)));
  }
  subscriptions.push(vscode.commands.registerCommand("gitSimpleCompare.configureGitProcessCleanup", configure),
    vscode.commands.registerCommand("gitSimpleCompare.cleanupIdleGitProcesses", cleanup),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("gitSimpleCompare.gitProcessCleanup")) { logInfo("git cleanup configuration changed"); sync(); }
      if (event.affectsConfiguration("gitSimpleCompare.workingTreeStatusCache") || event.affectsConfiguration("gitSimpleCompare.gitPath")) invalidateWorkingTreeSnapshots();
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => sync()), vscode.window.onDidChangeActiveTextEditor(() => sync()));
  sync();
  // 자동 정리가 꺼져 있어도 최초 한 번은 관찰해 수동 명령의 유휴 시간을 프로세스 나이로 추측하지 않는다.
  const observation = setTimeout(() => { if (!disposed && !manualBusy) void service.candidates(1).catch(() => undefined); }, 10_000);
  observation.unref();
  let shutdown: Promise<void> | undefined;
  /** timer·구독을 먼저 멈춘 뒤 소유 조회 종료와 캐시 삭제를 같은 완료 Promise로 묶는다. */
  const dispose = () => {
    if (disposed) return; disposed = true;
    clearTimeout(observation); scheduler.dispose(); service.reset(); resetMonitor();
    clearGitHubRepositoryNameCache();
    shutdown = Promise.all([gitProcesses.dispose(), disposeWorkingTreeSnapshots(), disposeSharedBlameReads(), stopGitHubReads(), stopHistoryReads()])
      .then(() => undefined).finally(() => process.removeListener("exit", hostExit));
    void shutdown.catch(() => undefined);
    for (const subscription of subscriptions) subscription.dispose();
    resetTimeout(); resetLogger(); resetStatusPolicy(); resetBlame();
  };
  activeShutdown = async () => { dispose(); await shutdown; };
  return { dispose };
}
