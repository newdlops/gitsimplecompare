// git graph 의 PR 단위 작업 UI와 실행 흐름을 담당한다.
// - graphActions.ts 는 메시지 라우팅만 맡고, PR squash/rebase/undo 흐름은 이 파일로 분리한다.
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { GitError } from "../git/gitExec";
import { PullRequestOperationService } from "../git/pullRequestOperationService";
import type { PullRequestOperationOptions, PullRequestOperationResult } from "../git/pullRequestOperationService";
import type { PullRequestInfo } from "../git/pullRequestService";
import { logError, logInfo } from "../ui/outputLog";

export type PullRequestActionKind =
  | "squash"
  | "rebase"
  | "squashRevert"
  | "rebaseRevert"
  | "squashWorktree"
  | "rebaseWorktree"
  | "squashRevertWorktree"
  | "rebaseRevertWorktree"
  | "undo";

type PullRequestBaseAction = "squash" | "rebase" | "squashRevert" | "rebaseRevert";

export interface GraphPullRequestActionDeps {
  logService: GitLogService;
  pullRequests: () => PullRequestInfo[];
  refreshGraph: () => Promise<void>;
}

interface PullRequestActionPick extends vscode.QuickPickItem {
  action: PullRequestActionKind;
}

/**
 * PR chip/detail 에서 사용할 PR 단위 git action 메뉴를 처리한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param number 작업 대상 PR 번호
 * @param action 웹뷰에서 바로 지정한 action. 없으면 QuickPick 으로 고른다.
 */
export async function handlePullRequestAction(
  deps: GraphPullRequestActionDeps,
  number: number,
  action?: PullRequestActionKind
): Promise<void> {
  const pr = deps.pullRequests().find((item) => item.number === number);
  const selected = action ?? (await pickPullRequestAction(number, pr));
  if (!selected) {
    return;
  }
  if (selected === "undo") {
    await undoPullRequestOperation(deps);
    return;
  }
  if (!pr) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Pull request #{0} is not loaded yet.", number)
    );
    return;
  }
  const baseAction = basePullRequestAction(selected);
  const options = operationOptionsForAction(selected);
  if (baseAction === "squash") {
    await squashPullRequest(deps, pr, options);
  } else if (baseAction === "squashRevert") {
    await squashRevertPullRequest(deps, pr, options);
  } else if (baseAction === "rebaseRevert") {
    await rebaseRevertPullRequest(deps, pr, options);
  } else {
    await rebasePullRequest(deps, pr, options);
  }
}

/**
 * PR 작업 QuickPick 항목을 구성하고 사용자가 고른 action 을 반환한다.
 * @param number 작업 대상 PR 번호
 * @param pr 이미 로드된 PR 정보. 없으면 번호만 표시한다.
 * @returns 사용자가 선택한 PR 작업 종류
 */
async function pickPullRequestAction(
  number: number,
  pr?: PullRequestInfo
): Promise<PullRequestActionKind | undefined> {
  const title = pr?.title ? `#${number} ${pr.title}` : `#${number}`;
  const picks: PullRequestActionPick[] = [
    {
      label: vscode.l10n.t("$(git-commit) Squash cherry-pick PR"),
      description: vscode.l10n.t("one commit on current branch"),
      detail: vscode.l10n.t("Apply all PR commits as a single squash commit."),
      action: "squash",
    },
    {
      label: vscode.l10n.t("$(git-commit) Squash cherry-pick PR using Temporary Worktree"),
      description: vscode.l10n.t("one commit, isolate replay"),
      detail: vscode.l10n.t("Replay the PR in a temporary worktree, then apply the result to the current branch."),
      action: "squashWorktree",
    },
    {
      label: vscode.l10n.t("$(git-pull-request) Rebase PR into current branch"),
      description: vscode.l10n.t("preserve commits"),
      detail: vscode.l10n.t("Replay PR commits onto the current branch, then fast-forward the current branch."),
      action: "rebase",
    },
    {
      label: vscode.l10n.t("$(git-pull-request) Rebase PR using Temporary Worktree"),
      description: vscode.l10n.t("preserve commits, isolate replay"),
      detail: vscode.l10n.t("Replay PR commits in a temporary worktree, then apply the resulting HEAD to the current branch."),
      action: "rebaseWorktree",
    },
    {
      label: vscode.l10n.t("$(discard) Squash revert PR"),
      description: vscode.l10n.t("one revert commit"),
      detail: vscode.l10n.t("Revert the PR commits on the current branch as one commit."),
      action: "squashRevert",
    },
    {
      label: vscode.l10n.t("$(discard) Squash revert PR using Temporary Worktree"),
      description: vscode.l10n.t("one revert commit, isolate replay"),
      detail: vscode.l10n.t("Build the squash revert in a temporary worktree, then apply the result to the current branch."),
      action: "squashRevertWorktree",
    },
    {
      label: vscode.l10n.t("$(debug-reverse-continue) Rebase revert PR"),
      description: vscode.l10n.t("one revert per commit"),
      detail: vscode.l10n.t("Revert the PR commits on the current branch, preserving commit granularity."),
      action: "rebaseRevert",
    },
    {
      label: vscode.l10n.t("$(debug-reverse-continue) Rebase revert PR using Temporary Worktree"),
      description: vscode.l10n.t("one revert per commit, isolate replay"),
      detail: vscode.l10n.t("Build per-commit reverts in a temporary worktree, then apply the result to the current branch."),
      action: "rebaseRevertWorktree",
    },
    {
      label: vscode.l10n.t("$(discard) Undo last PR operation"),
      description: vscode.l10n.t("reset to saved snapshot"),
      detail: vscode.l10n.t("Undo the last PR apply or revert operation on the current branch."),
      action: "undo",
    },
  ];
  return (await vscode.window.showQuickPick(picks, { placeHolder: title }))?.action;
}

