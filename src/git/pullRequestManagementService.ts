// Pull Request 관리 metadata의 GitHub REST/GraphQL mutation 서비스.
// - assignee/label/reviewer/draft 상태 변경 뒤 대상 PR을 다시 읽어 GitHub가 실제 반영한 상태를 결과로 돌려준다.
// - UI는 이 서비스의 partial mismatch를 권한 부족이나 동시 변경으로 구분해 표시할 수 있다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";

/** management mutation이 적용될 하나의 repository/PR 대상. */
export interface PullRequestManagementTarget {
  /** owner/name 형태 GitHub repository */
  repository: string;
  /** Pull Request 번호 */
  number: number;
  /** Draft/Ready GraphQL mutation에 필요한 Pull Request node id */
  pullRequestId?: string;
}

/** 지원하는 안전한 assignee/label/reviewer/stage 변경 종류. */
export type PullRequestManagementMutation =
  | { kind: "addAssignees"; logins: string[] }
  | { kind: "removeAssignees"; logins: string[] }
  | { kind: "addLabels"; names: string[] }
  | { kind: "removeLabels"; names: string[] }
  | { kind: "requestReviewers"; reviewers: string[]; teamReviewers: string[] }
  | { kind: "removeReviewers"; reviewers: string[]; teamReviewers: string[] }
  | { kind: "setDraftState"; isDraft: boolean }
  | { kind: "setMilestone"; milestoneNumber: number | null };

/** PR issue에 연결된 milestone의 검증·표시용 최소 정보. */
export interface PullRequestMilestone {
  /** repository 안에서 고유한 milestone 번호 */
  number: number;
  /** 화면에 표시할 milestone 제목 */
  title: string;
}

/** 현재 review request의 GitHub 사용자/팀 구분과 화면 표시 정보. */
export interface PullRequestRequestedReviewer {
  /** REST 응답의 users 또는 teams 출처 */
  kind: "user" | "team";
  /** user login 또는 team slug인 mutation 식별자 */
  key: string;
  /** 팀은 사람 친화적인 name, 사용자는 login */
  label: string;
}

/** authoritative verification 뒤 UI가 표시할 현재 관리 metadata. */
export interface PullRequestManagementMetadata {
  /** GitHub issue assignee login의 정렬된 목록 */
  assignees: string[];
  /** GitHub issue label name의 정렬된 목록 */
  labels: string[];
  /** 현재 review request를 받은 사용자와 팀 */
  requestedReviewers: PullRequestRequestedReviewer[];
  /** PR이 Draft 상태인지 여부 */
  isDraft: boolean;
  /** GitHub issue에 설정된 milestone. 없으면 undefined */
  milestone?: PullRequestMilestone;
}

/** 한 management mutation의 서버 재조회 결과와 불일치 항목. */
export interface PullRequestManagementResult {
  /** 실제 REST mutation이 적용된 대상 */
  target: PullRequestManagementTarget;
  /** 호출자가 요청한 mutation */
  mutation: PullRequestManagementMutation;
  /** mutation 직후 GitHub에서 재조회한 metadata */
  metadata: PullRequestManagementMetadata;
  /** 기대 상태와 다른 assignee/label 이름 */
  mismatches: string[];
  /** expected 상태가 모두 authoritative read에 반영됐는지 */
  verified: boolean;
}

/** preview 단계에서 사용자에게 보여 줄 실제 적용·이미 원하는 상태의 값 목록. */
export interface PullRequestManagementPreview {
  /** 정규화된 요청 mutation */
  mutation: PullRequestManagementMutation;
  /** 현재 상태를 실제로 바꿀 값 */
  willApply: string[];
  /** 현재 이미 원하는 상태여서 write하지 않을 값 */
  alreadySet: string[];
  /** 확인 button을 활성화할 실제 write가 있는지 */
  canApply: boolean;
}

