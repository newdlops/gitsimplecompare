// Changes 웹뷰의 PR Stacks 조회/생성/base 변경 명령을 조립하는 모듈.
// - GitHub와 git 명령은 PullRequestStackService에 위임하고 이 파일은 사용자 선택/확인/알림만 담당한다.
import * as vscode from "vscode";
import {
  pullRequestBaseCandidates,
  type PullRequestStacksSnapshot,
  type StackPullRequest,
} from "../git/pullRequestStackModel";
import {
  PullRequestStackService,
  type PullRequestStackBranch,
} from "../git/pullRequestStackService";
import { logError, logInfo } from "../ui/outputLog";
import { discoverRepositories, type CommandDeps } from "./shared";

/** PR stack 행과 command palette가 전달할 최소 컨텍스트 */
export interface PullRequestStackCommandArg {
  /** 작업 대상 git 저장소 루트 */
  repoRoot?: string;
  /** 작업 대상 또는 새 PR의 parent가 될 Pull Request 번호 */
  number?: number;
  /** 브라우저에서 열 GitHub URL */
  url?: string;
  /** 번호 없이 새 PR을 만들 때 미리 지정할 base branch */
  baseBranch?: string;
}

/** 같은 저장소에서 겹친 refresh 중 마지막 결과만 화면에 반영하기 위한 세대 번호 */
const refreshGenerations = new Map<string, number>();

/**
 * 활성 저장소의 열린 PR을 다시 읽고 PR Stacks 섹션 상태를 갱신한다.
 * - 오류도 섹션 상태로 전달해 접힌 섹션을 펼친 자동 조회가 불필요한 toast를 만들지 않게 한다.
 * @param deps 명령 공용 의존성
 * @param requestedRoot 웹뷰 행 등에서 명시한 저장소 루트
 * @returns 성공한 최신 stack 스냅샷, 취소/실패/stale 조회면 undefined
 */
export async function refreshPullRequestStacks(
  deps: CommandDeps,
  requestedRoot?: string
): Promise<PullRequestStacksSnapshot | undefined> {
  const repoRoot = await resolveRepoRoot(deps, requestedRoot);
  if (!repoRoot) {
    return undefined;
  }
  const generation = (refreshGenerations.get(repoRoot) || 0) + 1;
  refreshGenerations.set(repoRoot, generation);
  deps.changesView.setPullRequestStacks({ repoRoot, status: "loading" });
  logInfo("pull request stacks refresh requested", { repoRoot, generation });
  try {
    const snapshot = await new PullRequestStackService(repoRoot).getSnapshot();
    if (refreshGenerations.get(repoRoot) !== generation) {
      logInfo("pull request stacks refresh skipped", {
        repoRoot,
        generation,
        currentGeneration: refreshGenerations.get(repoRoot),
        reason: "stale-generation",
      });
      return undefined;
    }
    deps.changesView.setPullRequestStacks({
      repoRoot,
      status: "ready",
      snapshot,
    });
    logInfo("pull request stacks refreshed", {
      repoRoot,
      repository: snapshot.repository,
      pullRequests: snapshot.pullRequests.length,
      stacks: snapshot.stacks.length,
    });
    return snapshot;
  } catch (error) {
    if (refreshGenerations.get(repoRoot) !== generation) {
      return undefined;
    }
    const message = errorText(error);
    deps.changesView.setPullRequestStacks({
      repoRoot,
      status: "error",
      error: message,
    });
    logError("pull request stacks refresh failed", error, { repoRoot, generation });
    return undefined;
  }
}

/**
 * PR Stacks 행의 URL을 기본 브라우저에서 연다.
 * @param deps 명령 공용 의존성
 * @param arg 저장소/PR 번호/URL 컨텍스트
 */
export async function openStackPullRequest(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  let url = arg?.url?.trim();
  if (!url && arg?.number) {
    const snapshot = await snapshotForCommand(deps, arg.repoRoot);
    url = snapshot?.pullRequests.find((pr) => pr.number === arg.number)?.url;
  }
  if (!url) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Pull request URL is not available.")
    );
    return;
  }
  logInfo("stack pull request open requested", {
    repoRoot: arg?.repoRoot,
    number: arg?.number,
    url,
  });
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * 선택한 PR의 base branch를 다른 PR head 또는 root branch로 변경한다.
 * - 자기 자신/하위 PR head는 순환 스택을 만들므로 순수 모델이 후보에서 제외한다.
 * @param deps 명령 공용 의존성
 * @param arg 저장소와 대상 PR 번호
 */
