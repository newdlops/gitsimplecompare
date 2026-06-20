// Changes 섹션의 "미트볼(...)" 메뉴 정의 + 액션 디스패처.
// - VS Code Source Control 의 ... 메뉴 구성을 그대로 재현한다(View & Sort / Commit /
//   Changes / Pull,Push / Branch / Stash / Remote / Tags / Output / Clone).
// - 메뉴 "구성(라벨/구조)"은 buildScmMenu 가 만들어 웹뷰에 주입하고, 웹뷰는 선택된
//   액션 ID 만 되돌려 보낸다. 실제 "동작"은 runScmAction 이 담당한다(표시/동작 분리).
// - 스테이징/커밋/일반 push 처럼 우리 UI 정책과 밀접한 것은 직접 구현하고, 나머지 git.* 동작은
//   내장 Git 확장의 명령에 위임해 충실도를 유지한다(화이트리스트로만 실행).
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { gitErrorText, isForcePushRequiredError } from "../git/pushErrors";
import { getCurrentPushPlan } from "../git/pushService";
import { logInfo } from "../ui/outputLog";
import { confirmPushCurrentPlan } from "../ui/pushConfirmation";
import { CommandDeps, resolveCompareService } from "./shared";
import { syncViewContext } from "./viewState";
import {
  commitChanges,
  discardChanges,
  stageChanges,
  unstageChanges,
} from "./workingChanges";

/** 미트볼 메뉴 노드(리프 액션 / 하위 메뉴 / 구분선). */
export interface MenuNode {
  /** 리프일 때의 액션 ID(하위 메뉴/구분선이면 없음). */
  id?: string;
  /** 표시 라벨(구분선이면 없음). */
  label?: string;
  /** 하위 메뉴(있으면 드릴다운). */
  submenu?: MenuNode[];
  /** 구분선이면 true. */
  separator?: boolean;
}

/**
 * 미트볼 메뉴 트리를 만든다(라벨은 지역화). 웹뷰가 이 데이터로 드롭다운을 그린다.
 * - 항목을 추가/변경할 땐 여기만 손대면 된다(웹뷰는 데이터 기반으로 렌더, 확장성).
 */
export function buildScmMenu(): MenuNode[] {
  const t = vscode.l10n.t;
  const sep: MenuNode = { separator: true };
  return [
    {
      label: t("View & Sort"),
      submenu: [
        { id: "viewTree", label: t("View as Tree") },
        { id: "viewList", label: t("View as List") },
        sep,
        { id: "sortName", label: t("Sort by Name") },
        { id: "sortPath", label: t("Sort by Path") },
        { id: "sortStatus", label: t("Sort by Status") },
      ],
    },
    sep,
    {
      label: t("Commit"),
      submenu: [
        { id: "commit", label: t("Commit") },
        { id: "commitStaged", label: t("Commit Staged") },
        { id: "commitAll", label: t("Commit All") },
        sep,
        { id: "commitAmend", label: t("Commit (Amend)") },
        { id: "commitStagedAmend", label: t("Commit Staged (Amend)") },
        { id: "commitAllAmend", label: t("Commit All (Amend)") },
      ],
    },
    {
      label: t("Changes"),
      submenu: [
        { id: "stageAll", label: t("Stage All Changes") },
        { id: "unstageAll", label: t("Unstage All Changes") },
        { id: "discardAll", label: t("Discard All Changes") },
      ],
    },
    sep,
    {
      label: t("Pull, Push"),
      submenu: [
        { id: "git.sync", label: t("Sync") },
        { id: "git.syncRebase", label: t("Sync (Rebase)") },
        sep,
        { id: "git.pull", label: t("Pull") },
        { id: "git.pullRebase", label: t("Pull (Rebase)") },
        { id: "git.pullFrom", label: t("Pull from...") },
        sep,
        { id: "git.push", label: t("Push") },
        { id: "git.pushTo", label: t("Push to...") },
        { id: "git.pushTags", label: t("Push Tags") },
        sep,
        { id: "git.fetch", label: t("Fetch") },
        { id: "git.fetchPrune", label: t("Fetch (Prune)") },
        { id: "git.fetchAll", label: t("Fetch From All Remotes") },
      ],
    },
    {
      label: t("Branch"),
      submenu: [
        { id: "git.branch", label: t("Create Branch...") },
        { id: "git.branchFrom", label: t("Create Branch from...") },
        sep,
        { id: "git.renameBranch", label: t("Rename Branch...") },
        { id: "git.deleteBranch", label: t("Delete Branch...") },
        sep,
        { id: "git.merge", label: t("Merge Branch...") },
        { id: "git.rebase", label: t("Rebase Branch...") },
        sep,
        { id: "git.publish", label: t("Publish Branch...") },
      ],
    },
    {
      label: t("Stash"),
      submenu: [
        { id: "git.stash", label: t("Stash") },
        { id: "git.stashIncludeUntracked", label: t("Stash (Include Untracked)") },
        sep,
        { id: "git.stashApplyLatest", label: t("Apply Latest Stash") },
        { id: "git.stashApply", label: t("Apply Stash...") },
        sep,
        { id: "git.stashPopLatest", label: t("Pop Latest Stash") },
        { id: "git.stashPop", label: t("Pop Stash...") },
        sep,
        { id: "git.stashDrop", label: t("Drop Stash...") },
        { id: "git.stashDropAll", label: t("Drop All Stashes...") },
      ],
    },
    {
      label: t("Remote"),
      submenu: [
        { id: "configureRemoteBranch", label: t("Set Remote Branch...") },
        sep,
        { id: "git.addRemote", label: t("Add Remote...") },
        { id: "git.removeRemote", label: t("Remove Remote...") },
      ],
    },
    {
      label: t("Tags"),
      submenu: [
        { id: "git.createTag", label: t("Create Tag...") },
        { id: "git.deleteTag", label: t("Delete Tag...") },
      ],
    },
    sep,
    { id: "git.showOutput", label: t("Show Git Output") },
    sep,
    { id: "git.clone", label: t("Clone...") },
    { id: "git.init", label: t("Initialize Repository...") },
  ];
}