/** REST issue 응답에서 서비스가 쓰는 최소 JSON 필드. */
interface GhIssueMetadataResponse {
  assignees?: Array<{ login?: string } | null>;
  labels?: Array<{ name?: string } | null>;
  milestone?: { number?: number; title?: string } | null;
}

/** requested_reviewers endpoint의 최소 REST 응답. */
interface GhRequestedReviewersResponse {
  users?: Array<{ login?: string } | null>;
  teams?: Array<{ slug?: string; name?: string } | null>;
}

/** Pull Request endpoint에서 verification에 필요한 최소 응답. */
interface GhPullRequestStateResponse {
  draft?: boolean;
}

/** assignee·label write와 post-read verification을 담당하는 GitHub 관리 서비스. */
export class PullRequestManagementService {
  /** 실제 gh 대신 fixture runner를 주입해 write/read 순서를 검증할 수 있다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /**
   * 하나의 assignee/label mutation을 실행하고 GitHub authoritative metadata로 검증한다.
   * @param target   repository와 PR 번호
   * @param mutation 추가/제거할 metadata 변화
   * @param signal   화면 dispose나 더 최신 mutation이 시작됐을 때의 취소 신호
   * @returns 실제 metadata와 silently ignored된 값까지 담은 결과
   */
  public async apply(
    target: PullRequestManagementTarget,
    mutation: PullRequestManagementMutation,
    signal?: AbortSignal
  ): Promise<PullRequestManagementResult> {
    validateTarget(target);
    const values = mutationValues(mutation);
    const normalized = normalizeValues(values);
    if (!normalized.length && mutation.kind !== "setDraftState" && mutation.kind !== "setMilestone") {
      throw new Error("Choose at least one assignee or label before applying management changes.");
    }
    const normalizedMutation = normalizeMutation(mutation, normalized);
    await this.runMutation(target, normalizedMutation, signal);
    const metadata = await this.readMetadata(target, signal);
    const mismatches = findMismatches(normalizedMutation, metadata);
    return { target, mutation: normalizedMutation, metadata, mismatches, verified: mismatches.length === 0 };
  }

  /** 대상 PR의 issue metadata·review requests·draft 상태를 authoritative source에서 재조회한다. */
  public async readMetadata(target: PullRequestManagementTarget, signal?: AbortSignal): Promise<PullRequestManagementMetadata> {
    validateTarget(target);
    const [issue, reviewers, pullRequest] = await Promise.all([
      this.runner.runJson<GhIssueMetadataResponse>(
      ["api", issueRoute(target)],
      this.repoRoot,
      { operation: "review.management.metadata.read", signal }
      ),
      this.runner.runJson<GhRequestedReviewersResponse>(
        ["api", requestedReviewersRoute(target)],
        this.repoRoot,
        { operation: "review.management.reviewers.read", signal }
      ),
      this.runner.runJson<GhPullRequestStateResponse>(
        ["api", pullRequestRoute(target)],
        this.repoRoot,
        { operation: "review.management.stage.read", signal }
      ),
    ]);
    const milestone = normalizeMilestone(issue.milestone);
    return {
      assignees: normalizeField(issue.assignees, "login"),
      labels: normalizeField(issue.labels, "name"),
      requestedReviewers: normalizeRequestedReviewers(reviewers),
      isDraft: Boolean(pullRequest.draft),
      ...(milestone ? { milestone } : {}),
    };
  }

