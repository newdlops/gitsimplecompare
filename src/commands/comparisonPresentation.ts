// 비교 명령의 VS Code 사용자 상호작용과 diff 표시를 모은 표현 모듈.
// - 도메인 조회/상태 적용은 comparisonDecorations에 남기고 PR 선택, 알림, 포커스,
//   파일 열기처럼 VS Code UI에 직접 닿는 책임만 이 경계에서 처리한다.
import * as vscode from "vscode";
import {
  isSafeComparisonPath,
  type ComparisonService,
  type ComparisonSnapshot,
} from "../git/comparisonService";
import type { PullRequestInfo } from "../git/pullRequestService";
import type { FileChange } from "../git/gitTypes";
import { editorGutterSettingAllowsMarkers } from "../providers/comparisonScmProvider";
import {
  openRefVsRefDiff,
  openRefVsWorkingDiff,
} from "../ui/diffPresenter";
import {
  logInfo,
  logWarn,
  showErrorWithOutput,
} from "../ui/outputLog";
import type { CommandDeps } from "./shared";

/** 비교 완료 후 사용자의 시선을 옮길 뷰. */
export type ComparisonViewFocus = "changes" | "explorer" | "none";

/** openComparisonDiff 명령이 받는 직렬화 가능한 가벼운 인자. */
export interface OpenComparisonDiffArgs {
  /** provider가 전체 snapshot 복제 없이 현재 비교를 찾는 저장소 루트. */
  repoRoot?: string;
  /** provider가 현재 변경 항목을 찾는 저장소 상대 경로. */
  path?: string;
  /** 구버전/직접 호출 호환용 비교 스냅샷. */
  comparison?: ComparisonSnapshot;
  /** 구버전/직접 호출 호환용 파일 변경. */
  change?: FileChange;
}

/**
 * Explorer 전용 트리의 변경 파일을 정확한 ref diff 또는 편집 가능한 작업파일 diff로 연다.
 * - target이 현재 HEAD면 오른쪽 작업파일을 사용하고, 그 외에는 ref↔ref 읽기 전용 diff를 연다.
 * - rename/copy는 왼쪽 base에서 oldPath를 사용해 이전 파일과 새 파일을 매칭한다.
 * @param deps 클릭 시점의 활성 비교를 찾는 controller 의존성
 * @param args provider가 전달한 저장소/경로 키 또는 구형 전체 인자
 */
export async function openComparisonDiff(
  deps: CommandDeps,
  args: OpenComparisonDiffArgs | undefined
): Promise<void> {
  const resolved = resolveComparisonDiffArgs(deps, args);
  if (!resolved) {
    logWarn("comparison diff open skipped", { reason: "missing-arguments" });
    return;
  }
  const { comparison, change } = resolved;
  if (!comparison.diffAvailable) {
    logWarn("comparison diff open skipped", {
      reason: "refs-unavailable",
      kind: comparison.kind,
      repoRoot: comparison.repoRoot,
      baseRef: comparison.baseRef,
      targetRef: comparison.targetRef,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "The comparison files are available, but its Git refs are not present locally. Fetch the pull request or remote branch and refresh the comparison."
      )
    );
    return;
  }

  const leftRelPath =
    change.status === "R" || change.status === "C"
      ? change.oldPath ?? change.path
      : change.path;
  const fileLabel = change.path.slice(change.path.lastIndexOf("/") + 1);
  logInfo("comparison diff open requested", {
    kind: comparison.kind,
    repoRoot: comparison.repoRoot,
    baseRef: comparison.baseRef,
    targetRef: comparison.targetRef,
    path: change.path,
    leftPath: leftRelPath,
  });

  if (comparison.targetMatchesHead && change.status !== "D") {
    const fileUri = vscode.Uri.joinPath(
      vscode.Uri.file(comparison.repoRoot),
      ...change.path.split("/")
    );
    if (await resourceExists(fileUri)) {
      await openRefVsWorkingDiff(
        comparison.repoRoot,
        comparison.baseRef,
        fileUri,
        change.path,
        {
          leftRelPath,
          fileLabel,
          leftLabel: comparison.baseLabel,
          rightLabel: comparison.targetLabel,
        }
      );
      return;
    }
  }
  await openRefVsRefDiff(
    comparison.repoRoot,
    comparison.baseRef,
    comparison.targetRef,
    change.path,
    fileLabel,
    leftRelPath,
    {
      leftLabel: comparison.baseLabel,
      rightLabel: comparison.targetLabel,
    }
  );
}

