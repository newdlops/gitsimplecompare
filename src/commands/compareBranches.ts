// 기능 1: 브랜치(로컬/원격)끼리 변경점 비교.
// - 두 브랜치를 고른 뒤 변경 파일 목록을 트리뷰에 채우고, 각 파일은 클릭 시 diff 로 연다.
// - 실제 git 호출은 GitService, 선택 UI 는 quickPick, diff 표시는 diffPresenter 에 위임한다.
import * as vscode from "vscode";
import { BranchComparison } from "../git/gitTypes";
import { pickBaseAndTarget } from "../ui/quickPick";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { ChangeDiffArgs } from "../providers/changesTreeProvider";
import {
  CommandDeps,
  readConfig,
  resolveWorkspaceService,
} from "./shared";

/**
 * "브랜치끼리 비교" 명령 본문.
 * - 작업 저장소 탐지 → 브랜치 목록 조회 → base/target 선택 → 변경 목록 조회 →
 *   트리뷰 갱신의 순서로 진행한다.
 * @param deps 공유 의존성(레지스트리/트리)
 */
export async function compareBranches(deps: CommandDeps): Promise<void> {
  const service = await resolveWorkspaceService(deps.registry);
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
      "비교할 브랜치가 충분하지 않습니다(2개 이상 필요)."
    );
    return;
  }

  const current = branches.find((b) => b.isCurrent)?.name;
  const picked = await pickBaseAndTarget(branches, current);
  if (!picked) {
    return;
  }

  // 선택한 두 브랜치 사이의 변경 파일을 조회한다.
  const changes = await service.listChanges(
    picked.base.name,
    picked.target.name,
    config.diffBase
  );

  const comparison: BranchComparison = {
    repoRoot: service.repoRoot,
    base: picked.base.name,
    target: picked.target.name,
    diffBase: config.diffBase,
    changes,
  };
  deps.treeProvider.setComparison(comparison);

  if (changes.length === 0) {
    vscode.window.showInformationMessage(
      `${picked.base.name} ↔ ${picked.target.name}: 변경된 파일이 없습니다.`
    );
    return;
  }

  // 트리뷰가 보이도록 첫 항목을 리빌해 사용자 시선을 옮긴다.
  await deps.treeView.reveal(changes[0], { select: false, focus: false });
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
