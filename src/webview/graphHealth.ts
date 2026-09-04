// Git Graph가 일부 손상 또는 조회 실패를 만났을 때 사용자에게 복구 가능한 상태를 설명하는 모듈.
// - 패널 생명주기와 Git 조회는 건드리지 않고, 상태 안내 메시지와 OUTPUT 진단만 조립한다.
import * as vscode from "vscode";
import type { GraphInvalidRef } from "../graph/graphTypes";
import { logWarn } from "../ui/outputLog";
import type { GraphHealthNotice, ToWebviewMessage } from "./graphProtocol";

/** Graph 상태 안내만 보낼 수 있도록 제한한 웹뷰 게시 함수다. */
type GraphHealthPost = (
  message: Extract<ToWebviewMessage, { type: "graphHealth" }>
) => void;

/**
 * 손상 로컬 ref를 OUTPUT에 기록하고 정상 Graph가 유지된다는 경고를 웹뷰에 보낸다.
 * - ref를 자동 수정하거나 삭제하지 않아 복구 가능성을 보존한다.
 * @param repoRoot 진단 로그에 남길 저장소 루트
 * @param refs 누락 object를 가리켜 Graph 범위에서 제외한 로컬 ref 목록
 * @param post Graph 웹뷰로 타입 안전한 메시지를 보내는 함수
 */
export function publishInvalidGraphRefs(
  repoRoot: string,
  refs: readonly GraphInvalidRef[],
  post: GraphHealthPost
): void {
  if (refs.length === 0) {
    post({ type: "graphHealth" });
    return;
  }
  const items = refs.map((ref) => ({
    label: ref.name,
    description: `${ref.fullRef} → ${ref.hash}`,
  }));
  logWarn("graph invalid local refs skipped", {
    repoRoot,
    count: items.length,
    refs: items.map((item) => item.description),
  });
  post({
    type: "graphHealth",
    notice: {
      level: "warning",
      title: vscode.l10n.t("Damaged local branch refs were skipped ({0}).", items.length),
      detail: vscode.l10n.t(
        "The remaining graph is available. Restore or delete these refs, then refresh."
      ),
      items,
    },
  });
}

/**
 * 초기 로드와 후속 새로고침을 구분해 사용자가 현재 Graph 보존 여부를 알 수 있는 오류를 만든다.
 * @param error Git 조회 또는 fingerprint 단계에서 발생한 원본 오류
 * @param hasExistingGraph 이미 표시 중인 커밋이 있어 그대로 보존되는지 여부
 * @returns 웹뷰 상단에 표시할 오류 수준 Graph 상태 안내
 */
export function createGraphRefreshErrorNotice(
  error: unknown,
  hasExistingGraph: boolean
): GraphHealthNotice {
  const guidance = hasExistingGraph
    ? vscode.l10n.t("Existing commits remain visible. Check Git Simple Compare Output, then refresh.")
    : vscode.l10n.t("Check Git Simple Compare Output, repair the repository state, then refresh.");
  return {
    level: "error",
    title: hasExistingGraph
      ? vscode.l10n.t("Git graph refresh failed.")
      : vscode.l10n.t("Git graph could not be loaded."),
    detail: `${guidance} ${vscode.l10n.t("Reason: {0}", graphErrorSummary(error))}`,
  };
}

/**
 * 긴 GitError에서 사용자가 즉시 이해할 첫 fatal/첫 행만 추려 상태 문구 길이를 제한한다.
 * @param error Error 또는 알 수 없는 throw 값
 * @returns 줄바꿈이 제거된 최대 240자 오류 요약
 */
export function graphErrorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = lines.find((line) => line.startsWith("fatal:")) ?? lines[0] ?? "Unknown Git error";
  const compact = summary.replace(/^fatal:\s*/i, "").replace(/\s+/g, " ");
  return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact;
}
