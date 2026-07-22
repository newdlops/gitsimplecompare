// Pull Request Preview의 게시 대화상자와 진행 상태를 조정하는 UI 컨트롤러.
// - commit/push/GitHub 호출은 git/PullRequestPublishService에 맡기고 이 모듈은 사용자 선택과 결과 표시만 담당한다.
import * as vscode from "vscode";
import {
  PullRequestPublishError,
  PullRequestPublishService,
  type PublishPreviewPullRequestResult,
  type PullRequestPublishContext,
  type PullRequestPublishRemote,
} from "../git/pullRequestPublishService";
import type { PullRequestInfo } from "../git/pullRequestInfo";
import { logError, logInfo } from "../ui/outputLog";

/** 웹뷰가 현재 화면의 PR 게시 입력을 extension에 전달하는 메시지이다. */
export interface PullRequestPreviewPublishMessage {
  type: "publishPullRequest";
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
}

/** stale 게시와 기존 PR 중복을 막기 위해 패널이 제공하는 최신 상태이다. */
export interface PullRequestPreviewPublishState {
  existingPr?: PullRequestInfo;
  lastSourceBranch?: string;
  lastTargetBranch?: string;
}

/** modal 확인에서 선택할 새 Pull Request 공개 상태이다. */
type PullRequestPublishMode = "ready" | "draft";

/** Quick Pick 표시 정보와 선택 뒤 서비스에 전달할 remote 원본을 함께 보존한다. */
interface PullRequestPublishQuickPickItem extends vscode.QuickPickItem {
  remote: PullRequestPublishRemote;
}

/** staged commit 유무에 따라 달라지는 modal action label 묶음이다. */
interface PullRequestPublishActionLabels {
  create: string;
  draft: string;
}

/** Preview 게시의 사용자 확인, 진행 알림, 부분 실패 안내를 관리한다. */
export class PullRequestPreviewPublisher {
  private publishInFlight = false;

  /**
   * @param repoRoot 대상 Git 저장소 루트
   * @param post 웹뷰에 busy 상태를 보내는 콜백
   * @param onPublished 패널의 기존 PR 상태와 Preview를 갱신하는 콜백
   */
  constructor(
    private readonly repoRoot: string,
    private readonly post: (message: unknown) => void,
    private readonly onPublished: (
      result: PublishPreviewPullRequestResult
    ) => Promise<void>
  ) {}

  /**
   * Preview가 보여 주는 staged 변경과 PR 메시지를 commit, 일반 push, GitHub PR 생성으로 게시한다.
   * - staged 변경이 있으면 Preview와 실제 PR이 같아지도록 commit 메시지를 먼저 받고 전체 변경 범위를 확인받는다.
   * - source/target이 마지막 서버 Preview와 달라졌거나 기존 PR이 있으면 원격 변경 전에 중단한다.
   * @param msg 웹뷰가 보낸 현재 source/target/title/body 스냅샷
   * @param state 패널이 마지막으로 보낸 source/target과 기존 PR 상태
   */
  async publish(
    msg: PullRequestPreviewPublishMessage,
    state: PullRequestPreviewPublishState
  ): Promise<void> {
    if (this.publishInFlight) {
      logInfo("PR preview publish skipped: already running", {
        repoRoot: this.repoRoot,
      });
      this.post({ type: "pullRequestPublishState", active: true });
      return;
    }
    try {
      assertCurrentPublishPreview(msg, state);
      const publishService = new PullRequestPublishService(this.repoRoot);
      const context = await publishService.inspect(msg.sourceBranch, msg.targetBranch);
      assertPublishableContext(context);
      const remote = await pickPublishRemote(context);
      if (!remote) return;
      const commitMessage = context.stagedFileCount > 0
        ? await inputPublishCommitMessage(msg.title)
        : undefined;
      if (context.stagedFileCount > 0 && !commitMessage) return;
      const mode = await confirmPublish(context, remote);
      if (!mode) return;

      this.publishInFlight = true;
      this.post({ type: "pullRequestPublishState", active: true });
      logInfo("PR preview publish started", {
        repoRoot: this.repoRoot,
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        remote: remote.name,
        remoteBranch: remote.branch,
        stagedFileCount: context.stagedFileCount,
        draft: mode === "draft",
      });
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Publishing Pull Request to GitHub..."),
          cancellable: false,
        },
        () => publishService.publishPreview({
          sourceBranch: context.sourceBranch,
          targetBranch: msg.targetBranch,
          remote: remote.name,
          title: msg.title,
          body: msg.body,
          draft: mode === "draft",
          commitMessage,
        })
      );
      logInfo("PR preview publish completed", {
        repoRoot: this.repoRoot,
        number: result.pullRequest.number,
        url: result.pullRequest.url,
        remote: result.remote,
        remoteBranch: result.remoteBranch,
        committed: result.committed,
        commitHash: result.commitHash,
      });
      await this.onPublished(result);
      await showPublishCompleted(result);
    } catch (error) {
      logError("PR preview publish failed", error, {
        repoRoot: this.repoRoot,
        sourceBranch: msg.sourceBranch,
        targetBranch: msg.targetBranch,
      });
      vscode.window.showErrorMessage(
        vscode.l10n.t("Pull Request publish failed: {0}", publishErrorText(error))
      );
    } finally {
      this.publishInFlight = false;
      this.post({ type: "pullRequestPublishState", active: false });
    }
  }
}

