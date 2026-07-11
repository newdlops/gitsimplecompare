// 브랜치 선택 UI 모듈.
// - QuickPick 기반의 브랜치 고르기 흐름만 담당한다(표시/선택). git 호출이나 diff 로직은
//   포함하지 않아 다른 명령에서도 그대로 재사용할 수 있다.
import * as vscode from "vscode";
import { BranchInfo } from "../git/gitTypes";

/**
 * 브랜치 하나를 고르는 QuickPick 을 띄운다.
 * - 로컬/원격을 구분 아이콘으로 표시하고 현재 브랜치는 별도 표기한다.
 * - activeName 이 주어지면 해당 브랜치를 목록 맨 위로 올려 빠르게 고르게 한다.
 * @param branches    선택 후보 브랜치 목록
 * @param placeHolder 입력창 안내 문구
 * @param activeName  맨 위로 올릴 브랜치 이름(선택)
 * @param title       QuickPick 상단 제목(단계 안내 등, 선택)
 * @returns 선택한 브랜치, 취소 시 undefined
 */
export async function pickBranch(
  branches: BranchInfo[],
  placeHolder: string,
  activeName?: string,
  title?: string
): Promise<BranchInfo | undefined> {
  // activeName 브랜치를 가장 앞에 두고 나머지는 원래 순서를 유지한다.
  const ordered = activeName
    ? [...branches].sort((a, b) => rankByActive(a, b, activeName))
    : branches;
  const items = ordered.map((b) => toQuickPickItem(b));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return picked?.branch;
}

/**
 * activeName 과 일치하는 브랜치를 앞으로 보내는 정렬 비교 함수.
 * @param a 비교 대상 A
 * @param b 비교 대상 B
 * @param activeName 우선할 브랜치 이름
 * @returns 음수면 a 우선, 양수면 b 우선
 */
function rankByActive(a: BranchInfo, b: BranchInfo, activeName: string): number {
  const ra = a.name === activeName ? 0 : 1;
  const rb = b.name === activeName ? 0 : 1;
  return ra - rb;
}

/**
 * 현재 checkout은 편집 대상으로 고정하고 비교 기준 브랜치 하나만 고르게 한다.
 * - 사용자가 FROM/TO나 Quick Diff 제약을 몰라도 gutter가 가능한 방향을 만든다.
 * @param branches 로컬/원격 비교 후보
 * @param currentName 현재 checkout된 브랜치 이름 또는 detached HEAD의 `HEAD`
 * @returns 선택한 비교 기준 브랜치, 취소하면 undefined
 */
export async function pickComparisonBranchForCurrent(
  branches: BranchInfo[],
  currentName: string
): Promise<BranchInfo | undefined> {
  const items: BranchQuickPickItem[] = branches
    .filter((branch) => branch.name !== currentName)
    .map((branch) => {
      const item = toQuickPickItem(branch);
      return {
        ...item,
        detail: vscode.l10n.t(
          "{0} → current working tree ({1})",
          branch.name,
          currentName
        ),
      };
    });
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Compare with Current Checkout: {0}", currentName),
    placeHolder: vscode.l10n.t(
      "Select the branch to compare against the current working tree"
    ),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked?.branch;
}

/**
 * 기준(base)·대상(target) 두 브랜치를 순서대로 고른다.
 * - 첫 선택을 base, 두 번째 선택을 target 으로 한다. 어느 한쪽이라도 취소하면 중단.
 * @param branches   선택 후보
 * @param currentName 현재 브랜치 이름(대상 기본값 힌트로 활용)
 * @returns { base, target } 또는 취소 시 undefined
 */
export async function pickBaseAndTarget(
  branches: BranchInfo[],
  currentName?: string
): Promise<{ base: BranchInfo; target: BranchInfo } | undefined> {
  const base = await pickBranch(
    branches,
    vscode.l10n.t("Pick the FROM branch — the base you compare against"),
    undefined,
    vscode.l10n.t("Compare Branches (1/2): choose FROM (base)")
  );
  if (!base) {
    return undefined;
  }
  // 같은 ref끼리의 무의미한 비교를 막고, 현재 브랜치는 TO 선택에서만 맨 위에 둔다.
  const targetCandidates = branches.filter(
    (branch) => branch.name !== base.name
  );
  const target = await pickBranch(
    targetCandidates,
    vscode.l10n.t(
      "Pick the TO branch — choose the current branch for editor gutter markers"
    ),
    currentName,
    vscode.l10n.t(
      "Compare Branches (2/2): choose TO (target) — FROM is {0}",
      base.name
    )
  );
  if (!target) {
    return undefined;
  }
  return { base, target };
}

/** QuickPick 항목에 원본 BranchInfo 를 함께 들고 다니기 위한 확장 타입 */
interface BranchQuickPickItem extends vscode.QuickPickItem {
  branch: BranchInfo;
}

/**
 * BranchInfo 를 QuickPick 항목으로 변환한다(아이콘/설명 부여).
 * @param branch 변환할 브랜치
 */
function toQuickPickItem(branch: BranchInfo): BranchQuickPickItem {
  const icon = branch.kind === "remote" ? "$(cloud)" : "$(git-branch)";
  const descParts: string[] = [
    branch.kind === "remote" ? vscode.l10n.t("remote") : vscode.l10n.t("local"),
  ];
  if (branch.isCurrent) {
    descParts.push(vscode.l10n.t("current"));
  }
  return {
    label: `${icon} ${branch.name}`,
    description: descParts.join(" · "),
    branch,
  };
}