  /** mutation 종류를 GitHub REST method/route/body로 조립한다. */
  private async runMutation(
    target: PullRequestManagementTarget,
    mutation: PullRequestManagementMutation,
    signal?: AbortSignal
  ): Promise<void> {
    const route = issueRoute(target);
    switch (mutation.kind) {
      case "addAssignees":
        await this.runner.run(["api", "-X", "POST", route, ...arrayFields("assignees", mutation.logins)], this.repoRoot, { operation: "review.management.assignees.add", signal });
        return;
      case "removeAssignees":
        await this.runner.run(["api", "-X", "DELETE", route + "/assignees", ...arrayFields("assignees", mutation.logins)], this.repoRoot, { operation: "review.management.assignees.remove", signal });
        return;
      case "addLabels":
        await this.runner.run(["api", "-X", "POST", route + "/labels", ...arrayFields("labels", mutation.names)], this.repoRoot, { operation: "review.management.labels.add", signal });
        return;
      case "removeLabels":
        for (const name of mutation.names) {
          await this.runner.run(["api", "-X", "DELETE", `${route}/labels/${encodeURIComponent(name)}`], this.repoRoot, { operation: "review.management.labels.remove", signal });
        }
        return;
      case "requestReviewers":
        await this.runner.run(
          ["api", "-X", "POST", requestedReviewersRoute(target), ...arrayFields("reviewers", mutation.reviewers), ...arrayFields("team_reviewers", mutation.teamReviewers)],
          this.repoRoot,
          { operation: "review.management.reviewers.request", signal }
        );
        return;
      case "removeReviewers":
        await this.runner.run(
          ["api", "-X", "DELETE", requestedReviewersRoute(target), ...arrayFields("reviewers", mutation.reviewers), ...arrayFields("team_reviewers", mutation.teamReviewers)],
          this.repoRoot,
          { operation: "review.management.reviewers.remove", signal }
        );
        return;
      case "setDraftState":
        await this.setDraftState(target, mutation.isDraft, signal);
        return;
      case "setMilestone":
        await this.runner.run(
          ["api", "-X", "PATCH", route, "-F", `milestone=${mutation.milestoneNumber === null ? "null" : mutation.milestoneNumber}`],
          this.repoRoot,
          { operation: "review.management.milestone.set", signal }
        );
        return;
    }
  }

  /** Draft/Ready GraphQL mutation을 node id로 실행한다. */
  private async setDraftState(target: PullRequestManagementTarget, isDraft: boolean, signal?: AbortSignal): Promise<void> {
    const pullRequestId = target.pullRequestId?.trim();
    if (!pullRequestId) throw new Error("Pull request node id is required to update its draft state.");
    const mutationName = isDraft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const query = `mutation($pullRequestId: ID!) { ${mutationName}(input: { pullRequestId: $pullRequestId }) { clientMutationId } }`;
    await this.runner.runJson(
      ["api", "graphql", "-F", `pullRequestId=${pullRequestId}`, "-f", `query=${query}`],
      this.repoRoot,
      { operation: isDraft ? "review.management.stage.draft" : "review.management.stage.ready", signal }
    );
  }
}

/**
 * 현재 metadata와 요청 mutation을 비교해 user-visible confirmation preview를 만든다.
 * @param metadata GitHub에서 마지막으로 읽은 authoritative assignee/label 상태
 * @param mutation 사용자가 요청한 추가/제거 mutation
 * @returns 실제 write 대상과 no-op 값을 구분한 preview
 */
export function previewPullRequestManagementMutation(
  metadata: PullRequestManagementMetadata,
  mutation: PullRequestManagementMutation
): PullRequestManagementPreview {
  const normalized = normalizeMutation(mutation, normalizeValues(mutationValues(mutation)));
  const values = mutationValues(normalized);
  if (!values.length && normalized.kind !== "setDraftState" && normalized.kind !== "setMilestone") {
    throw new Error("Choose at least one assignee or label before previewing management changes.");
  }
  const current = previewCurrentValues(metadata, normalized);
  const shouldExist = wantsPresentState(normalized);
  const currentSet = new Set(current);
  const willApply = normalized.kind === "setDraftState"
    ? (metadata.isDraft === normalized.isDraft ? [] : [normalized.isDraft ? "Draft" : "Ready for review"])
    : normalized.kind === "setMilestone"
      ? ((metadata.milestone?.number ?? null) === normalized.milestoneNumber ? [] : [milestonePreviewLabel(normalized.milestoneNumber)])
    : values.filter((value) => currentSet.has(value) !== shouldExist);
  const alreadySet = values.filter((value) => !willApply.includes(value));
  if (normalized.kind === "setDraftState" && !willApply.length) alreadySet.push(normalized.isDraft ? "Draft" : "Ready for review");
  if (normalized.kind === "setMilestone" && !willApply.length) alreadySet.push(milestonePreviewLabel(normalized.milestoneNumber));
  return { mutation: normalized, willApply, alreadySet, canApply: willApply.length > 0 };
}

