// 편집기 gutter와 Explorer/탭 장식에 표시할 git 비교를 선택·적용하는 명령 조립 모듈.
// - git 조회는 ComparisonService, 상태 보관은 ComparisonController,
//   표시는 provider/ChangesView에 위임해 명령 레이어에 도메인 로직을 두지 않는다.
import * as vscode from "vscode";
import type { ComparisonSnapshot } from "../git/comparisonService";
import type { PullRequestInfo } from "../git/pullRequestService";
import type { BranchComparison } from "../git/gitTypes";
import { logError, logInfo } from "../ui/outputLog";
import {
  CommandDeps,
  createComparisonService,
  readConfig,
  resolveComparisonService,
} from "./shared";
import {
  COMPARISON_VIEW_ID,
  focusComparisonView,
  notifyComparisonResult,
  pickPullRequest,
  reportComparisonError,
} from "./comparisonPresentation";

export {
  openComparisonDiff,
  reportComparisonError,
  type OpenComparisonDiffArgs,
} from "./comparisonPresentation";

/** 편집기 gutter/Explorer 비교 선택기가 제공하는 상위 비교 방식. */
type ExplorerComparisonMode = "branches" | "localRemote" | "pullRequest";

/** 비교 완료 후 사용자의 시선을 옮길 뷰. */
export type ComparisonFocus = "changes" | "explorer" | "none";

/** 비교 스냅샷을 UI 상태에 반영할 때의 정책. */
export interface ComparisonApplyOptions {
  /** OUTPUT 로그에 남겨 어느 명령이 상태를 바꿘는지 식별하는 값. */
  source: string;
  /** 성공 후 포커스할 뷰. 생략하면 Explorer 비교 뷰를 사용한다. */
  focus?: ComparisonFocus;
  /** 빈 결과/PR 잘림 안내를 표시할지 여부. 기본값은 true. */
  notify?: boolean;
  /** 비활성 상태였던 Explorer 장식을 함께 켤지 여부. 기본값은 true. */
  reveal?: boolean;
  /** controller 스냅샷까지 바꿀지 여부. 기본값은 true. */
  syncController?: boolean;
}

/** 진행 표시와 오류 보고까지 포함한 비교 실행 옵션. */
export interface ComparisonRunOptions extends ComparisonApplyOptions {
  /** VS Code 진행 표시에 보여 줄 짧은 작업명. */
  progressTitle: string;
  /** 오류 로그와 사용자 알림에 쓸 비교 종류. */
  kind: string;
}

/**
 * 편집기 gutter와 Explorer에 적용할 비교 방식(브랜치/현재-upstream/PR)을 먼저 고르게 한다.
 * - 브랜치 모드는 기존 명령을 Explorer 포커스 인수로 재사용해
 *   브랜치 picker 규칙이 두 곳으로 나뉘지 않게 한다.
 * @param deps 비교 서비스·controller·Changes 뷰를 포함한 명령 의존성
 */
export async function selectExplorerComparison(
  deps: CommandDeps
): Promise<void> {
  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { mode: ExplorerComparisonMode }
  >(
    [
      {
        label: `$(git-branch) ${vscode.l10n.t("Branches")}`,
        description: vscode.l10n.t("Compare any two local or remote branches"),
        mode: "branches",
      },
      {
        label: `$(cloud) ${vscode.l10n.t("Current Branch and Upstream")}`,
        description: vscode.l10n.t(
          "Compare the checked-out branch with its tracked remote branch"
        ),
        mode: "localRemote",
      },
      {
        label: `$(git-pull-request) ${vscode.l10n.t("Pull Request")}`,
        description: vscode.l10n.t("Compare the changed files of a GitHub pull request"),
        mode: "pullRequest",
      },
    ],
    {
      title: vscode.l10n.t("Select Editor Gutter Comparison"),
      placeHolder: vscode.l10n.t(
        "Choose what to compare beside line numbers and in Explorer"
      ),
      ignoreFocusOut: true,
    }
  );
  if (!picked) {
    logInfo("explorer comparison selection cancelled", { step: "mode" });
    return;
  }

  logInfo("explorer comparison mode selected", { mode: picked.mode });
  switch (picked.mode) {
    case "branches":
      await vscode.commands.executeCommand(
        "gitSimpleCompare.compareBranches",
        "explorer" satisfies ComparisonFocus
      );
      return;
    case "localRemote":
      await compareLocalWithRemote(deps);
      return;
    case "pullRequest":
      await comparePullRequest(deps);
  }
}

/**
 * 현재 로컬 브랜치를 설정된 upstream remote-tracking 브랜치와 비교한다.
 * - upstream 미설정, detached HEAD, gone upstream 판별은 ComparisonService에 위임한다.
 * @param deps 저장소 탐지와 스냅샷 적용에 필요한 명령 의존성
 */