/** 마지막 extension Preview와 웹뷰의 게시 스냅샷이 같은지 확인해 stale 클릭을 막는다. */
function assertCurrentPublishPreview(
  msg: PullRequestPreviewPublishMessage,
  state: PullRequestPreviewPublishState
): void {
  if (state.existingPr) {
    throw new Error(vscode.l10n.t(
      "A Pull Request already exists for this preview. Open the existing Pull Request instead."
    ));
  }
  if (msg.sourceBranch !== state.lastSourceBranch
    || msg.targetBranch !== state.lastTargetBranch) {
    throw new Error(vscode.l10n.t(
      "The Pull Request preview changed. Refresh it and try publishing again."
    ));
  }
}

/** source branch, staged index, remote처럼 게시에 필수인 로컬 조건을 확인한다. */
function assertPublishableContext(context: PullRequestPublishContext): void {
  if (!context.sourceIsLocal) {
    throw new Error(vscode.l10n.t(
      "Select a local source branch before publishing a Pull Request."
    ));
  }
  if (!context.remotes.length) {
    throw new Error(vscode.l10n.t(
      "Add a Git remote before publishing a Pull Request."
    ));
  }
  if (context.stagedFileCount > 0 && context.currentBranch !== context.sourceBranch) {
    throw new Error(vscode.l10n.t(
      "Staged changes belong to '{0}'. Select it as the source branch before publishing.",
      context.currentBranch
    ));
  }
}

/** remote가 하나면 즉시 사용하고 여러 개면 추천 항목이 표시된 Quick Pick을 연다. */
async function pickPublishRemote(
  context: PullRequestPublishContext
): Promise<PullRequestPublishRemote | undefined> {
  if (context.remotes.length === 1) return context.remotes[0];
  return (await vscode.window.showQuickPick(publishRemoteItems(context), {
    title: vscode.l10n.t("Select Git remote for Pull Request"),
    placeHolder: vscode.l10n.t("The source branch will be pushed to this remote."),
  }))?.remote;
}

/** remote 후보를 push 목적지까지 보이는 Quick Pick 항목으로 바꾼다. */
function publishRemoteItems(
  context: PullRequestPublishContext
): PullRequestPublishQuickPickItem[] {
  return context.remotes.map((remote) => ({
    label: `$(repo-push) ${remote.name}`,
    description: `${context.sourceBranch} → ${remote.name}/${remote.branch}`,
    picked: remote.recommended,
    remote,
  }));
}

