// 현재 브랜치의 remote/upstream 설정을 안내하는 VS Code UI 모듈.
// - git 상태 조회/변경은 RemoteBranchService 에 위임하고, 선택/확인/알림만 담당한다.
import * as vscode from "vscode";
import {
  CurrentRemoteBranchState,
  RemoteBranchService,
  RemoteBranchSetupResult,
  RemoteTrackingBranch,
} from "../git/remoteBranchService";
import { isForcePushRequiredError, gitErrorText } from "../git/pushErrors";
import { logInfo } from "./outputLog";

export type RemoteBranchSetupReason = "manual" | "pull" | "openRemoteBranch";

export type PromptRemoteBranchSetupResult =
  | { status: "configured"; result: RemoteBranchSetupResult }
  | { status: "published"; result: RemoteBranchSetupResult }
  | { status: "canceled" }
  | { status: "unavailable" };

type RemoteBranchPick =
  | (vscode.QuickPickItem & { action: "set"; branch: RemoteTrackingBranch })
  | (vscode.QuickPickItem & {
      action: "publish";
      remote: string;
      remoteBranch: string;
    });

/**
 * 현재 브랜치의 원격 브랜치를 설정하는 사용자 흐름을 실행한다.
 * - 기존 remote tracking branch 가 있으면 upstream 으로 지정할 수 있다.
 * - remote branch 가 아직 없으면 현재 브랜치를 push 하면서 upstream 을 만든다.
 * @param repoRoot 설정할 git 저장소 루트
 * @param reason 이 흐름을 연 사용자 동작. 안내 문구와 로그에 사용한다.
 */
export async function promptRemoteBranchSetup(
  repoRoot: string,
  reason: RemoteBranchSetupReason
): Promise<PromptRemoteBranchSetupResult> {
  const service = new RemoteBranchService(repoRoot);
  const state = await service.getCurrentBranchRemoteState();
  if (!state.branch) {
    await vscode.window.showWarningMessage(
      vscode.l10n.t("Cannot set a remote branch while HEAD is detached.")
    );
    return { status: "unavailable" };
  }
  if (state.remotes.length === 0) {
    return showNoRemoteMessage();
  }
  const currentBranch = state.branch;

  const picked = await vscode.window.showQuickPick(buildRemoteBranchPicks(state, currentBranch), {
    placeHolder: setupPlaceHolder(currentBranch, reason),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return { status: "canceled" };
  }

  if (picked.action === "set") {
    return setExistingRemoteBranch(service, picked.branch.name, repoRoot);
  }
  return publishCurrentBranch(
    service,
    state,
    currentBranch,
    picked.remote,
    picked.remoteBranch,
    repoRoot
  );
}

/**
 * 현재 브랜치가 pull/open remote 동작에 필요한 upstream 을 갖도록 보장한다.
 * - 이미 정상 upstream 이 있으면 true 를 반환하고 아무 UI 도 띄우지 않는다.
 * - upstream 이 없거나 gone 이면 설정 흐름을 열고, 성공 여부를 boolean 으로 반환한다.
 * @param repoRoot git 저장소 루트
 * @param reason upstream 이 필요한 동작
 */
export async function ensureRemoteBranchForCurrentBranch(
  repoRoot: string,
  reason: RemoteBranchSetupReason
): Promise<boolean> {
  const service = new RemoteBranchService(repoRoot);
  const state = await service.getCurrentBranchRemoteState();
  if (state.upstream && !state.upstreamGone) {
    return true;
  }
  const setup = await promptRemoteBranchSetup(repoRoot, reason);
  return setup.status === "configured" || setup.status === "published";
}

/**
 * remote 가 없는 저장소에서 Add Remote 안내를 띄운다.
 * @returns 사용자가 remote 를 추가하러 갔더라도 현재 호출은 중단되므로 unavailable
 */
async function showNoRemoteMessage(): Promise<PromptRemoteBranchSetupResult> {
  const addRemote = vscode.l10n.t("Add Remote...");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "No git remote found. Add a remote before setting the current branch remote."
    ),
    addRemote
  );
  if (choice === addRemote) {
    try {
      await vscode.commands.executeCommand("git.addRemote");
    } catch {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Could not run '{0}'. The built-in Git extension is required.",
          "git.addRemote"
        )
      );
    }
  }
  return { status: "unavailable" };
}

/**
 * QuickPick 에 표시할 기존 upstream 지정/새 remote branch 생성 항목을 만든다.
 * @param state 현재 브랜치와 remote 목록 상태
 * @param currentBranch 현재 로컬 브랜치 이름
 */
