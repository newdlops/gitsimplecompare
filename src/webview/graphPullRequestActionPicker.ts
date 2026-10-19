// PR 작업 선택 UI를 실행 조립과 분리하고 기존 네이티브 메뉴 순서와 설명을 유지한다.
import * as vscode from "vscode";
import type { PullRequestInfo } from "../git/pullRequestInfo";

export type PullRequestActionKind = "squash" | "rebase" | "squashRevert" | "rebaseRevert" |
  "squashWorktree" | "rebaseWorktree" | "squashRevertWorktree" | "rebaseRevertWorktree" | "dependencies" | "undo";
interface PullRequestActionPick extends vscode.QuickPickItem { action: PullRequestActionKind }

/**
 * PR 작업 메뉴를 기존 실행 순서로 표시하고 명시적으로 고른 동작만 반환한다.
 * @param number 작업 대상 PR @param pr 이미 읽은 제목과 branch 정보 @returns 취소면 undefined
 */
export async function pickPullRequestAction(number: number, pr?: PullRequestInfo): Promise<PullRequestActionKind | undefined> {
  const picks: PullRequestActionPick[] = [
    {
      label: vscode.l10n.t("$(git-commit) Squash cherry-pick PR"),
      description: vscode.l10n.t("one commit on current branch"),
      detail: vscode.l10n.t("Apply all PR commits as a single squash commit."), action: "squash",
    },
    {
      label: vscode.l10n.t("$(git-commit) Squash cherry-pick PR using Temporary Worktree"),
      description: vscode.l10n.t("one commit, isolate replay"),
      detail: vscode.l10n.t("Replay the PR in a temporary worktree, then apply the result to the current branch."), action: "squashWorktree",
    },
    {
      label: vscode.l10n.t("$(git-pull-request) Rebase PR into current branch"), description: vscode.l10n.t("preserve commits"),
      detail: vscode.l10n.t("Replay PR commits onto the current branch, then fast-forward the current branch."), action: "rebase",
    },
    {
      label: vscode.l10n.t("$(git-pull-request) Rebase PR using Temporary Worktree"),
      description: vscode.l10n.t("preserve commits, isolate replay"),
      detail: vscode.l10n.t("Replay PR commits in a temporary worktree, then apply the resulting HEAD to the current branch."), action: "rebaseWorktree",
    },
    {
      label: vscode.l10n.t("$(discard) Squash revert PR"), description: vscode.l10n.t("one revert commit"),
      detail: vscode.l10n.t("Revert the PR commits on the current branch as one commit."), action: "squashRevert",
    },
    {
      label: vscode.l10n.t("$(discard) Squash revert PR using Temporary Worktree"),
      description: vscode.l10n.t("one revert commit, isolate replay"),
      detail: vscode.l10n.t("Build the squash revert in a temporary worktree, then apply the result to the current branch."), action: "squashRevertWorktree",
    },
    {
      label: vscode.l10n.t("$(debug-reverse-continue) Rebase revert PR"), description: vscode.l10n.t("one revert per commit"),
      detail: vscode.l10n.t("Revert the PR commits on the current branch, preserving commit granularity."), action: "rebaseRevert",
    },
    {
      label: vscode.l10n.t("$(debug-reverse-continue) Rebase revert PR using Temporary Worktree"),
      description: vscode.l10n.t("one revert per commit, isolate replay"),
      detail: vscode.l10n.t("Build per-commit reverts in a temporary worktree, then apply the result to the current branch."), action: "rebaseRevertWorktree",
    },
    {
      label: vscode.l10n.t("$(search) Inspect PR prerequisites"),
      detail: vscode.l10n.t("Find prerequisite PR candidates and simulate their effect without changing the working tree."), action: "dependencies",
    },
    {
      label: vscode.l10n.t("$(discard) Undo last PR operation"), description: vscode.l10n.t("reset to saved snapshot"),
      detail: vscode.l10n.t("Undo the last PR apply or revert operation on the current branch."), action: "undo",
    },
  ];
  return (await vscode.window.showQuickPick(picks, { placeHolder: pr?.title ? `#${number} ${pr.title}` : `#${number}` }))?.action;
}
