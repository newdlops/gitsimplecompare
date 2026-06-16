// Git user profile 설정 명령.
// - 사이드 패널 헤더 메뉴에서 global/profile-local user.name/user.email 을 편집한다.
// - git config 접근은 git/userProfileService 에 위임하고, 여기서는 VS Code UX 만 담당한다.
import * as vscode from "vscode";
import {
  GitUserProfileScope,
  GitUserProfileService,
  type GitUserProfile,
} from "../git/userProfileService";
import { logError, logInfo } from "../ui/outputLog";
import { CommandDeps, resolveCompareService } from "./shared";

interface ProfileTarget {
  scope: GitUserProfileScope;
  cwd: string;
  label: string;
  logScope: "global" | "project";
}

/**
 * Git user profile 설정 메뉴를 연다.
 * - 사용자가 global 또는 현재 프로젝트 local profile 을 고른 뒤 user.name/user.email 을 입력한다.
 * - 값이 비어 있으면 해당 key 를 unset 하여 상위 git config 값이 적용될 수 있게 한다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function configureUserProfile(deps: CommandDeps): Promise<void> {
  logInfo("user profile settings opened");
  const scope = await pickProfileScope();
  if (!scope) {
    logInfo("user profile settings cancelled", { step: "scope" });
    return;
  }

  const target = await resolveProfileTarget(deps, scope);
  if (!target) {
    logInfo("user profile settings cancelled", { step: "target", scope });
    return;
  }

  const service = new GitUserProfileService(target.cwd);
  try {
    const current = await service.readProfile(target.scope);
    const next = await inputProfile(target, current);
    if (!next) {
      logInfo("user profile settings cancelled", {
        step: "input",
        scope: target.logScope,
      });
      return;
    }
    await service.writeProfile(target.scope, next);
    logInfo("user profile saved", {
      scope: target.logScope,
      cwd: target.cwd,
      hasName: next.name.trim().length > 0,
      hasEmail: next.email.trim().length > 0,
    });
    vscode.window.showInformationMessage(
      vscode.l10n.t("Git user profile saved for {0}.", target.label)
    );
  } catch (error) {
    logError("user profile settings failed", error, {
      scope: target.logScope,
      cwd: target.cwd,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Git user profile settings failed: {0}", errText(error))
    );
  }
}

/**
 * 사용자가 편집할 프로필 범위를 고른다.
 * - global 은 모든 저장소 기본값, project 는 현재 저장소의 `.git/config` 값이다.
 * @returns 선택한 scope. 취소하면 undefined
 */
async function pickProfileScope(): Promise<GitUserProfileScope | undefined> {
  const items: Array<vscode.QuickPickItem & { value: GitUserProfileScope }> = [
    {
      label: "$(globe) " + vscode.l10n.t("Global Profile"),
      detail: vscode.l10n.t(
        "Applies to all repositories unless a project profile overrides it."
      ),
      value: "global",
    },
    {
      label: "$(repo) " + vscode.l10n.t("Project Profile"),
      detail: vscode.l10n.t("Applies only to the selected repository."),
      value: "local",
    },
  ];
  return (await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Git User Profile"),
    placeHolder: vscode.l10n.t("Choose which Git user profile to edit."),
  }))?.value;
}

/**
 * 선택한 scope 에 맞는 git config 실행 대상을 만든다.
 * - global 은 저장소가 없어도 동작하므로 워크스페이스 폴더 또는 프로세스 cwd 를 사용한다.
 * - project 는 현재 비교 뷰의 활성 저장소를 우선하고 없으면 워크스페이스 저장소를 탐지한다.
 * @param deps 명령 공유 의존성
 * @param scope 사용자가 선택한 설정 범위
 */
async function resolveProfileTarget(
  deps: CommandDeps,
  scope: GitUserProfileScope
): Promise<ProfileTarget | undefined> {
  if (scope === "global") {
    return {
      scope,
      cwd: globalConfigCwd(deps),
      label: vscode.l10n.t("global profile"),
      logScope: "global",
    };
  }

  const service = await resolveCompareService(deps);
  if (!service) {
    return undefined;
  }
  return {
    scope,
    cwd: service.repoRoot,
    label: vscode.l10n.t("this project"),
    logScope: "project",
  };
}

/**
 * global git config 명령을 실행할 cwd 를 고른다.
 * - global config 자체는 저장소와 무관하지만 execFile 은 존재하는 cwd 가 필요하다.
 * @param deps 명령 공유 의존성
 */
function globalConfigCwd(deps: CommandDeps): string {
  return (
    deps.changesView.getActiveRepo() ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    process.cwd()
  );
}

/**
 * user.name 과 user.email 을 순서대로 입력받는다.
 * - 첫 입력 또는 두 번째 입력에서 취소하면 아무 것도 저장하지 않는다.
 * @param target 저장 대상 범위와 표시 라벨
 * @param current 현재 저장된 프로필 값
 */
async function inputProfile(
  target: ProfileTarget,
  current: GitUserProfile
): Promise<GitUserProfile | undefined> {
  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("{0} Git user.name", target.label),
    value: current.name,
    prompt: vscode.l10n.t("Leave empty to unset user.name."),
  });
  if (name === undefined) {
    return undefined;
  }

  const email = await vscode.window.showInputBox({
    title: vscode.l10n.t("{0} Git user.email", target.label),
    value: current.email,
    prompt: vscode.l10n.t("Leave empty to unset user.email."),
  });
  if (email === undefined) {
    return undefined;
  }

  return { name, email };
}

/** 오류 값을 사용자에게 보여줄 짧은 문자열로 변환한다. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