/**
 * Compare Changes 파일을 일반 작업파일 편집기로 열어 native Quick Diff gutter를 표시한다.
 * - target이 현재 HEAD가 아니거나 삭제/로컬 ref 부재 상태면 줄 좌표가 정확하지 않으므로
 *   기존 ref diff 열기로 안전하게 되돌린다.
 * @param deps 클릭 시점의 활성 비교를 찾는 controller 의존성
 * @param args provider가 전달한 저장소/경로 키 또는 비교 트리 파일 노드
 * @returns 일반 파일 또는 fallback diff를 열었으면 true, 현재 비교를 찾지 못했으면 false
 */
export async function openComparisonFile(
  deps: CommandDeps,
  args: OpenComparisonDiffArgs | undefined
): Promise<boolean> {
  const resolved = resolveComparisonDiffArgs(deps, args);
  if (!resolved) {
    logWarn("comparison working file open skipped", {
      reason: "missing-arguments",
    });
    return false;
  }
  const { comparison, change } = resolved;
  const editable =
    comparison.targetMatchesHead &&
    comparison.diffAvailable &&
    change.status !== "D";
  if (!editable) {
    logInfo("comparison working file fell back to diff", {
      repoRoot: comparison.repoRoot,
      path: change.path,
      status: change.status,
      targetMatchesHead: comparison.targetMatchesHead,
      diffAvailable: comparison.diffAvailable,
    });
    await openComparisonDiff(deps, args);
    return true;
  }

  const fileUri = vscode.Uri.joinPath(
    vscode.Uri.file(comparison.repoRoot),
    ...change.path.split("/")
  );
  if (!(await resourceExists(fileUri))) {
    logInfo("comparison working file fell back to diff", {
      repoRoot: comparison.repoRoot,
      path: change.path,
      reason: "file-missing",
    });
    await openComparisonDiff(deps, args);
    return true;
  }
  try {
    // vscode.open 을 사용하면 텍스트는 Quick Diff gutter가 있는 일반 편집기로,
    // 이미지·바이너리는 각 파일에 맞는 custom editor로 자연스럽게 열린다.
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      preview: false,
    });
    logInfo("comparison working file opened with editor gutter", {
      repoRoot: comparison.repoRoot,
      path: change.path,
      baseRef: comparison.resolvedBaseHash || comparison.baseRef,
      targetRef: comparison.targetRef,
    });
  } catch (error) {
    logWarn("comparison working file open failed; falling back to diff", {
      repoRoot: comparison.repoRoot,
      path: change.path,
      error: error instanceof Error ? error.message : String(error),
    });
    await openComparisonDiff(deps, args);
  }
  return true;
}

/**
 * GitHub PR overview를 불러 사용자에게 번호/제목/브랜치 방향을 보여 준다.
 * @param service PR overview 및 changed-files를 제공하는 비교 서비스
 * @returns 선택한 PR, 취소·오류·빈 목록이면 undefined
 */
export async function pickPullRequest(
  service: ComparisonService
): Promise<PullRequestInfo | undefined> {
  let overview;
  try {
    overview = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: vscode.l10n.t("Loading pull requests..."),
      },
      () => service.listPullRequests()
    );
  } catch (error) {
    reportComparisonError(error, "pullRequest:list", service.repoRoot);
    return undefined;
  }
  if (!overview.available) {
    reportComparisonError(
      new Error(overview.error || "GitHub pull requests are unavailable."),
      "pullRequest:list",
      service.repoRoot
    );
    return undefined;
  }
  if (overview.pullRequests.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No pull requests were found for this repository.")
    );
    logInfo("pull request comparison selection skipped", {
      repoRoot: service.repoRoot,
      reason: "empty",
    });
    return undefined;
  }
  if (overview.hasMore) {
    logWarn("pull request comparison list truncated", {
      repoRoot: service.repoRoot,
      shown: overview.pullRequests.length,
    });
  }

  const picked = await vscode.window.showQuickPick(
    overview.pullRequests.map((pullRequest) => ({
      label: `$(git-pull-request) #${pullRequest.number} ${pullRequest.title}`,
      description: `${pullRequest.baseRefName} ← ${pullRequest.headRefName}`,
      detail: pullRequest.author
        ? vscode.l10n.t("{0} by @{1}", pullRequest.state, pullRequest.author)
        : pullRequest.state,
      pullRequest,
    })),
    {
      title: vscode.l10n.t("Compare Pull Request"),
      placeHolder: vscode.l10n.t("Select a pull request to decorate in Explorer"),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) {
    logInfo("pull request comparison selection cancelled", {
      repoRoot: service.repoRoot,
    });
  }
  return picked?.pullRequest;
}

