// Changes 커밋 박스의 hook 관리 UI 요청을 Git 서비스와 VS Code 편집기 동작으로 조립한다.
// - 파일 상태 판단/변경은 CommitHookService 에 위임하고, 확인/알림/로그만 command 계층이 담당한다.
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
  CommitHookService,
  CommitHookError,
  commitHooksDirectoryExists,
  type CommitHookName,
} from "../git/commitHookService";
import { resolveCommitHookDirectory } from "../git/commitHookPaths";
import { logError, logInfo, showOutputLog } from "../ui/outputLog";
import type { CommandDeps } from "./shared";

const hookOperationQueues = new Map<string, Promise<void>>();

/** 웹뷰가 hook 토글을 요청할 때 전달하는 검증 전 인자. */
export interface ToggleCommitHookArgs {
  name?: string;
  enabled?: boolean;
}

/** 실패 항목 클릭 시 편집기 위치를 열기 위한 인자. */
export interface OpenCommitFailureArgs {
  path?: string;
  line?: number;
  column?: number;
}

/**
 * 활성 저장소의 commit hook 상태를 다시 읽어 Changes 웹뷰에 반영한다.
 * @param deps 공유 의존성
 */
export async function refreshCommitHooks(deps: CommandDeps): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root) {
    deps.changesView.setCommitHooks(undefined);
    return;
  }
  await withCommitHookLock(root, async () => {
    const snapshot = await new CommitHookService(root).inspect();
    deps.changesView.setCommitHooks(snapshot);
    logInfo("commit hooks refreshed", {
      root,
      directory: snapshot.directory,
      installed: snapshot.hooks.length,
      enabled: snapshot.hooks.filter((hook) => hook.enabled).length,
      framework: snapshot.framework,
      shared: snapshot.shared,
    });
  });
}

/**
 * 선택한 hook 을 활성화/비활성화하고 최신 상태를 다시 그린다.
 * - 저장소 밖 또는 전역 core.hooksPath 는 여러 저장소에 영향을 줄 수 있어 변경 전에 확인한다.
 * @param deps 공유 의존성
 * @param args hook 이름과 변경 뒤 활성 상태
 */
export async function toggleCommitHook(
  deps: CommandDeps,
  args: ToggleCommitHookArgs
): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root || !args?.name || typeof args.enabled !== "boolean") {
    return;
  }
  const name = args.name;
  const enabled = args.enabled;
  await withCommitHookLock(root, async () => {
    const service = new CommitHookService(root);
    try {
      const before = await service.inspect();
      const hook = before.hooks.find((entry) => entry.name === name);
      if (!hook || !hook.canToggle) {
        throw new CommitHookError("notChangeable", name);
      }
      if (
        before.shared &&
        !(await confirmSharedHookChange(before.directory, name))
      ) {
        logInfo("shared commit hook change cancelled", {
          root,
          hook: name,
          enabled: args.enabled,
        });
        deps.changesView.setCommitHooks(before);
        return;
      }
      const after = await service.setEnabled(
        hook.name,
        enabled,
        before.canonicalDirectory
      );
      const changed = after.hooks.find((entry) => entry.name === hook.name);
      if (!changed || changed.enabled !== enabled) {
        throw new CommitHookError("notChangeable", hook.name);
      }
      deps.changesView.setCommitHooks(after);
      logInfo("commit hook state changed", {
        root,
        hook: hook.name,
        enabled,
        path: hook.path,
      });
      vscode.window.showInformationMessage(
        enabled
          ? vscode.l10n.t("Enabled commit hook '{0}'.", hook.name)
          : vscode.l10n.t("Disabled commit hook '{0}'.", hook.name)
      );
    } catch (error) {
      logError("commit hook state change failed", error, {
        root,
        hook: name,
        enabled: args.enabled,
      });
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not update commit hook: {0}", errorText(error))
      );
      await restoreCommitHookSnapshot(deps, root);
    }
  });
}