export async function compareLocalWithRemote(deps: CommandDeps): Promise<void> {
  const service = await resolveComparisonService(deps);
  if (!service) {
    return;
  }
  await runAndApplyComparison(
    deps,
    {
      source: "compareLocalWithRemote",
      kind: "localRemote",
      progressTitle: vscode.l10n.t("Comparing the current branch with its upstream..."),
      focus: "explorer",
    },
    () => service.compareUpstream(readConfig().diffBase)
  );
}

/**
 * GitHub PR 목록에서 항목을 고른 뒤 PR changed-files 스냅샷을 적용한다.
 * - gh CLI/인증이 없는 경우 overview의 구조화된 오류를 OUTPUT과 알림으로 전달한다.
 * @param deps 저장소, controller, Changes 뷰 공유 의존성
 * @param initialPr 다른 UI가 이미 고른 PR. 없으면 명령이 picker를 표시한다.
 */
export async function comparePullRequest(
  deps: CommandDeps,
  initialPr?: PullRequestInfo
): Promise<void> {
  const service = await resolveComparisonService(deps);
  if (!service) {
    return;
  }
  const selected = initialPr ?? (await pickPullRequest(service));
  if (!selected) {
    return;
  }
  await runAndApplyComparison(
    deps,
    {
      source: "comparePullRequest",
      kind: "pullRequest",
      progressTitle: vscode.l10n.t("Loading pull request #{0} changes...", selected.number),
      focus: "explorer",
    },
    () => service.comparePullRequest(selected)
  );
}

/**
 * 편집기 gutter와 Explorer/탭 비교 표시를 켠다.
 * - 이전 스냅샷이 있으면 git 조회 없이 복원하고, 없으면 비교 방식 선택을
 *   이어서 실행해 빈 토글만 켜지는 경우를 줄인다.
 * @param deps 표시 상태를 가진 controller 의존성
 */
export async function showExplorerComparison(deps: CommandDeps): Promise<void> {
  deps.comparison.setEnabled(true, "showExplorerComparison");
  logInfo("explorer comparison show command", {
    hasComparison: deps.comparison.hasComparison,
  });
  if (!deps.comparison.hasComparison) {
    await selectExplorerComparison(deps);
    if (!deps.comparison.hasComparison) {
      await focusComparisonView("explorer");
    }
    return;
  }
  await focusComparisonView("explorer");
}

/**
 * 선택한 스냅샷은 보존하고 편집기 gutter와 Explorer/탭 장식만 숨긴다.
 * @param deps 표시 토글 controller 의존성
 */
export function hideExplorerComparison(deps: CommandDeps): void {
  deps.comparison.setEnabled(false, "hideExplorerComparison");
  logInfo("explorer comparison hide command", {
    hasComparison: deps.comparison.hasComparison,
  });
}

/**
 * 현재 스냅샷을 같은 비교 모드로 다시 조회해 controller와 Changes 뷰를 동기화한다.
 * - PR은 번호, 브랜치는 ref, local/remote는 현재 upstream을 ComparisonService.refresh가
 *   각각 다시 해석하므로 명령은 모드별 분기를 중복하지 않는다.
 * @param deps controller, 저장소 레지스트리, Changes 뷰 의존성
 * @param reason 수동 명령/파일 이벤트 등 새로고침 원인
 * @param interactive true면 빈 결과 안내와 Explorer 포커스를 표시한다
 */
export async function refreshExplorerComparison(
  deps: CommandDeps,
  reason = "command",
  interactive = true
): Promise<void> {
  const current = deps.comparison.getComparison(true);
  if (!current) {
    if (interactive) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("Select a comparison before refreshing Explorer decorations.")
      );
      await selectExplorerComparison(deps);
    } else {
      logInfo("explorer comparison refresh skipped", {
        reason,
        reasonDetail: "no-comparison",
      });
    }
    return;
  }
  deps.comparison.setEnabled(true, `refresh:${reason}`);
  const service = createComparisonService(deps, current.repoRoot);
  logInfo("explorer comparison refresh command started", {
    reason,
    repoRoot: current.repoRoot,
    kind: current.kind,
  });
  try {
    const refreshed = await vscode.window.withProgress(
      {
        location: { viewId: COMPARISON_VIEW_ID },
        title: vscode.l10n.t("Refreshing Explorer comparison..."),
      },
      () =>
        deps.comparison.refreshWith(
          (snapshot) => service.refresh(snapshot),
          reason
        )
    );
    if (!refreshed) {
      return;
    }
    syncSnapshotToChangesView(deps, refreshed);
    if (interactive) {
      notifyComparisonResult(refreshed);
    }
    logInfo("explorer comparison refresh command finished", {
      reason,
      changes: refreshed.changes.length,
      truncated: !!refreshed.truncated,
    });
    await focusComparisonView(interactive ? "explorer" : "none");
  } catch (error) {
    if (interactive) {
      reportComparisonError(error, "refresh", current.repoRoot);
    } else {
      logError("background comparison refresh failed", error, {
        reason,
        repoRoot: current.repoRoot,
        kind: current.kind,
      });
    }
  }
}