export async function changeStackPullRequestBase(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const snapshot = await snapshotForCommand(deps, arg?.repoRoot);
  if (!snapshot) {
    showStackLoadError();
    return;
  }
  const pr = await resolvePullRequest(snapshot, arg?.number);
  if (!pr) {
    return;
  }
  const candidates = pullRequestBaseCandidates(snapshot, pr.number);
  const selected = await vscode.window.showQuickPick(
    candidates.map((branch) => baseBranchPick(snapshot, pr, branch)),
    {
      placeHolder: vscode.l10n.t("Select the new base for PR #{0}", pr.number),
      title: vscode.l10n.t("Change Stack Parent"),
    }
  );
  if (!selected || selected.branch === pr.baseRefName) {
    return;
  }
  const action = vscode.l10n.t("Change Base");
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Change PR #{0} base from '{1}' to '{2}'? This rewires the pull request stack on GitHub.",
      pr.number,
      pr.baseRefName,
      selected.branch
    ),
    { modal: true },
    action
  );
  if (confirmed !== action) {
    return;
  }
  const repoRoot = arg?.repoRoot || deps.changesView.getActiveRepo();
  if (!repoRoot) {
    return;
  }
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Changing PR #{0} base...", pr.number),
      },
      () => new PullRequestStackService(repoRoot).changeBase(pr.number, selected.branch)
    );
    logInfo("pull request stack base changed", {
      repoRoot,
      number: pr.number,
      previousBase: pr.baseRefName,
      base: selected.branch,
    });
    await refreshPullRequestStacks(deps, repoRoot);
    vscode.window.showInformationMessage(
      vscode.l10n.t("PR #{0} now targets '{1}'.", pr.number, selected.branch)
    );
  } catch (error) {
    showStackMutationError("pull request stack base change failed", error, {
      repoRoot,
      number: pr.number,
      base: selected.branch,
    });
  }
}

/**
 * 로컬 branch를 게시하고 선택한 base 위에 새 stacked Pull Request를 만든다.
 * - parent PR 행에서 시작하면 그 PR의 head를 base로 고정하고, 헤더에서 시작하면 base를 먼저 고른다.
 * @param deps 명령 공용 의존성
 * @param arg 선택 저장소, parent PR 번호 또는 명시 base
 */
export async function createStackPullRequest(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const snapshot = await snapshotForCommand(deps, arg?.repoRoot);
  if (!snapshot) {
    showStackLoadError();
    return;
  }
  const repoRoot = arg?.repoRoot || deps.changesView.getActiveRepo();
  if (!repoRoot) {
    return;
  }
  const parent = arg?.number
    ? snapshot.pullRequests.find((pr) => pr.number === arg.number)
    : undefined;
  if (arg?.number && !parent) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Pull request #{0} is not loaded.", arg.number)
    );
    return;
  }
  const baseBranch = parent?.headRefName
    || arg?.baseBranch
    || await pickCreateBase(snapshot);
  if (!baseBranch) {
    return;
  }
  const service = new PullRequestStackService(repoRoot);
  const source = await pickSourceBranch(service, snapshot, baseBranch);
  if (!source) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create Stack Pull Request"),
    prompt: vscode.l10n.t("Pull request title"),
    value: source.subject || source.name,
    validateInput: (value) => value.trim()
      ? undefined
      : vscode.l10n.t("A pull request title is required."),
  });
  if (title === undefined) {
    return;
  }
  const body = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create Stack Pull Request"),
    prompt: vscode.l10n.t("Short description (optional; edit on GitHub for multiline text)"),
    value: parent ? vscode.l10n.t("Stacked on #{0}.", parent.number) : "",
  });
  if (body === undefined) {
    return;
  }
  const visibility = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t("$(git-pull-request-draft) Create as Draft"),
        description: vscode.l10n.t("recommended while lower PRs are under review"),
        draft: true,
      },
      {
        label: vscode.l10n.t("$(git-pull-request) Create as Ready for Review"),
        draft: false,
      },
    ],
    { title: vscode.l10n.t("Create Stack Pull Request") }
  );
  if (!visibility) {
    return;
  }
  const publication = await publicationPlan(service, source);
  if (!publication) {
    return;
  }
  if (publication.headBranch === baseBranch) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("The head and base branch must be different.")
    );
    return;
  }
  const createLabel = vscode.l10n.t("Create Pull Request");
  const publishDetail = publication.publishRemote
    ? vscode.l10n.t(" The branch will first be pushed to '{0}'.", publication.publishRemote)
    : "";
  const confirmed = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Create a pull request from '{0}' into '{1}'?{2}",
      publication.headBranch,
      baseBranch,
      publishDetail
    ),
    { modal: true },
    createLabel
  );
  if (confirmed !== createLabel) {
    return;
  }
  try {
    const url = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Creating stack pull request..."),
      },
      async () => {
        if (publication.publishRemote) {
          await service.publishBranch(
            source.name,
            publication.publishRemote,
            publication.headBranch
          );
        }
        return service.createPullRequest({
          headBranch: publication.headBranch,
          baseBranch,
          title,
          body,
          draft: visibility.draft,
        });
      }
    );
    logInfo("stack pull request created", {
      repoRoot,
      repository: snapshot.repository,
      head: publication.headBranch,
      base: baseBranch,
      draft: visibility.draft,
      url,
    });
    await refreshPullRequestStacks(deps, repoRoot);
    const open = vscode.l10n.t("Open Pull Request");
    const picked = await vscode.window.showInformationMessage(
      vscode.l10n.t("Stack pull request created: {0} → {1}", publication.headBranch, baseBranch),
      open
    );
    if (picked === open && url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  } catch (error) {
    showStackMutationError("stack pull request creation failed", error, {
      repoRoot,
      head: publication.headBranch,
      base: baseBranch,
    });
  }
}