/**
 * 아직 설치되지 않은 표준 hook 을 Quick Pick 으로 선택해 안전한 기본 파일을 만든다.
 * @param deps 공유 의존성
 */
export async function createCommitHook(deps: CommandDeps): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root) {
    return;
  }
  await withCommitHookLock(root, async () => {
    const service = new CommitHookService(root);
    try {
      const before = await service.inspect();
      if (before.directoryState === "notDirectory") {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            "The configured hook path is not a directory. Change core.hooksPath before creating a hook."
          )
        );
        return;
      }
      if (!before.creatable.length) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("All supported commit hooks are already installed.")
        );
        return;
      }
      if (before.shared && !(await confirmSharedHookChange(before.directory))) {
        return;
      }
      if (
        !before.localMetadata &&
        !before.shared &&
        !(await confirmWorkingTreeHookCreate(before.directory))
      ) {
        return;
      }
      const picked = await vscode.window.showQuickPick(
        before.creatable.map((name) => ({
          label: name,
          description: hookDescription(name),
          name,
        })),
        { placeHolder: vscode.l10n.t("Select a commit hook to create") }
      );
      if (!picked) {
        return;
      }
      const after = await service.create(
        picked.name,
        before.canonicalDirectory
      );
      deps.changesView.setCommitHooks(after);
      const created = after.hooks.find((hook) => hook.name === picked.name);
      logInfo("commit hook created", {
        root,
        hook: picked.name,
        path: created?.path,
      });
      if (created) {
        await showHookDocument(created.path);
      }
    } catch (error) {
      logError("commit hook create failed", error, { root });
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not create commit hook: {0}", errorText(error))
      );
      await restoreCommitHookSnapshot(deps, root);
    }
  });
}

/**
 * 표준 hook 이름을 서비스에서 다시 확인한 뒤 실제 파일을 텍스트 편집기로 연다.
 * @param deps 공유 의존성
 * @param name 웹뷰가 전달한 hook 이름
 */
export async function openCommitHook(
  deps: CommandDeps,
  name?: string
): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root || !name) {
    return;
  }
  try {
    const filePath = await new CommitHookService(root).resolveInstalledPath(
      name as CommitHookName
    );
    if (!filePath) {
      throw new CommitHookError("notInstalled", name);
    }
    await showHookDocument(filePath);
    logInfo("commit hook opened", { root, hook: name, path: filePath });
  } catch (error) {
    logError("commit hook open failed", error, { root, hook: name });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not open commit hook: {0}", errorText(error))
    );
  }
}

/**
 * 현재 Git 설정으로 해석된 hook 디렉터리를 운영체제 파일 탐색기에 표시한다.
 * @param deps 공유 의존성
 */
export async function openCommitHooksFolder(deps: CommandDeps): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root) {
    return;
  }
  try {
    const snapshot = await new CommitHookService(root).inspect();
    if (!(await commitHooksDirectoryExists(snapshot.directory))) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("The commit hooks folder does not exist yet. Create a hook first.")
      );
      return;
    }
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(snapshot.directory)
    );
    logInfo("commit hooks folder opened", {
      root,
      directory: snapshot.directory,
    });
  } catch (error) {
    logError("commit hooks folder open failed", error, { root });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not open commit hooks folder: {0}", errorText(error))
    );
  }
}

/**
 * hook 실패 항목이 가리키는 저장소 내부 파일과 행/열을 편집기로 연다.
 * - 웹뷰 경로를 그대로 신뢰하지 않고 현재 활성 저장소 경계 안인지 다시 확인한다.
 * @param deps 공유 의존성
 * @param args 저장소 상대 경로와 선택적 1-based 행/열
 */
