// git worktree 명령 핸들러 모듈.
// - 사용자 입력/확인/알림은 여기서 처리하고, 실제 git 명령은 WorktreeService 에 위임한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BranchInfo } from "../git/gitTypes";
import { WorktreeService } from "../git/worktreeService";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import { GitGraphPanel } from "../webview/graphPanel";
import type { CommandDeps } from "./shared";
import {
  readWorkspaceWorktreeGroups,
  refreshWorktreesForChangesView,
  toWorktreeCommandArg,
  type WorktreeCommandArg,
  type WorktreeRepositoryGroup,
} from "./worktreeState";

type WorktreeCreateMode = "existingRef" | "newBranch";

type WorktreeCommandInput = WorktreeCommandArg;

/** worktree 트리뷰를 수동으로 새로고침한다. */
export async function refreshWorktrees(deps: CommandDeps): Promise<void> {
  await refreshWorktreesForChangesView(deps);
}

/**
 * worktree 폴더를 새 VS Code 창으로 연다.
 * @param arg 트리 항목이나 QuickPick 에서 전달한 worktree 컨텍스트
 */
export async function openWorktree(arg?: WorktreeCommandInput): Promise<void> {
  const target = normalizeWorktreeInput(arg);
  if (!target?.path) {
    logWarn("worktree open skipped: missing target path");
    return;
  }
  const worktreePath = resolveWorktreeOpenPath(target);
  if (!(await isDirectory(worktreePath))) {
    logWarn("worktree open skipped: path is not a directory", {
      repoRoot: target.repoRoot,
      path: worktreePath,
      branch: target.branch,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t("Worktree path is not available: {0}", worktreePath)
    );
    return;
  }

  try {
    logInfo("worktree open requested", {
      repoRoot: target.repoRoot,
      path: worktreePath,
      branch: target.branch,
      forceNewWindow: true,
    });
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(worktreePath),
      true
    );
  } catch (err) {
    logError("worktree open failed", err, {
      repoRoot: target.repoRoot,
      path: worktreePath,
      branch: target.branch,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not open worktree: {0}", errorText(err))
    );
  }
}

/**
 * 새 git worktree 를 만든다.
 * - 저장소/시작점/생성 모드/경로를 차례로 입력받아 `git worktree add` 를 실행한다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function createWorktree(deps: CommandDeps): Promise<void> {
  const group = await pickRepository(deps);
  if (!group) {
    return;
  }
  const git = deps.registry.get(group.repoRoot);
  const branches = await git.listBranches(true);
  const startPoint = await pickStartPoint(branches);
  if (!startPoint) {
    return;
  }
  const mode = await pickCreateMode();
  if (!mode) {
    return;
  }
  const worktreeService = new WorktreeService(group.repoRoot);
  const newBranch =
    mode === "newBranch"
      ? await inputNewBranchName(worktreeService, branches, startPoint)
      : undefined;
  if (mode === "newBranch" && !newBranch) {
    return;
  }
  const worktreePath = await inputWorktreePath(group, newBranch ?? startPoint);
  if (!worktreePath) {
    return;
  }

  try {
    logInfo("worktree create started", {
      repoRoot: group.repoRoot,
      path: worktreePath,
      startPoint,
      newBranch,
    });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Creating worktree"),
        cancellable: false,
      },
      () =>
        worktreeService.createWorktree({
          worktreePath,
          startPoint,
          newBranch,
        })
    );
    logInfo("worktree create finished", {
      repoRoot: group.repoRoot,
      path: worktreePath,
      startPoint,
      newBranch,
    });
    await refreshAfterWorktreeChange(deps, group.repoRoot, "worktreeCreated");
    const open = vscode.l10n.t("Open Worktree");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("Worktree created: {0}", worktreePath),
      open
    );
    if (choice === open) {
      await openWorktree({
        repoRoot: group.repoRoot,
        path: worktreePath,
        isMain: false,
        branch: newBranch ?? startPoint,
      });
    }
  } catch (err) {
    logError("worktree create failed", err, {
      repoRoot: group.repoRoot,
      path: worktreePath,
      startPoint,
      newBranch,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not create worktree: {0}", errorText(err))
    );
  }
}

/**
 * linked worktree 를 제거한다.
 * - main worktree 는 제거하지 않으며, 안전 제거 실패 시 사용자가 명시적으로 선택한 경우에만 force 제거한다.
 * @param deps 명령들이 공유하는 의존성
 * @param arg 트리 항목에서 직접 호출될 때 전달되는 worktree 컨텍스트
 */
export async function removeWorktree(
  deps: CommandDeps,
  arg?: WorktreeCommandInput
): Promise<void> {
  const target = await resolveLinkedWorktree(deps, arg, "Select a worktree to remove");
  if (!target) {
    return;
  }
  const remove = vscode.l10n.t("Remove Worktree");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Remove worktree '{0}'? Uncommitted changes will block removal.",
      target.path
    ),
    { modal: true },
    remove
  );
  if (choice !== remove) {
    return;
  }
  const service = new WorktreeService(target.repoRoot);
  try {
    await runRemoveWorktree(service, target, false);
    await finishWorktreeRemoval(deps, target, false);
  } catch (err) {
    logError("worktree remove failed", err, {
      repoRoot: target.repoRoot,
      path: target.path,
      force: false,
    });
    await offerForceRemove(deps, service, target, err);
  }
}