/** worktree variant 를 실제 PR operation 종류로 정규화한다. */
function basePullRequestAction(action: Exclude<PullRequestActionKind, "undo">): PullRequestBaseAction {
  switch (action) {
    case "squashWorktree":
      return "squash";
    case "rebaseWorktree":
      return "rebase";
    case "squashRevertWorktree":
      return "squashRevert";
    case "rebaseRevertWorktree":
      return "rebaseRevert";
    case "squash":
    case "rebase":
    case "squashRevert":
    case "rebaseRevert":
      return action;
  }
}

/** action 이름에서 PR operation 실행 전략을 만든다. */
function operationOptionsForAction(action: Exclude<PullRequestActionKind, "undo">): PullRequestOperationOptions {
  return action.endsWith("Worktree") ? { strategy: "worktree" } : {};
}

/**
 * PR commit 목록을 현재 브랜치에 squash commit 하나로 cherry-pick 한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param pr 작업 대상 PR 정보
 */
async function squashPullRequest(
  deps: GraphPullRequestActionDeps,
  pr: PullRequestInfo,
  options?: PullRequestOperationOptions
): Promise<void> {
  if (!(await confirm(
    vscode.l10n.t("Squash cherry-pick PR #{0} into the current branch?", pr.number),
    vscode.l10n.t("Squash Cherry-pick")
  ))) {
    return;
  }
  await runPullRequestOperation(deps, pr, "squash", () =>
    new PullRequestOperationService(deps.logService.repoRoot).squashCherryPick(pr, options)
  );
}

/**
 * PR commit 을 현재 브랜치 위로 rebase 한 뒤 현재 브랜치로 가져온다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param pr 작업 대상 PR 정보
 */
async function rebasePullRequest(
  deps: GraphPullRequestActionDeps,
  pr: PullRequestInfo,
  options?: PullRequestOperationOptions
): Promise<void> {
  if (!(await confirm(
    vscode.l10n.t(
      "Rebase PR #{0} commits from '{1}' into the current branch? This preserves the PR commits.",
      pr.number,
      pr.headRefName || pr.headHash || "PR head"
    ),
    vscode.l10n.t("Rebase PR")
  ))) {
    return;
  }
  await runPullRequestOperation(deps, pr, "rebase", () =>
    new PullRequestOperationService(deps.logService.repoRoot).rebasePullRequest(pr, options)
  );
}

/**
 * PR commit 목록을 현재 브랜치에서 squash revert commit 하나로 되돌린다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param pr 작업 대상 PR 정보
 */
async function squashRevertPullRequest(
  deps: GraphPullRequestActionDeps,
  pr: PullRequestInfo,
  options?: PullRequestOperationOptions
): Promise<void> {
  const service = new PullRequestOperationService(deps.logService.repoRoot);
  if (!(await confirmPullRequestRevert(service, pr, "squashRevert"))) {
    return;
  }
  await runPullRequestOperation(deps, pr, "squashRevert", () =>
    service.squashRevertPullRequest(pr, options)
  );
}

/**
 * PR commit 목록을 현재 브랜치에서 커밋별 revert commit 으로 되돌린다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param pr 작업 대상 PR 정보
 */
async function rebaseRevertPullRequest(
  deps: GraphPullRequestActionDeps,
  pr: PullRequestInfo,
  options?: PullRequestOperationOptions
): Promise<void> {
  const service = new PullRequestOperationService(deps.logService.repoRoot);
  if (!(await confirmPullRequestRevert(service, pr, "rebaseRevert"))) {
    return;
  }
  await runPullRequestOperation(deps, pr, "rebaseRevert", () =>
    service.rebaseRevertPullRequest(pr, options)
  );
}