export async function openCommitFailure(
  deps: CommandDeps,
  args: OpenCommitFailureArgs
): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root || !args?.path) {
    return;
  }
  const target = path.resolve(root, args.path);
  if (!isInside(root, target)) {
    logError("commit failure path rejected", new Error("Path is outside repository"), {
      root,
      path: args.path,
    });
    return;
  }
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    if (!isInside(canonicalRoot, canonicalTarget)) {
      logError(
        "commit failure canonical path rejected",
        new Error("Resolved path is outside repository"),
        { root, path: args.path, target: canonicalTarget }
      );
      return;
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(canonicalTarget)
    );
    const requestedLine = zeroBasedPosition(args.line);
    const line = Math.min(requestedLine, Math.max(0, document.lineCount - 1));
    const requestedColumn = zeroBasedPosition(args.column);
    const column = Math.min(requestedColumn, document.lineAt(line).text.length);
    const position = new vscode.Position(line, column);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(position, position),
    });
    logInfo("commit failure file opened", {
      root,
      path: args.path,
      line: line + 1,
      column: column + 1,
    });
  } catch (error) {
    logError("commit failure file open failed", error, {
      root,
      path: args.path,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not open failed file: {0}", errorText(error))
    );
  }
}

/**
 * 마지막 commit 실패 카드를 Changes 웹뷰에서 제거한다.
 * @param deps 공유 의존성
 */
export function dismissCommitFailure(deps: CommandDeps): void {
  deps.changesView.setCommitFailure(undefined);
  logInfo("commit failure dismissed", {
    root: deps.changesView.getActiveRepo(),
  });
}

/** 전체 hook 원문이 기록된 Git Simple Compare OUTPUT 채널을 표시한다. */
export function showCommitFailureOutput(): void {
  showOutputLog(false);
}

/**
 * 공유될 수 있는 hook 디렉터리 변경의 영향을 사용자에게 확인한다.
 * @param directory 여러 저장소가 참조할 수 있는 hook 디렉터리
 * @param name 선택적 변경 대상 hook 이름
 * @returns 사용자가 명시적으로 계속하기를 선택하면 true
 */
async function confirmSharedHookChange(
  directory: string,
  name?: string
): Promise<boolean> {
  const proceed = vscode.l10n.t("Continue");
  const choice = await vscode.window.showWarningMessage(
    name
      ? vscode.l10n.t(
          "Change shared commit hook '{0}'? Other repositories may use this hook path.",
          name
        )
      : vscode.l10n.t(
          "Create a hook in a shared hook path? Other repositories may use it."
        ),
    { modal: true, detail: directory },
    proceed
  );
  return choice === proceed;
}

/**
 * 저장소 작업트리 안에 새 hook을 만들면 Commit All에 포함될 수 있음을 명시적으로 확인한다.
 * @param directory 새 untracked hook 파일이 생길 custom hook 디렉터리
 * @returns 사용자가 Create를 선택하면 true
 */
async function confirmWorkingTreeHookCreate(directory: string): Promise<boolean> {
  const create = vscode.l10n.t("Create Hook");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Create a hook inside the working tree? Commit All may include the new hook file."
    ),
    { modal: true, detail: directory },
    create
  );
  return choice === create;
}

/**
 * 실패한 mutation 뒤 현재 디스크 상태를 다시 읽되 원래 오류 알림을 덮지 않는다.
 * @param deps Changes provider를 가진 공유 의존성
 * @param root 복구할 저장소 루트
 */
async function restoreCommitHookSnapshot(
  deps: CommandDeps,
  root: string
): Promise<void> {
  try {
    deps.changesView.setCommitHooks(await new CommitHookService(root).inspect());
  } catch (error) {
    logError("commit hook snapshot restore failed", error, { root });
  }
}

/**
 * 같은 실제 hook 디렉터리의 refresh/toggle/create를 요청 순서대로 실행해 상태 역전을 막는다.
 * - main/linked worktree 또는 symlink alias도 canonical directory가 같으면 하나의 queue를 공유한다.
 * @param root hook 경로를 해석할 저장소 루트
 * @param run lock을 얻은 뒤 실행할 비동기 작업
 * @returns 작업 반환값
 */