/**
 * linked worktree 의 폴더명을 변경한다.
 * - Git worktree 에 별도 표시 이름이 없으므로 같은 부모 디렉터리 안에서 경로를 이동한다.
 * @param deps 명령들이 공유하는 의존성
 * @param arg 트리 항목에서 직접 호출될 때 전달되는 worktree 컨텍스트
 */
export async function renameWorktree(
  deps: CommandDeps,
  arg?: WorktreeCommandInput
): Promise<void> {
  const target = await resolveLinkedWorktree(deps, arg, "Select a worktree to rename");
  if (!target) {
    return;
  }
  const nextName = await inputWorktreeFolderName(target.path);
  if (!nextName) {
    return;
  }
  const newPath = path.join(path.dirname(target.path), nextName);
  try {
    logInfo("worktree rename started", {
      repoRoot: target.repoRoot,
      oldPath: target.path,
      newPath,
    });
    await new WorktreeService(target.repoRoot).renameWorktree(target.path, newPath);
    logInfo("worktree rename finished", {
      repoRoot: target.repoRoot,
      oldPath: target.path,
      newPath,
    });
    await refreshAfterWorktreeChange(deps, target.repoRoot, "worktreeRenamed");
    vscode.window.showInformationMessage(
      vscode.l10n.t("Worktree renamed to: {0}", newPath)
    );
  } catch (err) {
    logError("worktree rename failed", err, {
      repoRoot: target.repoRoot,
      oldPath: target.path,
      newPath,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not rename worktree: {0}", errorText(err))
    );
  }
}

/** 저장소 그룹을 선택한다. 그룹이 하나뿐이면 바로 반환한다. */
async function pickRepository(
  deps: CommandDeps
): Promise<WorktreeRepositoryGroup | undefined> {
  const groups = await readWorkspaceWorktreeGroups(deps);
  if (!groups.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No git repository found in the open workspace.")
    );
    return undefined;
  }
  if (groups.length === 1) {
    return groups[0];
  }
  const picked = await vscode.window.showQuickPick(
    groups.map((group) => ({
      label: group.repoName,
      description: group.worktrees[0]?.path ?? group.repoRoot,
      detail: vscode.l10n.t("{0} worktree(s)", group.worktrees.length),
      group,
    })),
    { placeHolder: vscode.l10n.t("Select a repository for worktree action") }
  );
  return picked?.group;
}

