// git graph 웹뷰의 브랜치 관련 액션을 처리하는 모듈.
// - graphActions.ts 는 메시지 라우팅에 집중하고, 브랜치 checkout/create/delete/clone 흐름은 여기로 모은다.
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import type { LocalBranchStatus } from "../graph/graphTypes";
import { logInfo } from "../ui/outputLog";
import {
  focusCheckoutConflicts,
  isCheckoutConflictError,
  retryCheckoutWithConflicts,
} from "./graphCheckoutConflicts";

export type BranchKind = "local" | "remote";

interface GraphBranchActionDeps {
  logService: GitLogService;
  refreshCheckout: () => Promise<void>;
  refreshGraph: () => Promise<void>;
}

type BranchQuickAction = "checkout" | "clone" | "cloneCheckout";

interface BranchQuickPickItem extends vscode.QuickPickItem {
  action: BranchQuickAction;
}

/**
 * 로컬 브랜치로 checkout 한다.
 * - checkout 충돌은 graph 공통 충돌 확인 UI 를 거쳐 기존 Conflicts 화면으로 이동시킨다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param branchName checkout 할 로컬 브랜치 이름
 * @returns checkout 이 끝났거나 이미 대상 브랜치였으면 true, 사용자가 충돌 checkout 을 취소하면 false
 */
export async function checkoutBranch(
  deps: GraphBranchActionDeps,
  branchName: string
): Promise<boolean> {
  const branch = await findLocalBranch(deps, branchName);
  if (!branch) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Branch not found: {0}", branchName)
    );
    return false;
  }
  if (branch.current) {
    return true;
  }
  try {
    await deps.logService.checkoutLocalBranch(branch.name);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    const result = await retryCheckoutWithConflicts(
      err,
      deps.logService.repoRoot,
      branch.name,
      () => deps.logService.checkoutLocalBranch(branch.name, true)
    );
    if (result === "cancelled") {
      return false;
    }
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return true;
    }
    if (result === "conflicts") {
      return true;
    }
  }
  await deps.refreshCheckout();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Checked out branch '{0}'.", branch.name)
  );
  return true;
}

/**
 * 원격 브랜치 chip 클릭 시 같은 이름의 로컬 브랜치를 만들고 checkout 한다.
 * - 이미 같은 로컬 브랜치가 있으면 새로 만들지 않고 checkout 여부만 확인한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param remoteBranch checkout 할 원격 브랜치 short name
 */
export async function checkoutRemoteBranch(
  deps: GraphBranchActionDeps,
  remoteBranch: string
): Promise<void> {
  const localName = localNameForRemoteBranch(remoteBranch);
  const existing = (await deps.logService.getLocalBranches()).find(
    (branch) => branch.name === localName
  );
  if (existing) {
    const ok = await confirm(
      vscode.l10n.t("Local branch '{0}' already exists. Checkout it?", localName),
      vscode.l10n.t("Checkout")
    );
    if (ok) {
      await checkoutBranch(deps, localName);
    }
    return;
  }

  const ok = await confirm(
    vscode.l10n.t(
      "Create local branch '{0}' from '{1}' and checkout?",
      localName,
      remoteBranch
    ),
    vscode.l10n.t("Create and Checkout")
  );
  if (!ok) {
    return;
  }

  try {
    await deps.logService.checkoutRemoteBranchAsLocal(remoteBranch);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    const result = await retryCheckoutWithConflicts(
      err,
      deps.logService.repoRoot,
      remoteBranch,
      () => deps.logService.checkoutRemoteBranchAsLocal(remoteBranch, true).then(() => undefined)
    );
    if (result === "cancelled") {
      return;
    }
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return;
    }
    if (result === "conflicts") {
      return;
    }
  }

  await deps.refreshCheckout();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' created and checked out.", localName)
  );
}

/**
 * 선택 커밋에서 새 브랜치를 만든다.
 * - staged/ongoing 같은 가상 커밋은 브랜치 시작점으로 사용할 수 없어서 호출부 검증 함수를 받는다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param hash 브랜치를 만들 실제 커밋 해시
 * @param isRealCommit 가상 커밋 여부를 판별하는 함수
 */
