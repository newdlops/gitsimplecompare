// 기능 1: 브랜치(로컬/원격)끼리 변경점 비교.
// - 기본은 현재 checkout과 기준 브랜치 하나를 비교하고, 고급 모드만 FROM/TO를 직접 고른다.
// - 실제 git 호출은 GitService, 선택 UI 는 quickPick, diff 표시는 diffPresenter 에 위임한다.
import * as vscode from "vscode";
import {
  resolveComparisonRefIdentity,
  type ComparisonSnapshot,
} from "../git/comparisonService";
import { BranchComparison, DiffBase } from "../git/gitTypes";
import { GitService } from "../git/gitService";
import {
  pickBaseAndTarget,
  pickBranch,
  pickComparisonBranchForCurrent,
} from "../ui/quickPick";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logInfo } from "../ui/outputLog";
import { ChangeDiffArgs } from "../providers/changesTreeModel";
import {
  CommandDeps,
  createComparisonService,
  readConfig,
  resolveCompareService,
} from "./shared";
import {
  applyComparisonSnapshot,
  ComparisonFocus,
  reportComparisonError,
  runAndApplyComparison,
} from "./comparisonDecorations";

/**
 * "브랜치끼리 비교" 명령 본문.
 * - 기본은 비교 기준 브랜치 하나만 고르고 현재 checkout을 편집 가능한 TO로 고정한다.
 * - 고급 항목을 고른 경우에만 임의 FROM/TO 두 브랜치를 순서대로 선택한다.
 * @param deps 공유 의존성(레지스트리/트리)
 * @param focus 명령 완료 후 드러낼 Changes/Explorer 뷰. 기본은 Changes 뷰
 * @param mode current는 한 브랜치만, advanced는 FROM/TO를 모두 고른다
 * @returns 선택 취소 또는 비교 적용이 끝나면 완료되는 Promise
 */
