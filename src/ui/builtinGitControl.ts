// VS Code의 Git 설정은 읽기만 하고 Git Simple Compare의 상태 조회 엔진 선택만 저장한다.
// - 자체 CLI가 기본이며, 사용자가 명시적으로 선택하면 이미 준비된 기본 Git 상태를 재사용한다.
// - git.enabled·autorefresh·autofetch를 변경하거나 이전 버전의 값을 자동 복구하지 않는다.
import * as vscode from "vscode";
import path from "node:path";
import { logInfo, showErrorWithOutput } from "./outputLog";

/** 자체 설정을 저장할 사용자 기본값 또는 현재 워크스페이스 범위. */
export type BuiltinGitScope = "user" | "workspace";
/** 상태 캐시 재사용 여부를 제어하는 확장 전용 설정 키. */
export const BUILTIN_GIT_STATUS_SETTING = "useBuiltinGitStatus";
let updatePending = false;
export const REPOSITORY_HANDOFF_STATE = "gitSimpleCompare.onboarding.pendingRepositories";

/**
 * 폴더 열기로 extension host가 재시작해도 온보딩 완료 저장소를 다음 창에 이어 준다.
 * @param state 확장 전용 사용자 상태. VS Code Git 설정과 독립된 Memento
 * @param root 새 창에서 Changes로 연결할 실제 저장소 루트
 * @returns token·Git 설정 없이 저장소 경로만 기록하는 Promise
 */
export async function rememberRepositoryHandoff(state: vscode.Memento, root: string): Promise<void> {
  const pending = state.get<string[]>(REPOSITORY_HANDOFF_STATE, []);
  await state.update(REPOSITORY_HANDOFF_STATE, [...new Set([...pending, root])].slice(-8));
}

/**
 * 이미 현재 창에 표시한 저장소의 일회성 handoff를 제거한다.
 * @param state 확장 전용 사용자 상태
 * @param root 이번 온보딩으로 표시한 저장소 루트
 * @returns 해당 경로만 제거하고 다른 창의 예정된 handoff는 보존하는 Promise
 */
export async function finishRepositoryHandoff(state: vscode.Memento, root: string): Promise<void> {
  await state.update(REPOSITORY_HANDOFF_STATE,
    state.get<string[]>(REPOSITORY_HANDOFF_STATE, []).filter(candidate => candidate !== root));
}

/**
 * 사용자가 온보딩에서 연 폴더에만 Changes를 포커스하고 일반 프로젝트 시작은 유지한다.
 * @param context 새 창의 확장 전용 상태
 * @returns 일치하는 handoff가 있으면 소비·포커스·새로고침을 끝내는 Promise
 */
async function resumeRepositoryHandoff(context: Pick<vscode.ExtensionContext, "globalState">): Promise<void> {
  const pending = context.globalState.get<string[]>(REPOSITORY_HANDOFF_STATE, []);
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const root = pending.find(candidate => vscode.workspace.workspaceFolders?.some(folder =>
    normalize(folder.uri.fsPath) === normalize(candidate)));
  if (!root) return;
  // 명령 등록을 기다리는 VS Code activation 경계와 동일한 Open 경로를 통해 새 저장소를 선택한다.
  // 성공한 Open 명령만 handoff를 소비하므로 중간 실패나 host 종료에도 다시 이어갈 수 있다.
  await vscode.commands.executeCommand("gitSimpleCompare.openRepository", { directory: root, open: "current" });
  const pendingAfter = context.globalState.get<string[]>(REPOSITORY_HANDOFF_STATE, []).includes(root);
  logInfo(pendingAfter ? "repository onboarding handoff pending" : "repository onboarding handoff resumed",
    { root, builtinSettingsChanged: false });
}

/**
 * 현재 범위에서 사용자가 선택한 기본 Git 캐시 재사용 여부를 읽는다.
 * @param scope user이면 workspace override를 제외한 사용자 기본값을 읽는다.
 * @returns 기본 Git 캐시를 재사용하도록 명시적으로 선택했으면 true, 자체 CLI를 쓰면 false
 */