async function withCommitHookLock<T>(
  root: string,
  run: () => Promise<T>
): Promise<T> {
  const resolved = await resolveCommitHookDirectory(root);
  const lockKey = process.platform === "win32"
    ? path.normalize(resolved.canonicalDirectory).toLowerCase()
    : path.normalize(resolved.canonicalDirectory);
  const previous = hookOperationQueues.get(lockKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  hookOperationQueues.set(lockKey, queued);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (hookOperationQueues.get(lockKey) === queued) {
      hookOperationQueues.delete(lockKey);
    }
  }
}

/**
 * 표준 hook 이름에 대응하는 Quick Pick 설명을 지역화한다.
 * @param name commit hook 이름
 * @returns 실행 시점/목적을 설명하는 짧은 문구
 */
function hookDescription(name: CommitHookName): string {
  switch (name) {
    case "pre-commit":
      return vscode.l10n.t("Runs before Git creates the commit message.");
    case "prepare-commit-msg":
      return vscode.l10n.t("Prepares the commit message file.");
    case "commit-msg":
      return vscode.l10n.t("Validates the completed commit message.");
    case "post-commit":
      return vscode.l10n.t("Runs after a commit is created.");
    case "post-rewrite":
      return vscode.l10n.t("Runs after amend rewrites a commit.");
    case "pre-merge-commit":
      return vscode.l10n.t("Runs before Git creates a merge commit.");
  }
}

/**
 * hook 파일을 일반 텍스트 문서로 열어 사용자가 즉시 편집할 수 있게 한다.
 * @param filePath 서비스가 검증한 hook 절대 경로
 */
async function showHookDocument(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * 후보 경로가 저장소 내부인지 path.relative 로 검증한다.
 * @param root 저장소 루트 절대 경로
 * @param candidate 열려는 파일 절대 경로
 * @returns 루트 또는 하위 경로면 true
 */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 웹뷰/외부 명령에서 받은 1-based 행·열 값을 안전한 0-based 정수로 바꾼다.
 * @param value 행 또는 열 후보
 * @returns 유한한 양수면 1을 뺀 값, 아니면 0
 */
function zeroBasedPosition(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value) - 1
    : 0;
}

/**
 * 알 수 없는 throw 값을 사용자 알림용 문자열로 바꾸고 알려진 hook 오류 코드는 지역화한다.
 * @param error catch 로 받은 값
 * @returns Error.message 또는 문자열 변환 결과
 */
function errorText(error: unknown): string {
  if (error instanceof CommitHookError) {
    switch (error.code) {
      case "notInstalled":
        return vscode.l10n.t("Hook '{0}' is not installed.", error.hookName);
      case "tracked":
        return vscode.l10n.t(
          "Tracked hook '{0}' cannot be toggled safely.",
          error.hookName
        );
      case "worktreeVisible":
        return vscode.l10n.t(
          "Untracked hook '{0}' could be included in the next commit.",
          error.hookName
        );
      case "alreadyExistsOrTracked":
        return vscode.l10n.t(
          "Hook '{0}' already exists or is tracked by Git.",
          error.hookName
        );
      case "alreadyExists":
        return vscode.l10n.t("Hook '{0}' already exists.", error.hookName);
      case "conflict":
        return vscode.l10n.t(
          "Hook '{0}' has both active and disabled files.",
          error.hookName
        );
      case "pathChanged":
        return vscode.l10n.t(
          "The hook path changed before '{0}' could be updated. Refresh and try again.",
          error.hookName
        );
      case "fileChanged":
        return vscode.l10n.t(
          "Hook '{0}' changed before its executable bit could be updated. Refresh and try again.",
          error.hookName
        );
      case "unsupported":
        return vscode.l10n.t("Unsupported commit hook '{0}'.", error.hookName);
      case "notChangeable":
        return vscode.l10n.t(
          "Hook '{0}' cannot be changed in its current state.",
          error.hookName
        );
    }
  }
  return error instanceof Error ? error.message : String(error);
}
