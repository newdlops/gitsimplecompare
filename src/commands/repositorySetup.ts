// Clone/GitHub/Open/Init의 온보딩 입력과 화면 연결을 조립한다.
// - Git 작업은 RepositorySetupService에, GitHub 목록은 read-only catalog에 위임한다.
// - 기본 Git 설정이나 vscode.git의 명령·API를 사용하지 않는다.
import path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
  RepositorySetupError, RepositorySetupService, normalizeCloneSource,
  suggestedRepositoryFolderName, validateRepositoryFolderName,
  type RepositorySetupResult,
} from "../git/repositorySetupService";
import { GitHubRepositoryCatalog, RepositoryCatalogError, type GitHubCloneRepository } from "../git/githubRepositoryCatalog";
import { logInfo, showErrorWithOutput } from "../ui/outputLog";
import { finishRepositoryHandoff, rememberRepositoryHandoff, setBuiltinGitStatusReuse } from "../ui/builtinGitControl";
import { REPOSITORY_SETUP_COMMANDS, type RepositorySetupAction } from "../webview/changesOnboardingProtocol";
import type { CommandDeps } from "./shared";

/** 자동화에서도 같은 검증 경계를 사용하는 선택적 명령 인자. 웹뷰에서는 action만 전달한다. */
export interface RepositorySetupArgs {
  source?: string;
  parentDirectory?: string;
  folderName?: string;
  directory?: string;
  open?: "current" | "new" | "add" | "none";
}
/** 실제 Git와 GitHub 조회를 실패·취소 fixture로 대체할 수 있는 좁은 경계. */
export interface RepositorySetupDependencies {
  service?: RepositorySetupService;
  catalog?: GitHubRepositoryCatalog;
}
type SetupDeps = Pick<CommandDeps, "registry" | "changesView" | "globalState">;
type RepositoryPick = vscode.QuickPickItem & { repository?: GitHubCloneRepository; action?: "more" | "url" };
let activeSetup = false;

/**
 * 허용된 온보딩 네 명령과 Get Started를 등록한다.
 * @param deps 공유 저장소 레지스트리·Changes 뷰·확장 전용 Memento
 * @param dependencies 실제 실행을 대체할 선택적 테스트 경계
 * @returns 확장 종료 때 해제할 명령 구독
 */
export function registerRepositorySetupCommands(deps: SetupDeps, dependencies: RepositorySetupDependencies = {}): vscode.Disposable[] {
  const service = dependencies.service ?? new RepositorySetupService();
  const catalog = dependencies.catalog ?? new GitHubRepositoryCatalog();
  return [
    vscode.commands.registerCommand("gitSimpleCompare.getStarted", async () => {
      await chooseOwnGit();
      await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason: "workspaceFolders" });
      logInfo("repository onboarding opened", { builtinSettingsChanged: false });
    }),
    ...Object.entries(REPOSITORY_SETUP_COMMANDS).map(([action, command]) =>
      vscode.commands.registerCommand(command, (args?: RepositorySetupArgs) =>
        runRepositorySetup(deps, service, catalog, action as RepositorySetupAction, args ?? {}))),
  ];
}

/**
 * 온보딩의 명시적인 자체 Git 선택만 확장 설정에 적용한다.
 * @returns 이미 자체 CLI를 사용 중이면 저장하지 않으며, 선택이 필요하면 확장 전용 값만 바꾼다.
 */
async function chooseOwnGit(): Promise<void> {
  if (vscode.workspace.getConfiguration("gitSimpleCompare").get<boolean>("useBuiltinGitStatus", false)) {
    await setBuiltinGitStatusReuse(false);
  }
}

/**
 * 다이얼로그·작업 실행·실패·취소·완료를 하나의 busy 생명주기로 조립한다.
 * @param deps 온보딩 결과를 표시할 공유 객체
 * @param service 실제 Git 작업 서비스
 * @param catalog GitHub 저장소 read-only 조회 서비스
 * @param action 허용된 온보딩 동작
 * @param args 명시적인 자동화 인자. 생략한 값은 사용자 입력으로 받는다.
 * @returns 작업 또는 취소와 UI busy 해제를 마치면 완료되는 Promise
 */
