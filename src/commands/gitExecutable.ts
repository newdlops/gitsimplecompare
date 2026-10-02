// Git 시작 지연 진단과 실행 파일 선택 명령.
// - 진단 서비스의 실제 측정치를 네이티브 Quick Pick에 표시하고 설정 범위만 조립한다.
import * as vscode from "vscode";
import { resolveGitExecutable } from "../git/gitExec";
import { findGitExecutables, probeGitExecutable, type GitExecutableProbe } from "../git/gitExecutableService";
import { logError, logInfo } from "../ui/outputLog";
import type { CommandDeps } from "./shared";

type ExecutableChoice = vscode.QuickPickItem & { action: "select" | "manual" | "reset"; executable?: string };
type SettingScope = vscode.QuickPickItem & { target: vscode.ConfigurationTarget; scope: "user" | "workspace" };
let configuring = false;

/**
 * 시작 시간을 비교한 뒤 검증된 실행 파일을 사용자 또는 워크스페이스 설정에 저장한다.
 * - 취소·실행 실패 때 설정을 저장하지 않으며 중복 호출은 진단 프로세스를 추가하지 않는다.
 * @param deps 활성 저장소와 워크스페이스의 실행 디렉터리를 제공하는 의존성
 * @returns 진단과 선택이 끝나거나 취소되면 완료하는 Promise
 */
export async function configureGitExecutable(deps: CommandDeps): Promise<void> {
  if (configuring) { logInfo("git executable configuration skipped", { reason: "busy" }); return; }
  configuring = true;
  await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitExecutable.busy", true);
  const cwd = deps.changesView.getActiveRepo() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try {
    const current = resolveGitExecutable(cwd);
    const builtinPath = vscode.workspace.getConfiguration("git", vscode.Uri.file(cwd)).get<string | string[] | null>("path");
    const additional = (Array.isArray(builtinPath) ? builtinPath : [builtinPath])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const candidates = await findGitExecutables(current, additional);
    const results = await measureExecutables(candidates, cwd);
    const choices = executableChoices(results, current);
    const picked = await vscode.window.showQuickPick(choices, {
      title: vscode.l10n.t("Git Startup / Executable"),
      placeHolder: vscode.l10n.t("Compare startup times and select Git. Repository, network and OS delays need separate diagnosis."),
      matchOnDescription: true, matchOnDetail: true,
    });
    if (!picked) { logInfo("git executable configuration cancelled", { step: "executable" }); return; }
    let executable = picked.executable;
    if (picked.action === "manual") {
      executable = await inputExecutable(current, cwd);
      if (executable === undefined) return;
    }
    const scope = await pickSettingScope();
    if (!scope) { logInfo("git executable configuration cancelled", { step: "scope" }); return; }
    const config = vscode.workspace.getConfiguration("gitSimpleCompare", vscode.Uri.file(cwd));
    await config.update("gitPath", executable, scope.target);
    const effective = resolveGitExecutable(cwd);
    logInfo("git executable configuration saved", { scope: scope.scope, executable, effective, cwd });
    const scopeLabel = scope.scope === "user" ? vscode.l10n.t("user settings") : vscode.l10n.t("this workspace");
    const message = picked.action === "reset"
      ? vscode.l10n.t("Git executable setting reset for {0}. Effective executable: {1}.", scopeLabel, effective)
      : effective !== executable
        ? vscode.l10n.t("Git executable saved for {0}. A workspace or folder setting currently selects {1}.", scopeLabel, effective)
        : vscode.l10n.t("Git executable saved for {0}: {1}. The next Git command uses this path.", scopeLabel, effective);
    void vscode.window.showInformationMessage(message);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logInfo("git executable configuration cancelled", { step: "diagnosis" });
    } else {
      logError("git executable configuration failed", error, { cwd });
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not configure the Git executable. See Git Simple Compare Output for details."));
    }
  } finally {
    configuring = false;
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.gitExecutable.busy", false);
  }
}

/**
 * 취소 가능한 네이티브 진행 알림 아래에서 후보를 차례로 측정하고 OUTPUT에 결과를 기록한다.
 * @param executables 비교할 실행 파일 후보 목록
 * @param cwd --version을 실행할 디렉터리
 * @returns 성공·실패 후보를 모두 담은 측정 결과
 */