function reuseBuiltinStatus(scope: BuiltinGitScope): boolean {
  const config = vscode.workspace.getConfiguration("gitSimpleCompare");
  if (scope === "user") {
    const inspected = config.inspect<boolean>(BUILTIN_GIT_STATUS_SETTING);
    return inspected?.globalValue ?? inspected?.defaultValue ?? false;
  }
  return config.get<boolean>(BUILTIN_GIT_STATUS_SETTING, false);
}

/**
 * 설정을 읽어 두 범위의 메뉴 체크를 동기화한다. 기본 Git 자체의 활성 상태와 구분한다.
 * @returns 반환값 없이 확장 메뉴의 두 context key만 갱신한다.
 */
export function syncBuiltinGitContext(): void {
  void vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.enabled", reuseBuiltinStatus("workspace"));
  void vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.userEnabled", reuseBuiltinStatus("user"));
}

/**
 * 상태 조회 엔진을 선택하는 설정 구독을 등록한다. 활성화 시에는 설정을 저장하지 않는다.
 * @param context 다음 창으로 넘긴 저장소를 읽을 확장 전용 상태
 * @returns 설정 구독과 저장소 handoff를 기다리는 ready Promise. 기본 Git 활성화·reload는 요청하지 않는다.
 */
export function registerBuiltinGitControl(
  context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState">
): vscode.Disposable & { ready: Promise<void> } {
  syncBuiltinGitContext();
  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("gitSimpleCompare." + BUILTIN_GIT_STATUS_SETTING)) syncBuiltinGitContext();
  });
  const ready = Promise.resolve().then(() => resumeRepositoryHandoff(context)).catch(error => {
    showErrorWithOutput("repository onboarding handoff failed", error,
      vscode.l10n.t("Could not open Git Simple Compare. Open its Changes view to continue."));
  });
  return Object.assign(listener, { ready });
}

/**
 * 확장 전용 설정에 조회 엔진 선택을 저장하고 기본 Git 설정은 그대로 유지한다.
 * @param reuse true이면 준비된 VS Code Git 캐시 재사용, false이면 자체 Git CLI 사용
 * @param scope 설정 저장 범위. 생략하면 현재 workspace가 있을 때 workspace, 없으면 user
 * @returns 설정 저장과 메뉴 상태 동기화가 끝나는 Promise
 */
export async function setBuiltinGitStatusReuse(
  reuse: boolean,
  scope: BuiltinGitScope = vscode.workspace.workspaceFolders?.length ? "workspace" : "user"
): Promise<void> {
  if (scope === "workspace" && !vscode.workspace.workspaceFolders?.length) throw new Error("No workspace is open.");
  await vscode.workspace.getConfiguration("gitSimpleCompare").update(
    BUILTIN_GIT_STATUS_SETTING,
    reuse,
    scope === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
  );
  syncBuiltinGitContext();
  logInfo("git status backend selected", { scope, backend: reuse ? "vscodeGitStatus" : "gitSimpleCompare", builtinSettingsChanged: false });
}

/**
 * 메뉴의 상태 조회 엔진 선택을 반전한다. 기본 Git 확장의 실행·감시 설정은 변경하지 않는다.
 * @param scope 사용자 기본값 또는 현재 workspace 범위
 * @returns 저장 또는 오류 알림과 busy 해제가 끝나는 Promise
 */
export async function toggleBuiltinGit(scope: BuiltinGitScope = "workspace"): Promise<void> {
  if (updatePending) {
    logInfo("git status backend selection skipped", { reason: "update-pending", scope });
    return;
  }
  if (scope === "workspace" && !vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder or workspace to choose the Git status backend."));
    return;
  }
  updatePending = true;
  try {
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.busy", true);
    const reuse = !reuseBuiltinStatus(scope);
    await setBuiltinGitStatusReuse(reuse, scope);
    void vscode.window.showInformationMessage(reuse
      ? vscode.l10n.t("Git Simple Compare will reuse available VS Code Git status. VS Code Git settings are unchanged.")
      : vscode.l10n.t("Git Simple Compare will use its own Git CLI. VS Code Git settings are unchanged."));
  } catch (error) {
    showErrorWithOutput("git status backend selection failed", error,
      vscode.l10n.t("Could not choose the Git status backend. See Git Simple Compare Output for details."), { scope });
  } finally {
    updatePending = false;
    syncBuiltinGitContext();
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.busy", false);
  }
}