async function runRepositorySetup(deps: SetupDeps, service: RepositorySetupService, catalog: GitHubRepositoryCatalog,
  action: RepositorySetupAction, args: RepositorySetupArgs): Promise<void> {
  if (activeSetup) {
    logInfo("repository onboarding skipped", { action, reason: "operation-pending" });
    return;
  }
  activeSetup = true;
  let completed = false;
  try {
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.onboarding.busy", true);
    deps.changesView.setRepositorySetupState({ phase: "running", action });
    await chooseOwnGit();
    const result = action === "clone" || action === "github"
      ? await cloneRepository(service, catalog, action, args)
      : await openOrInitializeRepository(service, action, args);
    if (!result) {
      logInfo("repository onboarding cancelled", { action, reason: "input-dismissed" });
      return;
    }
    logInfo("repository setup Git completed", { action, root: result.root, created: result.created, builtinSettingsChanged: false });
    await connectRepository(deps, result, args.open);
    deps.changesView.setRepositorySetupState({ phase: "complete", action, repositoryRoot: result.root,
      message: vscode.l10n.t("Repository ready. Continue in Git Simple Compare.") });
    completed = true;
    logInfo("repository onboarding completed", { action, root: result.root, builtinSettingsChanged: false });
  } catch (error) {
    if ((error instanceof RepositorySetupError && error.code === "cancelled") ||
        (error instanceof RepositoryCatalogError && error.kind === "cancelled") ||
        (error instanceof Error && error.name === "CancellationError")) {
      logInfo("repository onboarding cancelled", { action, reason: "user-cancelled" });
      return;
    }
    const message = error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t("Repository setup failed. Try again.");
    deps.changesView.setRepositorySetupState({ phase: "error", action, message });
    completed = true;
    showErrorWithOutput("repository onboarding failed", error, vscode.l10n.t("Repository setup failed: {0}", message), { action });
  } finally {
    if (!completed) deps.changesView.setRepositorySetupState({ phase: "idle" });
    activeSetup = false;
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.onboarding.busy", false);
  }
}

/**
 * 실제 Git 작업만 취소 가능한 알림에 연결한다. 입력창은 clone 시작 전에 모두 끝낸다.
 * @param title 진행 알림의 지역화된 제목
 * @param operation AbortSignal을 받는 Git 또는 GitHub 작업
 * @returns 사용자의 명시적 취소가 실제 프로세스/요청에 연결된 작업 결과
 */
async function cancellableOperation<T>(title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try { return await operation(controller.signal); }
    finally { subscription.dispose(); }
  });
}

/**
 * URL 또는 GitHub 목록 선택에서 복제 입력을 얻고 공유 Git 서비스로 복제한다.
 * @param service 실제 clone 실행 서비스
 * @param catalog 기본 Git과 독립된 GitHub 저장소 목록 서비스
 * @param action URL 또는 GitHub clone
 * @param args 명시적인 원본·대상. UI 입력과 동일한 service 검증을 받는다.
 * @returns 복제 결과. 입력이나 인증 선택을 취소하면 undefined
 */
async function cloneRepository(service: RepositorySetupService, catalog: GitHubRepositoryCatalog,
  action: "clone" | "github", args: RepositorySetupArgs): Promise<RepositorySetupResult | undefined> {
  let source = args.source;
  let githubToken: string | undefined;
  if (action === "github") {
    const session = await Promise.resolve(vscode.authentication.getSession("github", ["repo"], { createIfNone: true })).catch(error => {
      if (error instanceof Error && (error.name === "CancellationError" || error.message === "User did not consent to login.")) return undefined;
      throw error;
    });
    if (!session) return undefined;
    githubToken = session.accessToken;
    const selected = await pickGitHubRepository(catalog, session.accessToken);
    if (selected === undefined) return undefined;
    source = selected;
  }
  if (!source) {
    source = await vscode.window.showInputBox({
      title: vscode.l10n.t("Clone Repository"),
      prompt: vscode.l10n.t("Enter a repository URL, SSH address, or GitHub owner/name."),
      placeHolder: "https://github.com/owner/repository.git",
      ignoreFocusOut: true,
      validateInput: value => inputError(() => normalizeCloneSource(value)),
    });
  }
  if (source === undefined) return undefined;
  source = normalizeCloneSource(source);
  if (!githubToken && source.startsWith("https://") && new URL(source).hostname === "github.com") {
    const existing = await vscode.authentication.getSession("github", ["repo"], { silent: true });
    githubToken = existing?.accessToken;
  }
  const parent = args.parentDirectory ?? await pickFolder(vscode.l10n.t("Select a destination folder"));
  if (!parent) return undefined;
  const folderName = args.folderName ?? await vscode.window.showInputBox({
    title: vscode.l10n.t("Repository Folder"),
    prompt: vscode.l10n.t("Create the cloned repository in a new folder inside the selected destination."),
    value: suggestedRepositoryFolderName(source), ignoreFocusOut: true,
    validateInput: value => inputError(() => validateRepositoryFolderName(value)),
  });
  if (folderName === undefined) return undefined;
  return cancellableOperation(vscode.l10n.t("Cloning repository with Git Simple Compare..."),
    signal => service.clone(source!, parent, folderName, { signal, githubToken }));
}