/** worktree 생성 기준으로 사용할 branch/ref 를 선택한다. */
async function pickStartPoint(branches: BranchInfo[]): Promise<string | undefined> {
  const items = branches.map((branch) => ({
    label: branch.name,
    description:
      branch.kind === "remote" ? vscode.l10n.t("remote") : vscode.l10n.t("local"),
    detail: branch.isCurrent ? vscode.l10n.t("current branch") : undefined,
    branch,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t("Select a branch or ref for the new worktree"),
  });
  return picked?.branch.name;
}

/** 새 worktree 를 기존 ref 그대로 checkout 할지 새 브랜치를 만들지 선택한다. */
async function pickCreateMode(): Promise<WorktreeCreateMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t("Create New Branch"),
        description: vscode.l10n.t("Create a local branch for this worktree."),
        mode: "newBranch" as const,
      },
      {
        label: vscode.l10n.t("Use Existing Ref"),
        description: vscode.l10n.t("Checkout the selected ref directly."),
        mode: "existingRef" as const,
      },
    ],
    { placeHolder: vscode.l10n.t("Choose how to create the worktree") }
  );
  return picked?.mode;
}

/** 새 local branch 이름을 입력받고 Git ref 규칙으로 즉시 검증한다. */
async function inputNewBranchName(
  service: WorktreeService,
  branches: BranchInfo[],
  startPoint: string
): Promise<string | undefined> {
  const existingLocal = new Set(
    branches.filter((branch) => branch.kind === "local").map((branch) => branch.name)
  );
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name"),
    value: defaultBranchName(startPoint),
    validateInput: async (input) => {
      const name = input.trim();
      if (!name) {
        return vscode.l10n.t("Branch name is required.");
      }
      if (existingLocal.has(name)) {
        return vscode.l10n.t("Branch '{0}' already exists.", name);
      }
      try {
        await service.assertValidBranchName(name);
        return undefined;
      } catch {
        return vscode.l10n.t("Invalid branch name.");
      }
    },
  });
  return value?.trim() || undefined;
}

/** worktree 생성 경로를 입력받고 이미 존재하는 경로를 막는다. */
async function inputWorktreePath(
  group: WorktreeRepositoryGroup,
  nameSeed: string
): Promise<string | undefined> {
  const baseDir = path.dirname(group.worktrees[0]?.path ?? group.repoRoot);
  const defaultPath = path.join(baseDir, safeFolderName(nameSeed));
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Worktree folder path"),
    value: defaultPath,
    validateInput: async (input) => {
      const resolved = resolvePathInput(baseDir, input);
      if (!resolved) {
        return vscode.l10n.t("Worktree path is required.");
      }
      return (await pathExists(resolved))
        ? vscode.l10n.t("Path already exists: {0}", resolved)
        : undefined;
    },
  });
  return resolvePathInput(baseDir, value);
}

/** linked worktree 의 새 폴더명을 입력받는다. */
async function inputWorktreeFolderName(oldPath: string): Promise<string | undefined> {
  const oldName = path.basename(oldPath);
  const parent = path.dirname(oldPath);
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New worktree folder name"),
    value: oldName,
    validateInput: async (input) => {
      const name = input.trim();
      if (!name) {
        return vscode.l10n.t("Worktree name is required.");
      }
      if (name.includes("/") || name.includes("\\")) {
        return vscode.l10n.t("Use a folder name, not a path.");
      }
      const nextPath = path.join(parent, name);
      if (nextPath !== oldPath && await pathExists(nextPath)) {
        return vscode.l10n.t("Path already exists: {0}", nextPath);
      }
      return undefined;
    },
  });
  const name = value?.trim();
  return name && name !== oldName ? name : undefined;
}

/** 트리 인자 또는 QuickPick 선택을 linked worktree 대상으로 정규화한다. */
async function resolveLinkedWorktree(
  deps: CommandDeps,
  arg: WorktreeCommandInput | undefined,
  placeHolder: string
): Promise<WorktreeCommandArg | undefined> {
  const normalized = normalizeWorktreeInput(arg);
  if (normalized?.isMain) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("The main worktree cannot be removed or renamed.")
    );
    return undefined;
  }
  if (normalized?.path) {
    return normalized;
  }
  const worktrees = (await readWorkspaceWorktreeGroups(deps)).flatMap((group) =>
    group.worktrees
      .filter((worktree) => !worktree.isMain)
      .map((worktree) => toWorktreeCommandArg(group.repoRoot, worktree))
  );
  if (!worktrees.length) {
    vscode.window.showInformationMessage(vscode.l10n.t("No linked worktrees found."));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    worktrees.map((worktree) => ({
      label: path.basename(worktree.path) || worktree.path,
      description: worktree.branch ?? vscode.l10n.t("detached"),
      detail: worktree.path,
      worktree,
    })),
    { placeHolder: vscode.l10n.t(placeHolder) }
  );
  return picked?.worktree;
}