/** staged 파일을 Preview 제목과 별도 commit으로 만들 때 사용할 메시지를 입력받는다. */
async function inputPublishCommitMessage(title: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: vscode.l10n.t("Commit staged changes for Pull Request"),
    prompt: vscode.l10n.t(
      "This commit is created before the source branch is pushed. Unstaged changes remain in the working tree."
    ),
    value: title.trim().split(/\r?\n/)[0] || "",
    validateInput: (value) => value.trim()
      ? undefined
      : vscode.l10n.t("Enter a commit message for the staged changes."),
  });
}

/** commit/push/PR 생성 대상과 Draft 여부를 modal 확인으로 확정한다. */
async function confirmPublish(
  context: PullRequestPublishContext,
  remote: PullRequestPublishRemote
): Promise<PullRequestPublishMode | undefined> {
  const actions = publishActionLabels(context.stagedFileCount > 0);
  const choice = await vscode.window.showWarningMessage(
    publishConfirmationQuestion(context.stagedFileCount > 0),
    { modal: true, detail: publishConfirmationDetail(context, remote) },
    actions.create,
    actions.draft
  );
  return choice === actions.create
    ? "ready"
    : choice === actions.draft ? "draft" : undefined;
}

/** staged 파일을 먼저 commit하는지에 맞춰 Ready/Draft action label을 만든다. */
function publishActionLabels(
  commitsStagedChanges: boolean
): PullRequestPublishActionLabels {
  return {
    create: commitsStagedChanges
      ? vscode.l10n.t("Commit & Create Pull Request")
      : vscode.l10n.t("Create Pull Request"),
    draft: commitsStagedChanges
      ? vscode.l10n.t("Commit & Create Draft Pull Request")
      : vscode.l10n.t("Create Draft Pull Request"),
  };
}

/** modal 본문에 source/base/push 목적지와 로컬에 남는 파일을 줄 단위로 설명한다. */
function publishConfirmationDetail(
  context: PullRequestPublishContext,
  remote: PullRequestPublishRemote
): string {
  return [
    vscode.l10n.t("Source: {0}", context.sourceBranch),
    vscode.l10n.t("Target: {0}", context.targetBranch),
    vscode.l10n.t("Push: {0} -> {1}/{2}", context.sourceBranch, remote.name, remote.branch),
    context.stagedFileCount > 0
      ? vscode.l10n.t("Staged files to commit: {0}", context.stagedFileCount)
      : vscode.l10n.t("No new commit will be created."),
    context.unstagedFileCount > 0
      ? vscode.l10n.t("Unstaged files left in the working tree: {0}", context.unstagedFileCount)
      : "",
    vscode.l10n.t("This action never force-pushes."),
  ].filter(Boolean).join("\n");
}

/** staged commit 포함 여부에 맞는 최종 확인 질문을 반환한다. */
function publishConfirmationQuestion(commitsStagedChanges: boolean): string {
  return commitsStagedChanges
    ? vscode.l10n.t("Commit staged changes, push the source branch, and create a GitHub Pull Request?")
    : vscode.l10n.t("Push the source branch and create a GitHub Pull Request?");
}

/** 생성된 PR 번호를 알리고 선택 시 브라우저에서 GitHub URL을 연다. */
async function showPublishCompleted(
  result: PublishPreviewPullRequestResult
): Promise<void> {
  const open = vscode.l10n.t("Open on GitHub");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Pull Request #{0} was created on GitHub.",
      result.pullRequest.number
    ),
    open
  );
  if (choice === open && result.pullRequest.url) {
    await vscode.env.openExternal(vscode.Uri.parse(result.pullRequest.url));
  }
}

/** 게시 중 일부 단계가 끝난 오류에는 사용자가 복구할 수 있도록 남은 로컬/원격 상태를 덧붙인다. */
function publishErrorText(error: unknown): string {
  if (!(error instanceof PullRequestPublishError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.pushed) {
    return vscode.l10n.t(
      "{0} The source branch was pushed, but the Pull Request was not created.",
      error.message
    );
  }
  if (error.committed) {
    return vscode.l10n.t(
      "{0} The staged changes were committed locally, but nothing was pushed.",
      error.message
    );
  }
  return error.message;
}