/**
 * 모든 접근 가능한 페이지를 사용자 선택에 따라 읽고 목록 또는 URL 입력으로 이어 준다.
 * @param catalog read-only API 서비스
 * @param token 현재 OAuth session의 일시적 인증 정보
 * @returns 선택된 HTTPS 복제 주소. URL 입력을 선택하면 빈 문자열, 취소하면 undefined
 */
async function pickGitHubRepository(catalog: GitHubRepositoryCatalog, token: string): Promise<string | undefined> {
  const repositories = new Map<string, GitHubCloneRepository>();
  let page = 1;
  for (;;) {
    const result = await cancellableOperation(vscode.l10n.t("Loading GitHub repositories..."),
      signal => catalog.listPage(token, page, signal));
    for (const repository of result.repositories) repositories.set(repository.nameWithOwner, repository);
    const items: RepositoryPick[] = [...repositories.values()].map(repository => ({
      repository, label: "$(repo) " + repository.nameWithOwner,
      description: repository.isPrivate ? vscode.l10n.t("Private") : vscode.l10n.t("Public"),
      detail: repository.description,
    }));
    if (result.nextPage) items.push({ label: "$(chevron-down) " + vscode.l10n.t("Load more repositories"), action: "more" });
    items.push({ label: "$(link) " + vscode.l10n.t("Enter a repository URL instead"), action: "url" });
    const selected = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Clone from GitHub"),
      placeHolder: repositories.size ? vscode.l10n.t("Select a GitHub repository to clone.")
        : vscode.l10n.t("No accessible repositories found. Enter a repository URL instead."),
      matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true,
    });
    if (!selected) return undefined;
    if (selected.repository) return selected.repository.cloneUrl;
    if (selected.action === "url") return "";
    if (selected.action === "more" && result.nextPage) page = result.nextPage;
    else return undefined;
  }
}

/**
 * 선택한 디렉터리를 열거나 초기화한다. 기존 저장소 안에서는 재초기화 없이 기존 저장소를 사용한다.
 * @param service 저장소 루트 탐색·초기화 서비스
 * @param action open 또는 init
 * @param args 자동화에서 전달한 선택적 디렉터리
 * @returns 실제 저장소 식별 정보. 디렉터리 선택을 취소하면 undefined
 */
async function openOrInitializeRepository(service: RepositorySetupService, action: "open" | "init",
  args: RepositorySetupArgs): Promise<RepositorySetupResult | undefined> {
  const initialFolder = action === "init" && vscode.workspace.workspaceFolders?.length === 1
    ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
  const directory = args.directory ?? initialFolder ?? await pickFolder(action === "init"
    ? vscode.l10n.t("Initialize Repository") : vscode.l10n.t("Open Repository"));
  if (!directory) return undefined;
  if (action === "init") {
    const branch = vscode.workspace.getConfiguration("git").get<string>("defaultBranchName", "main") || "main";
    return cancellableOperation(vscode.l10n.t("Initializing repository with Git Simple Compare..."),
      signal => service.initialize(directory, branch, signal));
  }
  const root = await service.findRepository(directory);
  if (!root) throw new RepositorySetupError("invalid-folder", vscode.l10n.t("The selected folder is not inside a Git repository."));
  return { root, branch: "", created: false };
}

/**
 * 로컬 디렉터리 하나를 선택한다. 가상 workspace 경로를 로컬 Git에 전달하지 않는다.
 * @param label 폴더 선택의 목적을 설명할 제목·버튼 문구
 * @returns 선택한 file URI의 경로, 취소하면 undefined
 */