export async function compareBranches(
  deps: CommandDeps,
  focus: ComparisonFocus = "changes",
  mode: "current" | "advanced" = "current"
): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    logInfo("branch comparison skipped", { reason: "no-repository" });
    return;
  }

  const config = readConfig();
  // 진행 표시와 함께 브랜치 목록을 읽는다(원격 포함 여부는 설정을 따른다).
  let branches;
  try {
    branches = await vscode.window.withProgress(
      {
        location:
          focus === "explorer"
            ? vscode.ProgressLocation.Window
            : { viewId: "gitSimpleCompare.changes" },
        title: vscode.l10n.t("Loading branches..."),
      },
      () => service.listBranches(config.includeRemoteBranches)
    );
  } catch (error) {
    reportComparisonError(error, "branches:list", service.repoRoot);
    return;
  }
  if (branches.length === 0) {
    logInfo("branch comparison skipped", {
      reason: "no-branches",
      repoRoot: service.repoRoot,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t("No branches to compare.")
    );
    return;
  }
  if (mode === "advanced") {
    if (branches.length < 2) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("Not enough branches to compare (at least 2 required).")
      );
      return;
    }
    const current = branches.find((branch) => branch.isCurrent)?.name;
    const picked = await pickBaseAndTarget(branches, current);
    if (!picked) {
      logInfo("advanced branch comparison selection cancelled", {
        repoRoot: service.repoRoot,
      });
      return;
    }
    await applyComparison(
      deps,
      service,
      picked.base.name,
      picked.target.name,
      config.diffBase,
      focus,
      "compareBranchesAdvanced"
    );
    return;
  }
  let current = branches.find((branch) => branch.isCurrent)?.name;
  if (!current) {
    try {
      current = await service.getCurrentBranch();
    } catch (error) {
      reportComparisonError(error, "branches:current", service.repoRoot);
      return;
    }
  }
  const selectedIdentity = await resolveComparisonRefIdentity(
    service.repoRoot,
    current,
    current
  );
  if (!selectedIdentity.headHash) {
    logInfo("current checkout comparison skipped", {
      reason: "unresolved-head",
      repoRoot: service.repoRoot,
      current,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t("The current checkout could not be resolved to a commit.")
    );
    return;
  }
  const candidates = branches.filter((branch) => branch.name !== current);
  if (candidates.length === 0) {
    logInfo("current checkout comparison skipped", {
      reason: "no-other-branch",
      repoRoot: service.repoRoot,
      current,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "No other branch is available to compare with the current checkout."
      )
    );
    return;
  }
  const base = await pickComparisonBranchForCurrent(branches, current);
  if (!base) {
    logInfo("current checkout comparison selection cancelled", {
      repoRoot: service.repoRoot,
      current,
    });
    return;
  }
  const latestCheckout = await Promise.all([
    service.getCurrentBranch(),
    resolveComparisonRefIdentity(service.repoRoot, current, current),
  ]).catch((error) => {
    reportComparisonError(error, "branches:current-recheck", service.repoRoot);
    return undefined;
  });
  if (!latestCheckout) {
    return;
  }
  const [latestCurrent, latestIdentity] = latestCheckout;
  if (
    latestCurrent !== current ||
    latestIdentity.headHash !== selectedIdentity.headHash
  ) {
    logInfo("current checkout comparison selection expired", {
      repoRoot: service.repoRoot,
      selectedCurrent: current,
      latestCurrent,
      selectedHead: selectedIdentity.headHash,
      latestHead: latestIdentity.headHash,
    });
    const retry = vscode.l10n.t("Compare Again");
    const action = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "The current checkout changed while selecting. Choose the comparison branch again."
      ),
      retry
    );
    if (action === retry) {
      await compareBranches(deps, focus, "current");
    }
    return;
  }
  // detached HEAD는 선택 이후 다른 checkout으로 움직여도 결과 ref가 바뀌지 않도록 commit으로 고정한다.
  const target = current === "HEAD" ? selectedIdentity.headHash : current;
  await applyComparison(
    deps,
    service,
    base.name,
    target,
    config.diffBase,
    focus,
    "compareCurrentCheckout",
    current === "HEAD" ? "HEAD" : undefined
  );
}

/**
 * 임의의 FROM/TO 두 브랜치를 고르는 고급 비교 명령이다.
 * - 사용자가 선택한 방향을 그대로 유지하며, TO가 현재 checkout일 때만 native gutter가 켜진다.
 * @param deps 공유 의존성
 * @param focus 완료 후 표시할 Changes/Explorer 뷰
 * @returns 선택 취소 또는 비교 적용이 끝나면 완료되는 Promise
 */
export async function compareBranchesAdvanced(
  deps: CommandDeps,
  focus: ComparisonFocus = "changes"
): Promise<void> {
  await compareBranches(deps, focus, "advanced");
}

/**
 * 트리 상단의 From/To 헤더를 클릭(또는 인라인 편집)했을 때 한쪽 브랜치만 바꿔 재비교한다.
 * - 활성 비교가 없으면 일반 "브랜치끼리 비교"로 넘긴다.
 * @param deps 공유 의존성
 * @param sideArg 바꿀 쪽("from"|"to") 또는 트리에서 전달된 RefNode(.side 보유)
 */