/**
 * 비교 명령 실패를 OUTPUT에 상세히 남기고 사용자에게 요약과 출력 열기를 제공한다.
 * @param error git/gh/UI 조회에서 발생한 오류
 * @param kind 로그에서 실패 모드를 구분할 문자열
 * @param repoRoot 알고 있는 경우 추가할 저장소 경로
 */
export function reportComparisonError(
  error: unknown,
  kind: string,
  repoRoot?: string
): void {
  const reason = error instanceof Error ? error.message : String(error);
  showErrorWithOutput(
    "comparison command failed",
    error,
    vscode.l10n.t("Unable to update the comparison: {0}", reason),
    { kind, repoRoot }
  );
}

/**
 * 성공한 비교가 비었거나 GitHub API 상한으로 잘렸을 때 명확한 안내를 보여 준다.
 * @param snapshot 파일 수와 truncated 플래그를 포함한 스냅샷
 */
export function notifyComparisonResult(snapshot: ComparisonSnapshot): void {
  if (snapshot.changes.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "{0} ↔ {1}: no changed files.",
        snapshot.baseLabel,
        snapshot.targetLabel
      )
    );
  }
  if (snapshot.truncated) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "GitHub returned a truncated pull request file list. Showing the first {0} files.",
        snapshot.changes.length
      )
    );
  }
  if (snapshot.changes.length === 0) {
    return;
  }
  if (!snapshot.diffAvailable) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Editor gutter markers require both comparison refs to be available locally. Fetch the target ref and refresh the comparison."
      )
    );
    return;
  }
  if (!snapshot.targetMatchesHead) {
    const sourceMatchesHead = Boolean(
      snapshot.kind === "branches" &&
        snapshot.diffBase === "threeDot" &&
        snapshot.resolvedSourceBaseHash &&
        snapshot.resolvedSourceBaseHash === snapshot.resolvedHeadHash
    );
    vscode.window.showInformationMessage(
      sourceMatchesHead
        ? vscode.l10n.t(
            "Three-dot comparison preserves FROM to TO. Choose the current checkout as TO to show editor gutter markers."
          )
        : vscode.l10n.t(
            "Editor gutter markers will appear after the target ({0}) is checked out. Comparison badges and side-by-side Diff remain available.",
            snapshot.targetLabel
          )
    );
    return;
  }
  if (!editorGutterSettingAllowsMarkers()) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "VS Code's scm.diffDecorations setting must be All or Gutter to show comparison markers beside line numbers."
      )
    );
  }
}

/**
 * 스냅샷 적용 후 요청된 뷰를 드러낸다.
 * - 별도 Comparison TreeView가 없으므로 explorer/none은 현재 위치를 유지한다.
 * @param focus Changes 웹뷰를 열거나 현재 포커스를 유지하는 선택값
 */
export async function focusComparisonView(
  focus: ComparisonViewFocus
): Promise<void> {
  if (focus !== "changes") {
    return;
  }
  try {
    await vscode.commands.executeCommand("gitSimpleCompare.changes.focus");
  } catch (error) {
    logWarn("comparison view focus failed", {
      focus,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * provider의 가벼운 repoRoot/path 인자를 현재 controller 스냅샷과 FileChange로 해석한다.
 * @param deps 활성 비교 controller를 포함한 명령 의존성
 * @param args command 호출 인자
 * @returns 검증된 비교/파일 쌍, 현재 선택과 일치하지 않으면 undefined
 */
function resolveComparisonDiffArgs(
  deps: CommandDeps,
  args: OpenComparisonDiffArgs | undefined
): { comparison: ComparisonSnapshot; change: FileChange } | undefined {
  if (
    args?.comparison &&
    args.change &&
    isSafeComparisonPath(args.change.path) &&
    (!args.change.oldPath || isSafeComparisonPath(args.change.oldPath))
  ) {
    return { comparison: args.comparison, change: args.change };
  }
  if (!args?.repoRoot || !args.path || !isSafeComparisonPath(args.path)) {
    return undefined;
  }
  const comparison = deps.comparison.getComparison(false);
  if (!comparison || comparison.repoRoot !== args.repoRoot) {
    return undefined;
  }
  const change = comparison.changes.find((item) => item.path === args.path);
  return change ? { comparison, change } : undefined;
}

/**
 * 비교 대상 작업파일이 실제로 존재하는지 확인한다.
 * @param uri 저장소 안의 작업파일 URI
 * @returns stat에 성공하면 true
 */
async function resourceExists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false
  );
}