async function pickFolder(label: string): Promise<string | undefined> {
  const selected = await vscode.window.showOpenDialog({ title: label, openLabel: label,
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
  if (!selected?.length) return undefined;
  if (selected[0].scheme !== "file") throw new RepositorySetupError("invalid-folder", vscode.l10n.t("Choose a local file-system folder."));
  return selected[0].fsPath;
}

/**
 * 입력 검증 오류를 QuickInput의 inline 메시지로 바꾼다.
 * @param validate 사용자의 현재 입력을 검증할 함수
 * @returns 유효하면 undefined, 그렇지 않으면 오류 설명
 */
function inputError(validate: () => unknown): string | undefined {
  try { validate(); return undefined; }
  catch (error) { return error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t("Check the repository input."); }
}

/**
 * 현재 workspace의 저장소는 바로 선택하고 새 폴더는 VS Code의 표준 열기 선택으로 이어 준다.
 * @param deps 새 저장소를 등록하고 Changes를 포커스할 공유 객체
 * @param result 실제 Git 작업 결과
 * @param requestedOpen 자동화의 명시적 열기 방식
 * @returns 현재 창 갱신 또는 다음 창을 위한 handoff 저장과 폴더 열기가 끝나는 Promise
 */
async function connectRepository(deps: SetupDeps, result: RepositorySetupResult,
  requestedOpen?: RepositorySetupArgs["open"]): Promise<void> {
  deps.registry.invalidateResolveCache();
  if (requestedOpen === "none") return;
  const inWorkspace = await Promise.all((vscode.workspace.workspaceFolders ?? [])
    .map(folder => realpath(folder.uri.fsPath).then(value => value === result.root || value.startsWith(result.root + path.sep), () => false)));
  if (inWorkspace.some(Boolean)) {
    await showRepository(deps, result);
    return;
  }
  let open = requestedOpen;
  if (!open && vscode.workspace.workspaceFolders?.length) {
    const current = vscode.l10n.t("Open Repository"), fresh = vscode.l10n.t("Open in New Window"), add = vscode.l10n.t("Add to Workspace");
    const selected = await vscode.window.showInformationMessage(vscode.l10n.t("Repository ready. Where would you like to open it?"), current, fresh, add);
    open = selected === current ? "current" : selected === fresh ? "new" : selected === add ? "add" : undefined;
    if (!open) return;
  }
  await rememberRepositoryHandoff(deps.globalState, result.root);
  if (open === "add") {
    await addRepositoryToWorkspace(result.root);
    await showRepository(deps, result);
  } else {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(result.root), { forceNewWindow: open === "new" });
  }
}

/**
 * 실제 workspace에 있는 결과 저장소를 선택하고 Changes를 읽은 뒤에만 handoff를 소비한다.
 * @param deps 레지스트리·뷰·확장 저장소 @param result Git으로 확인한 결과 저장소
 * @returns 저장소 선택과 화면 연결이 끝나는 Promise. 실패하면 다음 창의 handoff를 보존한다.
 */
async function showRepository(deps: SetupDeps, result: RepositorySetupResult): Promise<void> {
  deps.registry.get(result.root);
  deps.changesView.setRepositories([
    ...deps.changesView.getRepositories().filter(repo => repo.root !== result.root), { root: result.root, branch: result.branch },
  ], result.root);
  // 아래 전체 refresh가 status/stash까지 기다리므로 selectRepo의 개별 조회를 중복 시작하지 않는다.
  deps.changesView.selectRepo(result.root, { refresh: false });
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
  await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason: "workspaceFolders" });
  await finishRepositoryHandoff(deps.globalState, result.root);
}

/**
 * 폴더 추가 API의 true는 시작만 뜻하므로 실제 폴더 이벤트까지 기다린다.
 * - host가 재시작되면 이 호출은 이어지지 않고, 새 host가 저장된 handoff를 처리한다.
 * @param root 추가할 실제 저장소 루트 @returns workspace에 나타나거나 명시적으로 실패하면 끝나는 Promise
 */
async function addRepositoryToWorkspace(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const present = () => vscode.workspace.workspaceFolders?.some(folder => normalize(folder.uri.fsPath) === normalize(root));
    const finish = (error?: Error) => { clearTimeout(timer); listener.dispose(); error ? reject(error) : resolve(); };
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { if (present()) finish(); });
    const timer = setTimeout(() => finish(new Error(vscode.l10n.t("Could not add the repository to the workspace."))), 30_000);
    try {
      const inserted = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(root) });
      if (!inserted) finish(new Error(vscode.l10n.t("Could not add the repository to the workspace.")));
      else if (present()) finish();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