export async function createBranch(
  deps: GraphBranchActionDeps,
  hash: string,
  isRealCommit: (hash: string) => boolean
): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name"),
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Branch name is required."),
  });
  if (!name) {
    return;
  }
  await deps.logService.createBranchAt(name.trim(), hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' created.", name.trim())
  );
}

/**
 * 브랜치 chip 의 빠른 액션 메뉴를 보여준다.
 * - 로컬 브랜치에서는 checkout, clone, clone 후 checkout 을 제공한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param branch 사용자가 클릭한 브랜치 이름
 * @param kind 로컬/원격 브랜치 종류
 */
export async function branchAction(
  deps: GraphBranchActionDeps,
  branch: string,
  kind: BranchKind
): Promise<void> {
  if (kind === "remote") {
    return;
  }
  const pick = await vscode.window.showQuickPick<BranchQuickPickItem>(
    [
      { label: vscode.l10n.t("Checkout Branch"), action: "checkout" },
      {
        label: vscode.l10n.t("Clone Branch"),
        description: vscode.l10n.t("Create a local branch at this branch."),
        action: "clone",
      },
      {
        label: vscode.l10n.t("Clone and Checkout Branch"),
        description: vscode.l10n.t("Create a rebase test branch and switch to it."),
        action: "cloneCheckout",
      },
    ],
    { placeHolder: branch }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "checkout") {
    await checkoutBranch(deps, branch);
    return;
  }
  await cloneBranch(deps, branch, pick.action === "cloneCheckout");
}

/**
 * 로컬/원격 브랜치를 삭제한다.
 * - 브랜치를 넘기지 않으면 전체 브랜치 목록에서 사용자가 삭제 대상을 고른다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param branchName 즉시 삭제할 브랜치 이름. 생략하면 picker 를 띄운다.
 * @param kind branchName 이 있을 때 사용할 브랜치 종류
 */
export async function deleteBranch(
  deps: GraphBranchActionDeps,
  branchName?: string,
  kind?: BranchKind
): Promise<void> {
  const branch = branchName
    ? { name: branchName, kind: kind ?? branchKind(branchName) }
    : await pickBranch(deps);
  if (!branch) {
    return;
  }
  const label =
    branch.kind === "remote"
      ? vscode.l10n.t("Delete remote branch '{0}'?", branch.name)
      : vscode.l10n.t("Delete local branch '{0}'?", branch.name);
  if (!(await confirm(label, vscode.l10n.t("Delete")))) {
    return;
  }
  if (branch.kind === "remote") {
    await deps.logService.deleteRemoteBranch(branch.name);
  } else {
    await deps.logService.deleteLocalBranch(branch.name);
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' deleted.", branch.name)
  );
}

/**
 * 소스 브랜치와 같은 커밋을 가리키는 테스트용 로컬 브랜치를 만든다.
 * - rebase 테스트를 빠르게 시작할 수 있도록 기본 이름은 `{source}-rebase-test` 로 제안한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param sourceBranch 복제 기준이 되는 로컬 브랜치 이름
 * @param checkoutAfter true 면 생성 직후 새 브랜치로 checkout 한다.
 */
export async function cloneBranch(
  deps: GraphBranchActionDeps,
  sourceBranch: string,
  checkoutAfter: boolean
): Promise<void> {
  const source = await findLocalBranch(deps, sourceBranch);
  if (!source) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Branch not found: {0}", sourceBranch)
    );
    return;
  }
  if (checkoutAfter) {
    await deps.logService.ensureCheckoutAllowed();
  }
  const existingNames = new Set(
    (await deps.logService.getBranches()).map((branch) => branch.name)
  );
  const name = await vscode.window.showInputBox({
    prompt: checkoutAfter
      ? vscode.l10n.t("New branch name to clone and checkout")
      : vscode.l10n.t("New branch name to clone"),
    value: nextCloneBranchName(source.name, existingNames),
    validateInput: (value) =>
      validateCloneBranchName(value, source.name, existingNames),
  });
  const targetName = name?.trim();
  if (!targetName) {
    return;
  }

  logInfo("graph branch clone started", {
    repoRoot: deps.logService.repoRoot,
    sourceBranch: source.name,
    targetBranch: targetName,
    checkoutAfter,
  });
  await deps.logService.createBranchAt(targetName, source.name);
  logInfo("graph branch clone created", {
    repoRoot: deps.logService.repoRoot,
    sourceBranch: source.name,
    targetBranch: targetName,
  });

  if (checkoutAfter) {
    const checkedOut = await checkoutBranch(deps, targetName);
    if (!checkedOut) {
      await deps.refreshGraph();
    }
    return;
  }

  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' cloned from '{1}'.", targetName, source.name)
  );
}