function buildRemoteBranchPicks(
  state: CurrentRemoteBranchState,
  currentBranch: string
): RemoteBranchPick[] {
  const existing = state.remoteBranches.map((branch) => ({
    label: branch.name,
    description:
      branch.name === state.upstream
        ? vscode.l10n.t("current upstream")
        : vscode.l10n.t("Use existing remote branch"),
    detail: vscode.l10n.t(
      "Set '{0}' as the upstream for '{1}'.",
      branch.name,
      currentBranch
    ),
    action: "set" as const,
    branch,
  }));
  const publish = state.remotes.map((remote) => ({
    label: `${remote}/${currentBranch}`,
    description: vscode.l10n.t("Push current branch and set upstream"),
    detail: vscode.l10n.t(
      "Create '{0}' on '{1}' and set it as upstream.",
      currentBranch,
      remote
    ),
    action: "publish" as const,
    remote,
    remoteBranch: currentBranch,
  }));
  return [...existing, ...publish];
}

/**
 * 설정 QuickPick 의 상황별 placeholder 를 만든다.
 * @param currentBranch 현재 로컬 브랜치 이름
 * @param reason 설정을 요청한 동작
 */
function setupPlaceHolder(
  currentBranch: string,
  reason: RemoteBranchSetupReason
): string {
  if (reason === "pull") {
    return vscode.l10n.t(
      "Select or create a remote branch before pulling '{0}'.",
      currentBranch
    );
  }
  if (reason === "openRemoteBranch") {
    return vscode.l10n.t(
      "Select or create a remote branch to open for '{0}'.",
      currentBranch
    );
  }
  return vscode.l10n.t(
    "Select or create a remote branch for '{0}'.",
    currentBranch
  );
}

/**
 * 기존 remote tracking branch 를 현재 브랜치의 upstream 으로 설정한다.
 * @param service remote branch git 서비스
 * @param upstream 선택된 remote branch short name
 * @param repoRoot 로그에 남길 저장소 루트
 */
async function setExistingRemoteBranch(
  service: RemoteBranchService,
  upstream: string,
  repoRoot: string
): Promise<PromptRemoteBranchSetupResult> {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Setting remote branch..."),
    },
    () => service.setCurrentBranchUpstream(upstream)
  );
  logInfo("remote branch upstream configured", {
    repoRoot,
    branch: result.branch,
    upstream: result.upstream,
  });
  vscode.window.showInformationMessage(
    vscode.l10n.t("Remote branch set to '{0}'.", result.upstream)
  );
  return { status: "configured", result };
}

/**
 * 현재 브랜치를 push 해서 remote branch 를 만들고 upstream 을 설정한다.
 * @param service remote branch git 서비스
 * @param state 현재 브랜치 remote 상태
 * @param currentBranch 현재 로컬 브랜치 이름
 * @param remote push 대상 remote 이름
 * @param remoteBranch 생성할 remote branch 이름
 * @param repoRoot 로그에 남길 저장소 루트
 */
async function publishCurrentBranch(
  service: RemoteBranchService,
  state: CurrentRemoteBranchState,
  currentBranch: string,
  remote: string,
  remoteBranch: string,
  repoRoot: string
): Promise<PromptRemoteBranchSetupResult> {
  const target = `${remote}/${remoteBranch}`;
  if (!(await confirmPublish(state, currentBranch, target))) {
    return { status: "canceled" };
  }
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Pushing..."),
      },
      () => service.pushCurrentBranchToRemote(remote, remoteBranch)
    );
    logInfo("remote branch published and configured", {
      repoRoot,
      branch: result.branch,
      upstream: result.upstream,
    });
    vscode.window.showInformationMessage(
      vscode.l10n.t("Remote branch '{0}' created and set as upstream.", result.upstream)
    );
    return { status: "published", result };
  } catch (err) {
    if (isForcePushRequiredError(err)) {
      await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Push was rejected because the remote branch is not a fast-forward update. Git Simple Compare does not provide force push."
        ),
        { modal: true, detail: gitErrorText(err) }
      );
      return { status: "unavailable" };
    }
    throw err;
  }
}

/**
 * remote branch 를 만들 수 있는 push 실행 전에 사용자 확인을 받는다.
 * @param state 기존 upstream 정보
 * @param currentBranch 현재 로컬 브랜치 이름
 * @param target 새 upstream short name
 */
async function confirmPublish(
  state: CurrentRemoteBranchState,
  currentBranch: string,
  target: string
): Promise<boolean> {
  const confirm = vscode.l10n.t("Push and Set Upstream");
  const detail = state.upstream
    ? vscode.l10n.t(
        "Current upstream: {0}\nNew upstream: {1}\nIf the new remote branch does not exist, Git will create it.",
        state.upstream,
        target
      )
    : vscode.l10n.t(
        "New upstream: {0}\nIf this remote branch does not exist, Git will create it.",
        target
      );
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Push branch '{0}' to remote branch '{1}'?",
      currentBranch,
      target
    ),
    { modal: true, detail },
    confirm
  );
  return choice === confirm;
}