/**
 * 승인된 preview에서 실제 상태 변화를 만드는 값만 mutation으로 다시 조립한다.
 * @param preview 확인 UI에 표시했던 metadata 변경 preview
 * @returns already-set 값을 제외한 최소 GitHub write 요청
 */
export function managementMutationToApply(preview: PullRequestManagementPreview): PullRequestManagementMutation {
  return normalizeMutation(preview.mutation, preview.willApply);
}

/** owner/name과 양수 PR 번호가 GitHub REST route로 안전한지 확인한다. */
function validateTarget(target: PullRequestManagementTarget): void {
  const [owner, name, extra] = target.repository.trim().split("/");
  if (!owner || !name || extra || !Number.isInteger(target.number) || target.number <= 0) {
    throw new Error("A valid repository and pull request number are required for management changes.");
  }
}

/** Pull Request를 Issue API metadata route로 바꾼다. */
function issueRoute(target: PullRequestManagementTarget): string {
  return `repos/${target.repository}/issues/${target.number}`;
}

/** review request REST endpoint를 대상 PR route로 조립한다. */
function requestedReviewersRoute(target: PullRequestManagementTarget): string {
  return `repos/${target.repository}/pulls/${target.number}/requested_reviewers`;
}

/** Draft verification에 쓰는 Pull Request REST endpoint를 대상 route로 조립한다. */
function pullRequestRoute(target: PullRequestManagementTarget): string {
  return `repos/${target.repository}/pulls/${target.number}`;
}

/** 공백·중복을 제거해 GitHub REST body에 보낼 안정된 이름 목록을 만든다. */
function normalizeValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/** 동일 union type에서 정규화한 값만 다시 넣어 호출자와 결과를 일관되게 만든다. */
function normalizeMutation(mutation: PullRequestManagementMutation, values: string[]): PullRequestManagementMutation {
  switch (mutation.kind) {
    case "addAssignees": return { kind: mutation.kind, logins: values };
    case "removeAssignees": return { kind: mutation.kind, logins: values };
    case "addLabels": return { kind: mutation.kind, names: values };
    case "removeLabels": return { kind: mutation.kind, names: values };
    case "requestReviewers": return splitReviewerMutation(mutation.kind, values);
    case "removeReviewers": return splitReviewerMutation(mutation.kind, values);
    case "setDraftState": return mutation;
    case "setMilestone": return mutation;
  }
}

/** union narrowing을 한곳에 모아 assignee/label 대상 이름을 반환한다. */
function mutationValues(mutation: PullRequestManagementMutation): string[] {
  switch (mutation.kind) {
    case "addAssignees":
    case "removeAssignees":
      return mutation.logins;
    case "addLabels":
    case "removeLabels":
      return mutation.names;
    case "requestReviewers":
    case "removeReviewers":
      return [...mutation.reviewers.map((value) => `user:${value}`), ...mutation.teamReviewers.map((value) => `team:${value}`)];
    case "setDraftState":
      return [];
    case "setMilestone":
      return [];
  }
}

/** `gh api -f key[]=value` 인자를 반복 field로 조립한다. */
function arrayFields(name: string, values: readonly string[]): string[] {
  return values.flatMap((value) => ["-f", `${name}[]=${value}`]);
}

