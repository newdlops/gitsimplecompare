// Review Center와 Reviews sidebar가 공유하는 management form 입력 정규화기.
// - 웹뷰의 문자열 선택값을 서비스가 검증하는 mutation 도메인 객체로만 변환하고 GitHub I/O는 수행하지 않는다.
import type { PullRequestManagementMutation } from "../git/pullRequestManagementService";

/** management form과 webview protocol이 공통으로 쓰는 사용자 선택 operation. */
export type PullRequestManagementInputKind =
  | "addAssignees" | "removeAssignees" | "addLabels" | "removeLabels"
  | "requestReviewers" | "removeReviewers" | "setDraft" | "setReady"
  | "setMilestone" | "clearMilestone";

/** comma로 이미 분리된 UI 값을 검증 가능한 management mutation으로 바꾼다. */
export function managementMutationFromInput(
  kind: PullRequestManagementInputKind,
  values: readonly string[]
): PullRequestManagementMutation {
  if (kind === "addAssignees" || kind === "removeAssignees") return { kind, logins: [...values] };
  if (kind === "addLabels" || kind === "removeLabels") return { kind, names: [...values] };
  if (kind === "setDraft") return { kind: "setDraftState", isDraft: true };
  if (kind === "setReady") return { kind: "setDraftState", isDraft: false };
  if (kind === "setMilestone") {
    const number = Number(values[0]);
    if (!Number.isInteger(number) || number <= 0) throw new Error("Enter a positive milestone number.");
    return { kind: "setMilestone", milestoneNumber: number };
  }
  if (kind === "clearMilestone") return { kind: "setMilestone", milestoneNumber: null };
  const reviewers = values.filter((value) => !value.startsWith("team:")).map((value) => value.replace(/^@/, ""));
  const teamReviewers = values.filter((value) => value.startsWith("team:")).map((value) => value.slice("team:".length));
  return { kind, reviewers, teamReviewers };
}