/**
 * PR revert 실행 전 위험도를 안내하고 사용자의 확인을 받는다.
 * @param service PR 작업 서비스
 * @param pr 작업 대상 PR 정보
 * @param operation 실행할 revert 종류
 */
async function confirmPullRequestRevert(
  service: PullRequestOperationService,
  pr: PullRequestInfo,
  operation: "squashRevert" | "rebaseRevert"
): Promise<boolean> {
  const label = operation === "squashRevert"
    ? vscode.l10n.t("Squash Revert")
    : vscode.l10n.t("Rebase Revert");
  const outsideCount = await service.countRevertCommitsOutsideCurrentBranch(pr).catch(() => 0);
  if (outsideCount > 0) {
    return confirm(
      vscode.l10n.t(
        "PR #{0} has {1} commit(s) that are not on the current branch. Reverting it will apply inverse patches to this branch and may remove unrelated changes. Continue?",
        pr.number,
        outsideCount
      ),
      label
    );
  }
  return confirm(defaultRevertConfirmMessage(operation, pr), label);
}

/** PR revert 기본 확인 문구를 만든다. */
function defaultRevertConfirmMessage(
  operation: "squashRevert" | "rebaseRevert",
  pr: PullRequestInfo
): string {
  return operation === "squashRevert"
    ? vscode.l10n.t("Squash revert PR #{0} on the current branch?", pr.number)
    : vscode.l10n.t(
        "Rebase revert PR #{0} commits on the current branch? This creates one revert commit per PR commit.",
        pr.number
      );
}

/**
 * PR 작업을 실행하고 성공/실패 양쪽에서 undo 진입점을 제공한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param pr 작업 대상 PR 정보
 * @param operation 실행할 PR 작업 종류
 * @param run 실제 git 작업 함수
 */
async function runPullRequestOperation(
  deps: GraphPullRequestActionDeps,
  pr: PullRequestInfo,
  operation: PullRequestBaseAction,
  run: () => Promise<PullRequestOperationResult>
): Promise<void> {
  try {
    logInfo("pr operation started", { repoRoot: deps.logService.repoRoot, operation, number: pr.number });
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle(operation, pr.number),
        cancellable: false,
      },
      run
    );
    if (result.status === "conflicts") {
      logInfo("pr operation paused for conflicts", {
        repoRoot: deps.logService.repoRoot,
        operation,
        number: pr.number,
        branch: result.branch,
        beforeHead: shortHash(result.beforeHead),
        snapshotRef: result.snapshotRef,
        sourceBranch: result.sourceBranch,
        preservedStashHash: result.preservedStashHash,
      });
      await deps.refreshGraph();
      await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
      await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
      vscode.window.showWarningMessage(conflictMessage(operation, pr.number, result.preservedStashHash));
      return;
    }
    logInfo("pr operation finished", {
      repoRoot: deps.logService.repoRoot,
      operation,
      number: pr.number,
      branch: result.branch,
      beforeHead: shortHash(result.beforeHead),
      afterHead: shortHash(result.afterHead),
      snapshotRef: result.snapshotRef,
      sourceBranch: result.sourceBranch,
    });
    await deps.refreshGraph();
    await offerPullRequestOperationUndo(
      deps,
      successMessage(operation, pr.number, result.branch),
      result.branch
    );
  } catch (err) {
    logError("pr operation failed", err, {
      repoRoot: deps.logService.repoRoot,
      operation,
      number: pr.number,
    });
    const undo = vscode.l10n.t("Undo PR Operation");
    const service = new PullRequestOperationService(deps.logService.repoRoot);
    const undoBranch = undoBranchFromError(err);
    const canUndo = await service.hasUndoSnapshot(undoBranch) || await service.hasUndoSnapshot();
    const message = vscode.l10n.t("PR operation failed: {0}", errText(err));
    const pick = canUndo
      ? await vscode.window.showErrorMessage(message, undo)
      : await vscode.window.showErrorMessage(message);
    if (pick === undo) {
      await undoPullRequestOperation(deps, undoBranch);
    }
  }
}

/** PR 작업 진행 알림 제목을 만든다. */
function progressTitle(operation: PullRequestBaseAction, number: number): string {
  switch (operation) {
    case "squash":
      return vscode.l10n.t("Squash cherry-picking PR #{0}", number);
    case "rebase":
      return vscode.l10n.t("Rebasing PR #{0} into current branch", number);
    case "squashRevert":
      return vscode.l10n.t("Squash reverting PR #{0}", number);
    case "rebaseRevert":
      return vscode.l10n.t("Rebase reverting PR #{0}", number);
  }
}