/**
 * 명령에 사용할 저장소 root를 명시 인자, 활성 저장소, workspace 선택 순서로 결정한다.
 * @param deps 명령 공용 의존성
 * @param requestedRoot 호출부가 전달한 저장소 root
 * @returns 선택된 root, 저장소가 없거나 사용자가 취소하면 undefined
 */
async function resolveRepoRoot(
  deps: CommandDeps,
  requestedRoot?: string
): Promise<string | undefined> {
  if (requestedRoot) {
    return requestedRoot;
  }
  const active = deps.changesView.getActiveRepo();
  if (active) {
    return active;
  }
  const repositories = await discoverRepositories(deps.registry);
  if (repositories.length === 1) {
    return repositories[0].root;
  }
  const selected = await vscode.window.showQuickPick(
    repositories.map((repo) => ({ label: repo.root, repoRoot: repo.root })),
    { placeHolder: vscode.l10n.t("Select a repository for PR stack action") }
  );
  return selected?.repoRoot;
}

/**
 * 현재 provider snapshot이 같은 저장소의 성공 상태면 재사용하고 아니면 새로 읽는다.
 * @param deps 명령 공용 의존성
 * @param requestedRoot 호출부가 지정한 저장소 root
 * @returns 명령에 사용할 최신 snapshot
 */
async function snapshotForCommand(
  deps: CommandDeps,
  requestedRoot?: string
): Promise<PullRequestStacksSnapshot | undefined> {
  const repoRoot = await resolveRepoRoot(deps, requestedRoot);
  if (!repoRoot) {
    return undefined;
  }
  const current = deps.changesView.getPullRequestStacks();
  if (current.repoRoot === repoRoot && current.status === "ready" && current.snapshot) {
    return current.snapshot;
  }
  return refreshPullRequestStacks(deps, repoRoot);
}

/**
 * 번호가 주어지면 해당 PR을, 없으면 사용자에게 열린 PR을 선택받는다.
 * @param snapshot 현재 PR stack 스냅샷
 * @param number 선택적으로 전달된 PR 번호
 * @returns 선택한 PR 또는 취소 시 undefined
 */
async function resolvePullRequest(
  snapshot: PullRequestStacksSnapshot,
  number?: number
): Promise<StackPullRequest | undefined> {
  if (number) {
    const found = snapshot.pullRequests.find((pr) => pr.number === number);
    if (!found) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("Pull request #{0} is not loaded.", number)
      );
    }
    return found;
  }
  const selected = await vscode.window.showQuickPick(
    snapshot.pullRequests.map((pr) => ({
      label: `#${pr.number} ${pr.title}`,
      description: `${pr.baseRefName} ← ${pr.headRefName}`,
      pr,
    })),
    { placeHolder: vscode.l10n.t("Select a pull request") }
  );
  return selected?.pr;
}

/**
 * base 후보 한 건을 현재값/연결 PR 설명이 포함된 QuickPick 항목으로 변환한다.
 * @param snapshot 현재 PR stack 스냅샷
 * @param target 변경 대상 PR
 * @param branch 후보 branch 이름
 * @returns branch 필드를 보존한 QuickPick 항목
 */
function baseBranchPick(
  snapshot: PullRequestStacksSnapshot,
  target: StackPullRequest,
  branch: string
): vscode.QuickPickItem & { branch: string } {
  const parent = snapshot.pullRequests.find((pr) => pr.headRefName === branch);
  return {
    label: `$(git-branch) ${branch}`,
    description: branch === target.baseRefName
      ? vscode.l10n.t("current base")
      : parent
        ? vscode.l10n.t("PR #{0}", parent.number)
        : branch === snapshot.defaultBranch
          ? vscode.l10n.t("default branch")
          : undefined,
    detail: parent?.title,
    branch,
  };
}

/**
 * 헤더에서 새 PR 생성을 시작했을 때 base branch를 선택받는다.
 * @param snapshot 현재 PR stack 스냅샷
 * @returns 선택한 base branch 또는 취소 시 undefined
 */