export async function changeComparisonRef(
  deps: CommandDeps,
  sideArg: "from" | "to" | { side?: "from" | "to" } | undefined
): Promise<void> {
  const side = typeof sideArg === "string" ? sideArg : sideArg?.side;
  if (!side) {
    logInfo("branch comparison ref change skipped", {
      reason: "missing-side",
    });
    return;
  }
  const comparison = deps.changesView.getComparison();
  const service = comparison
    ? deps.registry.get(comparison.repoRoot)
    : await resolveCompareService(deps);
  if (!service) {
    return;
  }

  const config = readConfig();
  let branches;
  try {
    branches = await service.listBranches(config.includeRemoteBranches);
  } catch (error) {
    reportComparisonError(error, "branches:list", service.repoRoot);
    return;
  }
  const draft = deps.changesView.getDraft();
  const currentRef = comparison
    ? side === "from"
      ? comparison.sourceBase ?? comparison.base
      : comparison.target
    : side === "from"
    ? draft.from
    : draft.to;
  const placeholder =
    side === "from"
      ? vscode.l10n.t("Select the base branch (from)")
      : vscode.l10n.t("Select the target branch (to)");

  const picked = await pickBranch(branches, placeholder, currentRef);
  if (!picked) {
    logInfo("branch comparison ref change cancelled", {
      repoRoot: service.repoRoot,
      side,
    });
    return;
  }

  if (comparison) {
    // 활성 비교가 있으면 한쪽만 바꿔 즉시 재비교한다.
    const base =
      side === "from"
        ? picked.name
        : comparison.sourceBase ?? comparison.base;
    const target = side === "to" ? picked.name : comparison.target;
    await applyComparison(
      deps,
      service,
      base,
      target,
      comparison.diffBase,
      "changes"
    );
  } else {
    // 비교 전이면 초안만 갱신한다(아래 Compare 로 실행).
    deps.changesView.setDraft(side, picked.name);
  }
}

/**
 * 설정 단계의 "Compare" 액션: 초안의 from/to 로 비교를 실행한다.
 * - 둘 중 하나라도 비어 있으면 안내 후 중단한다(명시적 설정 강제).
 * @param deps 공유 의존성
 */
export async function runComparison(deps: CommandDeps): Promise<void> {
  const draft = deps.changesView.getDraft();
  if (!draft.from || !draft.to) {
    logInfo("draft branch comparison skipped", {
      reason: "incomplete-draft",
      hasFrom: !!draft.from,
      hasTo: !!draft.to,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t("Select both From and To branches first.")
    );
    return;
  }
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }
  await applyComparison(
    deps,
    service,
    draft.from,
    draft.to,
    readConfig().diffBase,
    "changes"
  );
}

/**
 * 현재 표시 중인 브랜치 비교 결과를 같은 from/to/ref 기준으로 다시 조회한다.
 * - 브랜치가 새 커밋을 가리키거나 fetch/rebase/commit 으로 ref 가 바뀐 경우
 *   기존 비교 UI 가 오래된 파일 목록을 들고 있지 않도록 자동/수동 refresh 에서 호출한다.
 * @param deps 공유 의존성
 */
export async function refreshActiveComparison(
  deps: CommandDeps
): Promise<void> {
  const comparison = deps.changesView.getComparison();
  if (!comparison) {
    logInfo("active comparison refresh skipped", {
      reason: "no-comparison",
    });
    return;
  }
  const service = createComparisonService(deps, comparison.repoRoot);
  const explorerSnapshot = deps.comparison.getComparison(true);
  const syncController = Boolean(
    explorerSnapshot &&
      snapshotMatchesComparison(explorerSnapshot, comparison)
  );
  const snapshot =
    explorerSnapshot && syncController
      ? await deps.comparison.refreshWith(
          (current) => service.refresh(current),
          "changesView",
          { includeDisabled: true }
        )
      : await service.compareRefs(
          comparison.sourceBase ?? comparison.base,
          comparison.target,
          comparison.diffBase
        );
  // controller refresh 세대와 ChangesView 객체 동일성 검사를 함께 써서,
  // refresh 도중 사용자가 비교를 바꾸거나 지우면 오래된 결과를 버린다.
  if (!snapshot) {
    return;
  }
  if (deps.changesView.getComparison() !== comparison) {
    logInfo("active comparison refresh result skipped", {
      reason: "comparison-changed",
      repoRoot: comparison.repoRoot,
      base: comparison.sourceBase ?? comparison.base,
      target: comparison.target,
    });
    return;
  }
  await applyComparisonSnapshot(deps, snapshot, {
    source: "refreshActiveComparison",
    focus: "none",
    notify: false,
    reveal: false,
    // syncController=true 경로는 refreshWith가 이미 generation 검증 후 적용했다.
    syncController: false,
  });
}