/** PR 작업 충돌 안내 문구를 만든다. */
function conflictMessage(
  operation: PullRequestBaseAction,
  number: number,
  preservedStashHash?: string
): string {
  if (operation === "squash" || operation === "squashRevert") {
    const action = operation === "squash" ? "squash cherry-pick" : "squash revert";
    return vscode.l10n.t(
      "PR #{0} {1} paused with conflicts. Resolve them in the Conflicts view, then commit the result.",
      number,
      action
    );
  }
  const action = operation === "rebase" ? "rebase" : "rebase revert";
  return preservedStashHash
    ? vscode.l10n.t(
        "PR #{0} {1} paused with conflicts. Resolve them in the Conflicts view, then Continue. Local changes are preserved in stash {2}.",
        number,
        action,
        preservedStashHash
      )
    : vscode.l10n.t(
        "PR #{0} {1} paused with conflicts. Resolve them in the Conflicts view, then Continue.",
        number,
        action
      );
}

/** PR 작업 성공 안내 문구를 만든다. */
function successMessage(
  operation: PullRequestBaseAction,
  number: number,
  branch: string
): string {
  switch (operation) {
    case "squash":
      return vscode.l10n.t("PR #{0} squash cherry-picked on '{1}'.", number, branch);
    case "rebase":
      return vscode.l10n.t("PR #{0} rebased into '{1}'.", number, branch);
    case "squashRevert":
      return vscode.l10n.t("PR #{0} squash reverted on '{1}'.", number, branch);
    case "rebaseRevert":
      return vscode.l10n.t("PR #{0} rebase reverted on '{1}'.", number, branch);
  }
}

/**
 * 성공 안내에서 바로 undo 를 실행할 수 있게 action 버튼을 제공한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param message 사용자에게 보여줄 완료 메시지
 */
async function offerPullRequestOperationUndo(
  deps: GraphPullRequestActionDeps,
  message: string,
  branchName?: string
): Promise<void> {
  const undo = vscode.l10n.t("Undo PR Operation");
  const pick = await vscode.window.showInformationMessage(message, undo);
  if (pick === undo) {
    await undoPullRequestOperation(deps, branchName);
  }
}

/**
 * 지정 브랜치 또는 현재 브랜치에 저장된 PR 작업 snapshot 으로 reset 한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param branchName undo 할 PR 작업 브랜치. 생략하면 현재 브랜치를 사용한다.
 */
async function undoPullRequestOperation(
  deps: GraphPullRequestActionDeps,
  branchName?: string
): Promise<void> {
  const service = new PullRequestOperationService(deps.logService.repoRoot);
  if (!await service.hasUndoSnapshot(branchName)) {
    vscode.window.showWarningMessage(
      branchName
        ? vscode.l10n.t("No PR operation snapshot is available for '{0}'.", branchName)
        : vscode.l10n.t("No PR operation snapshot is available for the current branch.")
    );
    return;
  }
  if (!(await confirm(
    branchName
      ? vscode.l10n.t("Undo the last PR operation on '{0}'? The branch will reset to the saved snapshot.", branchName)
      : vscode.l10n.t("Undo the last PR operation on the current branch? The branch will reset to the saved snapshot."),
    vscode.l10n.t("Undo PR Operation")
  ))) {
    return;
  }
  logInfo("pr operation undo started", { repoRoot: deps.logService.repoRoot });
  const result = await service.undoLastOperation(branchName);
  logInfo("pr operation undo finished", {
    repoRoot: deps.logService.repoRoot,
    branch: result.branch,
    restoredHead: shortHash(result.restoredHead),
  });
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("PR operation undone on '{0}'.", result.branch)
  );
}

/**
 * 확인이 필요한 PR 상태 변경 작업을 모달로 확인한다.
 * @param message 사용자에게 보여줄 확인 문구
 * @param label 확인 버튼 라벨
 * @returns 사용자가 확인 버튼을 눌렀으면 true
 */
async function confirm(message: string, label: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}

/**
 * 긴 커밋 해시를 UI 표시용으로 줄인다.
 * @param hash 전체 commit hash
 * @returns 앞 10자리 commit hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/**
 * 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다.
 * @param err catch 로 받은 알 수 없는 오류 값
 * @returns 사용자 표시용 문자열
 */
function errText(err: unknown): string {
  if (err instanceof GitError) {
    return [err.stderr.trim(), err.stdout.trim(), err.message]
      .filter(Boolean)
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * git 작업 실패 객체에 담긴 undo 대상 브랜치를 읽는다.
 * @param err catch 로 받은 알 수 없는 오류 값
 * @returns 서비스가 지정한 undo 대상 브랜치
 */
function undoBranchFromError(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const branch = (err as { undoBranch?: unknown }).undoBranch;
  return typeof branch === "string" && branch ? branch : undefined;
}
