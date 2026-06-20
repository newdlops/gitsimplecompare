// push 전에 사용자 확인이 필요한 계획을 설명하는 UI 보조 모듈.
// - git 서비스는 VS Code API 를 모르도록 유지하고, 사용자에게 보여줄 설명/확인은 UI 계층에서 담당한다.
import * as vscode from "vscode";
import type {
  ForcePushMode,
  PushCurrentPlan,
  SetUpstreamPushCurrentPlan,
} from "../git/pushService";

/**
 * 현재 push 계획이 remote branch 생성 또는 upstream 변경을 포함하면 사용자 확인을 받는다.
 * - plain push 는 기존 git 설정 그대로 실행되므로 별도 확인 없이 true 를 반환한다.
 * - setUpstream push 는 remote branch 가 없으면 새로 생성될 수 있음을 detail 로 설명한다.
 * @param plan pushService 가 계산한 현재 브랜치 push 계획
 * @returns 사용자가 확인했거나 확인이 필요 없으면 true, 취소했으면 false
 */
export async function confirmPushCurrentPlan(
  plan: PushCurrentPlan
): Promise<boolean> {
  if (plan.mode === "plain") {
    return true;
  }
  const confirm = vscode.l10n.t("Push and Set Upstream");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Push branch '{0}' to remote branch '{1}'?",
      plan.branch,
      plan.targetUpstream
    ),
    { modal: true, detail: pushPlanDetail(plan) },
    confirm
  );
  return choice === confirm;
}

/**
 * force push 실행 전 위험을 설명하고 사용할 force 옵션을 고르게 한다.
 * - `--force-with-lease` 는 마지막 fetch 이후 remote 가 바뀌었으면 실패하므로 기본 권장 선택지로 둔다.
 * - `--force` 는 remote 변경을 덮어쓸 수 있으므로 같은 모달에서 명시적으로만 선택하게 한다.
 * @param plan pushService 가 계산한 현재 브랜치 push 계획
 * @returns 사용자가 선택한 force 옵션. 취소하면 undefined
 */
export async function confirmForcePushCurrentPlan(
  plan: PushCurrentPlan
): Promise<ForcePushMode | undefined> {
  const withLease = vscode.l10n.t("Force Push With Lease");
  const force = vscode.l10n.t("Force Push");
  const choice = await vscode.window.showWarningMessage(
    forcePushTitle(plan),
    { modal: true, detail: forcePushDetail(plan) },
    withLease,
    force
  );
  if (choice === withLease) {
    return "forceWithLease";
  }
  return choice === force ? "force" : undefined;
}

/**
 * upstream 설정 push 에 대한 설명 문구를 만든다.
 * - 기존 upstream 이 있으면 변경 전/후를 함께 보여주고, 없으면 새 upstream 만 보여준다.
 * @param plan upstream 설정 push 계획
 * @returns 확인 모달 detail 문구
 */
function pushPlanDetail(plan: SetUpstreamPushCurrentPlan): string {
  if (plan.upstream) {
    return vscode.l10n.t(
      "Current upstream: {0}\nNew upstream: {1}\nIf the new remote branch does not exist, Git will create it.",
      plan.upstream,
      plan.targetUpstream
    );
  }
  return vscode.l10n.t(
    "New upstream: {0}\nIf this remote branch does not exist, Git will create it.",
    plan.targetUpstream
  );
}

/**
 * force push 경고 모달의 제목을 만든다.
 * @param plan 현재 push 대상 계획
 * @returns 브랜치 정보가 있으면 포함한 경고 제목
 */
function forcePushTitle(plan: PushCurrentPlan): string {
  if (plan.branch) {
    return vscode.l10n.t(
      "Force push branch '{0}'? This can overwrite remote commits.",
      plan.branch
    );
  }
  return vscode.l10n.t(
    "Force push the current branch? This can overwrite remote commits."
  );
}

/**
 * force push 옵션 차이와 대상 upstream 정보를 설명한다.
 * @param plan 현재 push 대상 계획
 * @returns 확인 모달 detail 문구
 */
function forcePushDetail(plan: PushCurrentPlan): string {
  const target = plan.mode === "setUpstream"
    ? vscode.l10n.t("Target remote branch: {0}", plan.targetUpstream)
    : plan.upstream
    ? vscode.l10n.t("Current upstream: {0}", plan.upstream)
    : vscode.l10n.t("Git will use the current branch push target.");
  return vscode.l10n.t(
    "{0}\n\nChoose '{1}' to use --force-with-lease. It refuses to overwrite the remote branch if it changed since your last fetch.\nChoose '{2}' to use --force. It may overwrite remote commits.",
    target,
    vscode.l10n.t("Force Push With Lease"),
    vscode.l10n.t("Force Push")
  );
}