/**
 * 커밋 버튼 캐럿(▼) 드롭다운 메뉴를 만든다(라벨 지역화).
 * - 커밋 변형 + 스테이징/버리기 + Stash 를 커밋 시점에서 바로 쓰도록 모았다.
 * - 모든 ID 는 미트볼 메뉴에도 있어 화이트리스트로 함께 검증된다.
 */
export function buildCommitMenu(): MenuNode[] {
  const t = vscode.l10n.t;
  const sep: MenuNode = { separator: true };
  return [
    { id: "commit", label: t("Commit") },
    { id: "commitStaged", label: t("Commit Staged") },
    { id: "commitAll", label: t("Commit All") },
    { id: "commitAmend", label: t("Commit (Amend)") },
    sep,
    { id: "stageAll", label: t("Stage All Changes") },
    { id: "unstageAll", label: t("Unstage All Changes") },
    { id: "discardAll", label: t("Discard All Changes") },
    sep,
    { id: "git.stash", label: t("Stash") },
    { id: "git.stashIncludeUntracked", label: t("Stash (Include Untracked)") },
    { id: "git.stashPopLatest", label: t("Pop Latest Stash") },
  ];
}

/** 메뉴 트리에서 모든 리프 액션 ID 를 모은다(실행 화이트리스트용, 메모이즈). */
let allowedIds: Set<string> | undefined;
function collectIds(): Set<string> {
  if (allowedIds) {
    return allowedIds;
  }
  const ids = new Set<string>();
  const walk = (nodes: MenuNode[]): void => {
    for (const n of nodes) {
      if (n.id) {
        ids.add(n.id);
      }
      if (n.submenu) {
        walk(n.submenu);
      }
    }
  };
  walk(buildScmMenu());
  walk(buildCommitMenu());
  allowedIds = ids;
  return ids;
}

/**
 * 미트볼 메뉴에서 고른 액션을 실행한다.
 * - 화이트리스트(메뉴에 실제 존재하는 ID)만 실행해 임의 명령 실행을 막는다.
 * - "git." 으로 시작하면 내장 Git 확장 명령에 위임하고, 그 외는 직접 처리한다.
 * @param deps   공유 의존성
 * @param action 메뉴 리프의 액션 ID
 */