async function measureExecutables(executables: string[], cwd: string): Promise<GitExecutableProbe[]> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t("Measuring Git startup time…"), cancellable: true,
  }, async (progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const results: GitExecutableProbe[] = [];
    try {
      for (const executable of executables) {
        progress.report({ message: executable });
        const result = await probeGitExecutable(executable, cwd, controller.signal);
        results.push(result);
        logInfo("git startup measured", { ...result });
        progress.report({ increment: 100 / executables.length });
      }
      return results;
    } finally { subscription.dispose(); }
  });
}

/**
 * 검증에 성공한 후보만 선택에 제공하고 현재 경로·측정상 최저 지연을 표시한다.
 * @param results 실행 파일별 실제 시작 시간 측정 결과
 * @param current 현재 저장소에 적용되는 실행 경로
 * @returns 시간순 후보와 직접 입력·설정 초기화 액션
 */
function executableChoices(results: GitExecutableProbe[], current: string): ExecutableChoice[] {
  const valid = results.filter(result => result.medianMs !== undefined && !result.error)
    .sort((left, right) => left.medianMs! - right.medianMs!);
  const choices: ExecutableChoice[] = valid.map((result, index) => ({
    action: "select", executable: result.executable,
    label: result.executable,
    description: [vscode.l10n.t("{0} ms", Math.round(result.medianMs!)),
      result.executable === current ? vscode.l10n.t("Current") : "",
      index === 0 ? vscode.l10n.t("Fastest in this run") : ""].filter(Boolean).join(" · "),
    detail: vscode.l10n.t("{0} · Median of {1} startup samples", result.version!, result.samplesMs.length),
  }));
  if (valid.length === 0) {
    void vscode.window.showWarningMessage(vscode.l10n.t("No working Git executable was found. Enter a path or reset the setting; see Output for diagnostic details."));
  }
  choices.push({ action: "manual", label: "$(edit) " + vscode.l10n.t("Enter Git executable…"),
    detail: vscode.l10n.t("Validate an executable name or absolute path before saving.") });
  choices.push({ action: "reset", label: "$(discard) " + vscode.l10n.t("Reset Git executable setting…"),
    detail: vscode.l10n.t("Remove this scope's override and inherit the default. Empty defaults use Git from PATH.") });
  return choices;
}

/**
 * 직접 입력한 실행 파일도 동일한 버전·시간 진단을 통과한 경우에만 저장 단계로 전달한다.
 * @param current 입력 상자에 보여줄 현재 실행 파일
 * @param cwd 검증용 작업 디렉터리
 * @returns 검증된 실행 파일. 취소 또는 실패하면 undefined
 */
async function inputExecutable(current: string, cwd: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t("Git executable"), value: current,
    prompt: vscode.l10n.t("Enter an executable name or absolute path without arguments or quotes."),
    validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a Git executable."),
  });
  if (input === undefined) return undefined;
  const executable = input.trim();
  if (!executable) return undefined;
  const [result] = await measureExecutables([executable], cwd);
  if (result.error) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not run Git at {0}. See Git Simple Compare Output for details.", executable));
    return undefined;
  }
  return executable;
}

/**
 * 실행 파일 설정의 저장 범위를 고르며 워크스페이스가 없는 창에는 사용자 범위만 표시한다.
 * @returns 선택한 VS Code 설정 대상. 취소하면 undefined
 */
async function pickSettingScope(): Promise<SettingScope | undefined> {
  const items: SettingScope[] = [{
    label: "$(globe) " + vscode.l10n.t("User (all workspaces)"),
    detail: vscode.l10n.t("Set the user default. Workspace and folder settings take precedence."),
    target: vscode.ConfigurationTarget.Global, scope: "user",
  }];
  if (vscode.workspace.workspaceFolders?.length) items.push({
    label: "$(folder) " + vscode.l10n.t("This workspace"),
    detail: vscode.l10n.t("Set Git for this workspace. Explicit folder settings take precedence."),
    target: vscode.ConfigurationTarget.Workspace, scope: "workspace",
  });
  return vscode.window.showQuickPick(items, { title: vscode.l10n.t("Save Git executable setting") });
}
