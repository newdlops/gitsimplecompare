// 기능 1: 브랜치(로컬/원격)끼리 변경점 비교.
// - 두 브랜치를 고른 뒤 변경 파일 목록을 트리뷰에 채우고, 각 파일은 클릭 시 diff 로 연다.
// - 실제 git 호출은 GitService, 선택 UI 는 quickPick, diff 표시는 diffPresenter 에 위임한다.
import * as vscode from "vscode";
import { BranchComparison, DiffBase } from "../git/gitTypes";
import { GitService } from "../git/gitService";
import { pickBaseAndTarget, pickBranch } from "../ui/quickPick";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { ChangeDiffArgs } from "../providers/changesTreeModel";
import {
  CommandDeps,
  readConfig,
  resolveCompareService,
} from "./shared";

/**
 * "브랜치끼리 비교" 명령 본문.
 * - 작업 저장소 탐지 → 브랜치 목록 조회 → base/target 선택 → 비교 적용의 순서.
 * @param deps 공유 의존성(레지스트리/트리)
 */
export async function compareBranches(deps: CommandDeps): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }

  const config = readConfig();
  // 진행 표시와 함께 브랜치 목록을 읽는다(원격 포함 여부는 설정을 따른다).
  const branches = await vscode.window.withProgress(
    { location: { viewId: "gitSimpleCompare.changes" } },
    () => service.listBranches(config.includeRemoteBranches)
  );
  if (branches.length < 2) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Not enough branches to compare (at least 2 required).")
    );
    return;
  }

  const current = branches.find((b) => b.isCurrent)?.name;
  const picked = await pickBaseAndTarget(branches, current);
  if (!picked) {
    return;
  }
  await applyComparison(
    deps,
    service,
    picked.base.name,
    picked.target.name,
    config.diffBase
  );
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
  const branches = await service.listBranches(config.includeRemoteBranches);
  const draft = deps.changesView.getDraft();
  const currentRef = comparison
    ? side === "from"
      ? comparison.base
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
    return;
  }

  if (comparison) {
    // 활성 비교가 있으면 한쪽만 바꿔 즉시 재비교한다.
    const base = side === "from" ? picked.name : comparison.base;
    const target = side === "to" ? picked.name : comparison.target;
    await applyComparison(deps, service, base, target, comparison.diffBase);
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
    readConfig().diffBase
  );
}

/**
 * 주어진 기준/대상으로 변경 목록을 조회해 트리에 반영하는 공통 로직.
 * - compareBranches 와 changeComparisonRef 가 공유한다(재사용).
 * @param deps     공유 의존성
 * @param service  대상 저장소의 GitService
 * @param base     기준(from) 브랜치
 * @param target   대상(to) 브랜치
 * @param diffBase 비교 기준(two/three dot)
 */
async function applyComparison(
  deps: CommandDeps,
  service: GitService,
  base: string,
  target: string,
  diffBase: DiffBase
): Promise<void> {
  const changes = await service.listChanges(base, target, diffBase);
  const comparison: BranchComparison = {
    repoRoot: service.repoRoot,
    base,
    target,
    diffBase,
    changes,
  };
  deps.changesView.setComparison(comparison);

  if (changes.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("{0} ↔ {1}: no changed files.", base, target)
    );
  }
  // 트리뷰를 화면에 드러내 사용자 시선을 옮긴다(From/To 헤더가 상단에 보인다).
  await vscode.commands.executeCommand("gitSimpleCompare.changes.focus");
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
    leftRelPath
  );
}