/**
 * 주어진 기준/대상으로 변경 목록을 조회해 트리에 반영하는 공통 로직.
 * - compareBranches 와 changeComparisonRef 가 공유한다(재사용).
 * - 기본 비교는 선택 브랜치→현재 checkout, 고급 비교는 사용자가 선택한 방향을 보존한다.
 * @param deps     공유 의존성
 * @param service  대상 저장소의 GitService
 * @param base     기준(from) 브랜치
 * @param target   대상(to) 브랜치
 * @param diffBase 비교 기준(two/three dot)
 * @param focus    성공 후 드러낼 Changes/Explorer 뷰
 * @param source 기본 현재 비교와 고급 비교를 로그/동시 실행 세대에서 구분할 이름
 * @param targetLabel target을 commit으로 고정해도 UI에 유지할 표시 이름
 * @returns 비교 적용이 끝나면 완료되는 Promise
 */
async function applyComparison(
  deps: CommandDeps,
  service: GitService,
  base: string,
  target: string,
  diffBase: DiffBase,
  focus: ComparisonFocus,
  source: "compareCurrentCheckout" | "compareBranchesAdvanced" =
    "compareBranchesAdvanced",
  targetLabel?: string
): Promise<void> {
  const comparisonService = createComparisonService(deps, service.repoRoot);
  await runAndApplyComparison(
    deps,
    {
      source,
      kind: "branches",
      progressTitle: vscode.l10n.t("Comparing {0} with {1}...", base, target),
      focus,
    },
    () =>
      comparisonService.compareRefs(base, target, diffBase, {
        target: targetLabel,
      })
  );
}

/**
 * Changes 웹뷰의 호환 비교가 controller에 보관된 스냅샷과 같은지 확인한다.
 * - clearExplorerComparison 후나 다른 저장소 비교를 보는 중에 Changes 자동 새로고침이
 *   의도치 않게 Explorer 선택을 복원하지 않도록 하는 게이트다.
 * @param snapshot controller에 보관된 비교 스냅샷
 * @param comparison Changes 웹뷰에 보이는 호환 비교
 * @returns 저장소, 양쪽 ref, diff 기준이 모두 같으면 true
 */
function snapshotMatchesComparison(
  snapshot: ComparisonSnapshot,
  comparison: BranchComparison
): boolean {
  return (
    snapshot.repoRoot === comparison.repoRoot &&
    snapshot.baseRef === comparison.base &&
    snapshot.sourceBaseRef === (comparison.sourceBase ?? comparison.base) &&
    snapshot.targetRef === comparison.target &&
    snapshot.diffBase === comparison.diffBase
  );
}

/**
 * 트리뷰의 변경 파일 항목을 클릭했을 때 호출되는 diff 열기 핸들러.
 * - 이름변경(R)·복사(C)면 왼쪽(기준)에는 원본 경로(oldPath)를, 오른쪽(대상)에는
 *   새 경로(path)를 사용해 정확히 매칭한다.
 * @param args 비교 컨텍스트 + 클릭된 변경 파일
 */
export async function openChangeDiff(args: ChangeDiffArgs): Promise<void> {
  if (!args?.comparison || !args.change) {
    return;
  }
  const { comparison, change } = args;
  if (comparison.diffAvailable === false) {
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

  await openRefVsRefDiff(
    comparison.repoRoot,
    comparison.base,
    comparison.target,
    change.path,
    fileLabel,
    leftRelPath,
    {
      leftLabel: comparison.baseLabel,
      rightLabel: comparison.targetLabel,
    }
  );
}