/** nullable REST object 배열의 한 문자열 필드만 안전하게 정규화한다. */
function normalizeField(
  values: ReadonlyArray<{ login?: string; name?: string } | null> | undefined,
  key: "login" | "name"
): string[] {
  return normalizeValues((values || []).map((value) => value?.[key] || ""));
}

/** write 뒤 기대한 포함/제거 상태와 authoritative metadata를 비교한다. */
function findMismatches(mutation: PullRequestManagementMutation, metadata: PullRequestManagementMetadata): string[] {
  const values = mutationValues(mutation);
  if (mutation.kind === "setDraftState") {
    return metadata.isDraft === mutation.isDraft ? [] : [mutation.isDraft ? "Draft" : "Ready for review"];
  }
  if (mutation.kind === "setMilestone") {
    return (metadata.milestone?.number ?? null) === mutation.milestoneNumber ? [] : [milestonePreviewLabel(mutation.milestoneNumber)];
  }
  const current = previewCurrentValues(metadata, mutation);
  const shouldExist = wantsPresentState(mutation);
  const currentSet = new Set(current);
  return values.filter((value) => currentSet.has(value) !== shouldExist);
}

/** reviewers string에 user:/team: 안정 prefix를 붙여 current metadata와 비교한다. */
function splitReviewerMutation(
  kind: "requestReviewers" | "removeReviewers",
  values: readonly string[]
): PullRequestManagementMutation {
  return {
    kind,
    reviewers: values.filter((value) => value.startsWith("user:")).map((value) => value.slice("user:".length)),
    teamReviewers: values.filter((value) => value.startsWith("team:")).map((value) => value.slice("team:".length)),
  };
}

/** preview/verification에서 mutation 종류에 맞는 현재 state key 목록을 얻는다. */
function previewCurrentValues(metadata: PullRequestManagementMetadata, mutation: PullRequestManagementMutation): string[] {
  switch (mutation.kind) {
    case "addAssignees":
    case "removeAssignees": return metadata.assignees;
    case "addLabels":
    case "removeLabels": return metadata.labels;
    case "requestReviewers":
    case "removeReviewers": return metadata.requestedReviewers.map((reviewer) => `${reviewer.kind}:${reviewer.key}`);
    case "setDraftState": return [];
    case "setMilestone": return [];
  }
}

/** 추가/request mutation은 존재, 제거 mutation은 부재를 기대하는지 판단한다. */
function wantsPresentState(mutation: PullRequestManagementMutation): boolean {
  return mutation.kind === "addAssignees" || mutation.kind === "addLabels" || mutation.kind === "requestReviewers";
}

/** GitHub issue metadata의 nullable milestone을 안정된 화면 모델로 정규화한다. */
function normalizeMilestone(value: GhIssueMetadataResponse["milestone"]): PullRequestMilestone | undefined {
  const number = Number(value?.number);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { number, title: value?.title?.trim() || `Milestone #${number}` };
}

/** preview와 mismatch에 동일하게 쓸 milestone 대상의 짧은 표시값을 만든다. */
function milestonePreviewLabel(number: number | null): string {
  return number === null ? "No milestone" : `Milestone #${number}`;
}

/** REST requested reviewers users/teams를 중복 없이 안정된 화면 모델로 바꾼다. */
function normalizeRequestedReviewers(response: GhRequestedReviewersResponse): PullRequestRequestedReviewer[] {
  const reviewers = new Map<string, PullRequestRequestedReviewer>();
  for (const user of response.users || []) {
    const login = user?.login?.trim();
    if (login) reviewers.set(`user:${login}`, { kind: "user", key: login, label: login });
  }
  for (const team of response.teams || []) {
    const slug = team?.slug?.trim();
    if (slug) reviewers.set(`team:${slug}`, { kind: "team", key: slug, label: team?.name?.trim() || slug });
  }
  return [...reviewers.values()].sort((left, right) => left.label.localeCompare(right.label));
}