/**
 * Explorer 장식에서 사용하는 선택 스냅샷을 완전히 제거한다.
 * - 표시 토글은 유지해 비교 뷰가 welcome 안내와 재선택 액션을 보여 준다.
 * - controller와 Changes 웹뷰를 함께 비워 두 UI가 서로 다른 비교를 가리키지 않게 한다.
 * @param deps 비교 controller 의존성
 */
export function clearExplorerComparison(deps: CommandDeps): void {
  deps.comparison.clearComparison("clearExplorerComparison");
  deps.changesView.clearComparison();
  logInfo("explorer comparison clear command");
}

/**
 * ComparisonService 조회를 진행 표시/오류 처리로 감싼 뒤 공통 적용 함수로 넘긴다.
 * - 브랜치, upstream, PR 명령이 동일한 상태 배포·알림·로그 규칙을 쓴다.
 * @param deps controller와 Changes 뷰를 포함한 명령 의존성
 * @param options 진행 문구, 비교 종류, 적용 정책
 * @param load ComparisonSnapshot을 반환하는 도메인 조회
 * @returns 성공해 적용된 스냅샷, 실패하면 undefined
 */
export async function runAndApplyComparison(
  deps: CommandDeps,
  options: ComparisonRunOptions,
  load: () => Promise<ComparisonSnapshot>
): Promise<ComparisonSnapshot | undefined> {
  logInfo("comparison command started", {
    source: options.source,
    kind: options.kind,
  });
  const generation = deps.comparison.beginComparisonLoad(options.source);
  try {
    const snapshot = await vscode.window.withProgress(
      {
        location: { viewId: COMPARISON_VIEW_ID },
        title: options.progressTitle,
      },
      load
    );
    if (!deps.comparison.isComparisonLoadCurrent(generation)) {
      logInfo("comparison command result skipped", {
        source: options.source,
        kind: options.kind,
        generation,
        reason: "superseded",
      });
      return undefined;
    }
    await applyComparisonSnapshot(deps, snapshot, options);
    return snapshot;
  } catch (error) {
    if (!deps.comparison.isComparisonLoadCurrent(generation)) {
      logInfo("comparison command error skipped", {
        source: options.source,
        kind: options.kind,
        generation,
        reason: "superseded",
      });
      return undefined;
    }
    reportComparisonError(error, options.kind);
    return undefined;
  }
}

/**
 * 하나의 비교 스냅샷을 controller와 기존 Changes 웹뷰에 원자적으로 같이 반영한다.
 * - controller는 Explorer/탭/전용 트리의 소스이고 ChangesView의 BranchComparison은
 *   기존 웹뷰 호환 형식이므로, 변환은 이 경계에서만 수행한다.
 * @param deps 비교 상태를 소비하는 controller/Changes 뷰
 * @param snapshot ComparisonService가 만든 비교 결과
 * @param options 표시 토글, 알림, 포커스, controller 동기화 정책
 */
export async function applyComparisonSnapshot(
  deps: CommandDeps,
  snapshot: ComparisonSnapshot,
  options: ComparisonApplyOptions
): Promise<void> {
  if (options.syncController !== false) {
    deps.comparison.setSnapshot(snapshot);
    if (options.reveal !== false) {
      deps.comparison.setEnabled(true, options.source);
    }
  }
  syncSnapshotToChangesView(deps, snapshot);
  logInfo("comparison snapshot applied", {
    source: options.source,
    kind: snapshot.kind,
    repoRoot: snapshot.repoRoot,
    baseRef: snapshot.baseRef,
    targetRef: snapshot.targetRef,
    changes: snapshot.changes.length,
    truncated: !!snapshot.truncated,
    controllerSynced: options.syncController !== false,
    enabled: deps.comparison.enabled,
  });
  if (options.notify !== false) {
    notifyComparisonResult(snapshot);
  }
  await focusComparisonView(options.focus ?? "explorer");
}

/**
 * 스냅샷을 기존 ChangesView가 이해하는 BranchComparison으로 변환해 적용한다.
 * @param deps 기존 Changes 웹뷰 provider를 포함한 명령 의존성
 * @param snapshot ref/label/파일 목록을 모두 포함한 비교 결과
 */
function syncSnapshotToChangesView(
  deps: CommandDeps,
  snapshot: ComparisonSnapshot
): void {
  const comparison: BranchComparison = {
    repoRoot: snapshot.repoRoot,
    base: snapshot.baseRef,
    sourceBase: snapshot.sourceBaseRef,
    target: snapshot.targetRef,
    baseLabel: snapshot.baseLabel,
    targetLabel: snapshot.targetLabel,
    diffAvailable: snapshot.diffAvailable,
    diffBase: snapshot.diffBase,
    changes: snapshot.changes,
  };
  deps.changesView.setComparison(comparison);
}
