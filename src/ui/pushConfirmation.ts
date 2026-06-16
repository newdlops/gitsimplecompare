// push 전에 사용자 확인이 필요한 계획을 설명하는 UI 보조 모듈.
// - git 서비스는 VS Code API 를 모르도록 유지하고, 사용자에게 보여줄 설명/확인은 UI 계층에서 담당한다.
import * as vscode from "vscode";
import type {
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