/**
 * 로컬 브랜치 목록에서 이름이 일치하는 항목을 찾는다.
 * @param deps graph 패널이 제공하는 git service
 * @param branchName 찾을 로컬 브랜치 이름
 * @returns 브랜치 상태. 없으면 undefined
 */
async function findLocalBranch(
  deps: GraphBranchActionDeps,
  branchName: string
): Promise<LocalBranchStatus | undefined> {
  return (await deps.logService.getLocalBranches()).find(
    (item) => item.name === branchName
  );
}

/**
 * 브랜치 목록에서 삭제 대상을 고른다.
 * @param deps graph 패널이 제공하는 git service
 * @returns 사용자가 고른 브랜치 이름과 종류. 취소하면 undefined
 */
async function pickBranch(
  deps: GraphBranchActionDeps
): Promise<{ name: string; kind: BranchKind } | undefined> {
  const branches = await deps.logService.getBranches();
  const pick = await vscode.window.showQuickPick(
    branches.map((branch) => ({
      label: branch.name,
      description: branch.kind,
      branch,
    })),
    { placeHolder: vscode.l10n.t("Select a branch") }
  );
  return pick?.branch;
}

/**
 * 확인이 필요한 파괴적/상태 변경 작업을 모달로 확인한다.
 * @param message 사용자에게 보여줄 확인 문구
 * @param label 승인 버튼 라벨
 * @returns 승인 버튼을 눌렀으면 true
 */
async function confirm(message: string, label: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}

/**
 * 원격 브랜치처럼 보이는 이름이면 remote 로 간주한다.
 * @param name 브랜치 short name
 * @returns 로컬/원격 브랜치 종류
 */
function branchKind(name: string): BranchKind {
  return name.includes("/") ? "remote" : "local";
}

/**
 * origin/feature 형태의 remote ref 에서 feature 를 로컬 브랜치명으로 사용한다.
 * @param remoteBranch 원격 브랜치 short name
 * @returns 로컬 브랜치로 만들 이름
 */
function localNameForRemoteBranch(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash >= 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
}

/**
 * clone 대상 브랜치의 기본 이름을 만든다. 이미 있으면 숫자 suffix 를 붙인다.
 * @param sourceBranch 복제 기준 브랜치 이름
 * @param existingNames 이미 존재하는 로컬/원격 브랜치 이름 집합
 * @returns 충돌하지 않는 기본 clone 브랜치 이름
 */
function nextCloneBranchName(sourceBranch: string, existingNames: Set<string>): string {
  const base = `${sourceBranch}-rebase-test`;
  if (!existingNames.has(base)) {
    return base;
  }
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * clone 브랜치 입력값을 즉시 검증해 중복 생성과 빈 이름을 막는다.
 * @param value 사용자가 입력한 브랜치 이름
 * @param sourceBranch 복제 기준 브랜치 이름
 * @param existingNames 이미 존재하는 로컬/원격 브랜치 이름 집합
 * @returns 오류 문구. 유효하면 undefined
 */
function validateCloneBranchName(
  value: string,
  sourceBranch: string,
  existingNames: Set<string>
): string | undefined {
  const name = value.trim();
  if (!name) {
    return vscode.l10n.t("Branch name is required.");
  }
  if (name === sourceBranch) {
    return vscode.l10n.t("Clone branch name must differ from '{0}'.", sourceBranch);
  }
  if (existingNames.has(name)) {
    return vscode.l10n.t("Branch '{0}' already exists.", name);
  }
  return undefined;
}