/** TreeItem.command 인자와 view/item/context element 를 같은 command arg 로 정규화한다. */
function normalizeWorktreeInput(
  arg: WorktreeCommandInput | undefined
): WorktreeCommandArg | undefined {
  return arg?.path ? arg : undefined;
}

/** worktree 열기 대상 경로를 절대 경로로 정규화한다. */
function resolveWorktreeOpenPath(target: WorktreeCommandArg): string {
  const trimmed = target.path.trim();
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  const baseDir = target.repoRoot || process.cwd();
  return path.normalize(path.resolve(baseDir, trimmed));
}

/** worktree 제거를 실행하고 관찰 가능한 로그를 남긴다. */
async function runRemoveWorktree(
  service: WorktreeService,
  target: WorktreeCommandArg,
  force: boolean
): Promise<void> {
  logInfo("worktree remove started", {
    repoRoot: target.repoRoot,
    path: target.path,
    force,
  });
  await service.removeWorktree(target.path, force);
}

/** 안전 제거가 실패했을 때 force 제거를 별도 확인 후 실행한다. */
async function offerForceRemove(
  deps: CommandDeps,
  service: WorktreeService,
  target: WorktreeCommandArg,
  cause: unknown
): Promise<void> {
  const force = vscode.l10n.t("Force Remove");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Could not remove worktree: {0}", errorText(cause)),
    { modal: true },
    force
  );
  if (choice !== force) {
    return;
  }
  try {
    await runRemoveWorktree(service, target, true);
    await finishWorktreeRemoval(deps, target, true);
  } catch (err) {
    logError("worktree force remove failed", err, {
      repoRoot: target.repoRoot,
      path: target.path,
      force: true,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not remove worktree: {0}", errorText(err))
    );
  }
}

/** worktree 제거 성공 후 캐시/뷰를 갱신하고 사용자에게 알린다. */
async function finishWorktreeRemoval(
  deps: CommandDeps,
  target: WorktreeCommandArg,
  force: boolean
): Promise<void> {
  logInfo("worktree remove finished", {
    repoRoot: target.repoRoot,
    path: target.path,
    force,
  });
  await refreshAfterWorktreeChange(deps, target.repoRoot, "worktreeRemoved");
  vscode.window.showInformationMessage(
    vscode.l10n.t("Worktree removed: {0}", target.path)
  );
}

/** worktree 변경 뒤 저장소 탐지/상태 캐시와 관련 뷰를 갱신한다. */
async function refreshAfterWorktreeChange(
  deps: CommandDeps,
  repoRoot: string,
  reason: string
): Promise<void> {
  deps.registry.invalidateResolveCache();
  deps.registry.invalidateStatusCaches();
  await refreshWorktreesForChangesView(deps);
  GitGraphPanel.refreshOpen(repoRoot, reason);
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
}

/** 시작점 이름으로 새 브랜치 기본값을 만든다. */
function defaultBranchName(startPoint: string): string {
  return `${startPoint.replace(/^origin\//, "").replace(/[^A-Za-z0-9._/-]+/g, "-")}-worktree`;
}

/** ref/branch 이름을 폴더명으로 쓰기 안전한 문자열로 바꾼다. */
function safeFolderName(value: string): string {
  return value.replace(/^[A-Za-z]+\/HEAD$/, "worktree").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** 입력한 경로를 기준 디렉터리 아래의 절대 경로로 정규화한다. */
function resolvePathInput(baseDir: string, value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed));
}

/** 파일 시스템 경로가 이미 존재하는지 확인한다. */
async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}

/** 파일 시스템 경로가 실제 디렉터리인지 확인한다. */
async function isDirectory(fsPath: string): Promise<boolean> {
  try {
    return (await fs.stat(fsPath)).isDirectory();
  } catch {
    return false;
  }
}

/** 오류 객체에서 사용자에게 보여줄 메시지를 뽑는다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