async function pickCreateBase(
  snapshot: PullRequestStacksSnapshot
): Promise<string | undefined> {
  const branches = Array.from(new Set([
    snapshot.defaultBranch,
    ...snapshot.pullRequests
      .filter((pr) => !pr.isCrossRepository)
      .map((pr) => pr.headRefName),
    ...snapshot.pullRequests.map((pr) => pr.baseRefName),
  ].filter((branch): branch is string => Boolean(branch))));
  const selected = await vscode.window.showQuickPick(
    branches.map((branch) => baseBranchPick(
      snapshot,
      { number: 0, title: "", url: "", headRefName: "", baseRefName: "", author: "", isDraft: false },
      branch
    )),
    {
      title: vscode.l10n.t("Create Stack Pull Request"),
      placeHolder: vscode.l10n.t("Select the base or parent PR branch"),
    }
  );
  return selected?.branch;
}

/**
 * 이미 열린 PR의 head와 겹치지 않는 로컬 source branch를 선택받는다.
 * @param service 로컬 branch 조회 서비스
 * @param snapshot 현재 열린 PR snapshot
 * @param baseBranch 선택된 base branch
 * @returns 선택한 로컬 branch 또는 취소 시 undefined
 */
async function pickSourceBranch(
  service: PullRequestStackService,
  snapshot: PullRequestStacksSnapshot,
  baseBranch: string
): Promise<PullRequestStackBranch | undefined> {
  const existingHeads = new Set(
    snapshot.pullRequests
      .filter((pr) => !pr.isCrossRepository)
      .map((pr) => pr.headRefName)
  );
  const branches = (await service.listLocalBranches()).filter((branch) => {
    const publishedName = branch.remoteBranch || branch.name;
    return branch.name !== baseBranch
      && publishedName !== baseBranch
      && !existingHeads.has(branch.name)
      && !existingHeads.has(publishedName);
  });
  if (!branches.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No local branch is available for a new stack pull request.")
    );
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(
    branches.map((branch) => ({
      label: `${branch.current ? "$(check)" : "$(git-branch)"} ${branch.name}`,
      description: branch.upstream
        ? vscode.l10n.t("published as {0}", branch.upstream)
        : vscode.l10n.t("not published"),
      detail: branch.subject,
      branch,
    })),
    {
      title: vscode.l10n.t("Create Stack Pull Request"),
      placeHolder: vscode.l10n.t("Select the local head branch"),
    }
  );
  return selected?.branch;
}

/**
 * source branch의 기존 upstream을 재사용하거나 새로 게시할 remote를 선택한다.
 * - 기존 upstream도 PR 생성 직전에 일반 push해 로컬 tip과 원격 head가 일치하도록 계획한다.
 * @param service remote 조회 서비스
 * @param source 선택한 로컬 branch
 * @returns PR head와 선택적 publish remote 계획
 */
async function publicationPlan(
  service: PullRequestStackService,
  source: PullRequestStackBranch
): Promise<{ headBranch: string; publishRemote?: string } | undefined> {
  if (source.remoteBranch && source.remote) {
    return {
      headBranch: source.remoteBranch,
      publishRemote: source.remote,
    };
  }
  const remotes = await service.listRemotes();
  if (!remotes.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Add a Git remote before creating a pull request.")
    );
    return undefined;
  }
  if (remotes.length === 1) {
    return { headBranch: source.name, publishRemote: remotes[0] };
  }
  const selected = await vscode.window.showQuickPick(
    remotes.map((remote) => ({ label: `$(cloud-upload) ${remote}`, remote })),
    {
      title: vscode.l10n.t("Publish Branch"),
      placeHolder: vscode.l10n.t("Select the GitHub remote for '{0}'", source.name),
    }
  );
  return selected
    ? { headBranch: source.name, publishRemote: selected.remote }
    : undefined;
}

/** PR stack 데이터를 읽지 못했을 때 명령 공통 경고를 표시한다. */
function showStackLoadError(): void {
  vscode.window.showWarningMessage(
    vscode.l10n.t("Pull request stacks are unavailable. Refresh the section and check the output log.")
  );
}

/**
 * GitHub 변경 실패를 OUTPUT에 상세히 남기고 사용자에게 짧은 오류를 표시한다.
 * @param event OUTPUT 로그 event 이름
 * @param error 원본 오류
 * @param context PR 번호/base/head 같은 재현 컨텍스트
 */
function showStackMutationError(
  event: string,
  error: unknown,
  context: Record<string, unknown>
): void {
  logError(event, error, context);
  vscode.window.showErrorMessage(
    vscode.l10n.t("PR stack action failed: {0}", errorText(error))
  );
}

/** unknown 오류를 사용자 표시용 문자열로 변환한다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