export async function runScmAction(
  deps: CommandDeps,
  action: string
): Promise<void> {
  if (!action || !collectIds().has(action)) {
    return;
  }

  if (action === "git.push") {
    await pushCurrentBranch(deps);
    return;
  }

  if (action.startsWith("git.")) {
    try {
      await vscode.commands.executeCommand(action);
    } catch {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Could not run '{0}'. The built-in Git extension is required.",
          action
        )
      );
      return;
    }
    // 위임 명령이 작업트리/스테이징/stash/ref 를 바꿨을 수 있으니 전체를 갱신한다.
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
    return;
  }

  switch (action) {
    case "viewTree":
      deps.changesView.setViewMode("changes", "tree");
      syncViewContext(deps);
      break;
    case "viewList":
      deps.changesView.setViewMode("changes", "list");
      syncViewContext(deps);
      break;
    case "sortName":
      deps.changesView.setSortKey("name");
      break;
    case "sortPath":
      deps.changesView.setSortKey("path");
      break;
    case "sortStatus":
      deps.changesView.setSortKey("status");
      break;
    case "stageAll":
      await stageChanges(deps);
      break;
    case "unstageAll":
      await unstageChanges(deps);
      break;
    case "discardAll":
      await discardChanges(deps);
      break;
    case "commit":
      await commitChanges(deps, "commit");
      break;
    case "commitStaged":
      await commitChanges(deps, "staged");
      break;
    case "commitAll":
      await commitChanges(deps, "all");
      break;
    case "commitAmend":
      await commitChanges(deps, "amend");
      break;
    case "commitStagedAmend":
      await commitChanges(deps, "amendStaged");
      break;
    case "commitAllAmend":
      await commitChanges(deps, "amendAll");
      break;
    case "configureRemoteBranch":
      await vscode.commands.executeCommand("gitSimpleCompare.configureRemoteBranch");
      break;
  }
}

/**
 * Changes 메뉴의 일반 Push 를 실행한다.
 * - force push 는 제공하지 않고, non-fast-forward 거절이면 안내만 보여준다.
 * @param deps 공유 의존성(활성 저장소 탐지/Changes view 갱신)
 */
async function pushCurrentBranch(deps: CommandDeps): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }
  const logService = new GitLogService(service.repoRoot);
  const plan = await getCurrentPushPlan(service.repoRoot);
  if (!(await confirmPushCurrentPlan(plan))) {
    logInfo("scm push canceled", {
      repoRoot: service.repoRoot,
      mode: plan.mode,
      branch: plan.branch,
      remote: plan.remote,
      upstream: plan.upstream,
      targetUpstream: plan.mode === "setUpstream" ? plan.targetUpstream : undefined,
      reason: plan.mode === "setUpstream" ? plan.reason : undefined,
    });
    return;
  }
  try {
    logInfo("scm push started", {
      repoRoot: service.repoRoot,
      mode: plan.mode,
      branch: plan.branch,
      remote: plan.remote,
      upstream: plan.upstream,
      targetUpstream: plan.mode === "setUpstream" ? plan.targetUpstream : undefined,
      reason: plan.mode === "setUpstream" ? plan.reason : undefined,
    });
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Pushing..."),
      },
      () => logService.pushCurrent(plan)
    );
    logInfo("scm push completed", {
      repoRoot: service.repoRoot,
      mode: result.mode,
      branch: result.branch,
      remote: result.remote,
      upstream: result.upstream,
      targetUpstream:
        result.mode === "setUpstream" ? result.targetUpstream : undefined,
      reason: result.mode === "setUpstream" ? result.reason : undefined,
    });
  } catch (err) {
    if (isForcePushRequiredError(err)) {
      await showForcePushRequiredMessage(err);
      return;
    }
    vscode.window.showErrorMessage(
      vscode.l10n.t("Push failed: {0}", gitErrorText(err))
    );
    return;
  }
  vscode.window.showInformationMessage(vscode.l10n.t("Push completed."));
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "push",
  });
}

/**
 * force push 가 필요할 수 있는 push 거절을 안내한다.
 * @param err git push 오류
 */
async function showForcePushRequiredMessage(err: unknown): Promise<void> {
  await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Push was rejected because the remote branch is not a fast-forward update. Git Simple Compare does not provide force push."
    ),
    { modal: true, detail: gitErrorText(err) }
  );
}
