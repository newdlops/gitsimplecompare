// Pull Request 최신 head commit의 GitHub check/status rollup과 branch protection을 읽는 서비스.
// - protection endpoint가 성공한 경우에만 Required를 확정하고, 권한·capability 실패에서는 All checks를 유지하며 unknown으로 남긴다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";

const CHECKS_LIMIT = 100;

const PULL_REQUEST_CHECKS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: $limit) {
                nodes {
                  ... on CheckRun { name status conclusion detailsUrl startedAt completedAt workflowName }
                  ... on StatusContext { context state targetUrl createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** check UI가 상태 역할에 따라 일관되게 표시할 안전한 bucket. */
export type PullRequestCheckBucket = "success" | "failure" | "pending" | "skipped" | "cancelled" | "unknown";

/** 한 CheckRun 또는 legacy StatusContext의 renderer-safe read model. */
export interface PullRequestReviewCheck {
  /** name/workflow를 합친 안정된 화면 식별자 */
  id: string;
  /** 사용자에게 보여 줄 check 이름 */
  name: string;
  /** workflow가 제공될 때 보조 문맥 */
  workflow?: string;
  /** success/failure/pending 같은 semantic 상태 */
  bucket: PullRequestCheckBucket;
  /** GitHub 원문 status/conclusion/state */
  state: string;
  /** 상세 GitHub run으로 이동할 안전한 URL */
  url?: string;
  /** 시작 또는 생성 시각 */
  startedAt?: string;
  /** 완료 시각 */
  completedAt?: string;
  /** branch protection이 이름으로 확정한 required status check인지 여부 */
  isRequired: boolean;
}

/** 최신 head check 목록과 branch protection 기반 required/policy 읽기 결과. */
export interface PullRequestReviewChecksSnapshot {
  /** head commit의 All checks, 상태·이름 기준 안정 정렬 */
  checks: PullRequestReviewCheck[];
  /** branch protection endpoint가 required status check 목록을 정상 반환했는지 여부 */
  requiredKnown: boolean;
  /** required status check 이름의 수. 알려지지 않았으면 undefined */
  requiredCount?: number;
  /** branch가 최신 base를 요구하는 strict protection인지 여부. 알려지지 않았으면 undefined */
  strict?: boolean;
}

/** branch protection required_status_checks endpoint의 최소 JSON 형태. */
interface GhRequiredStatusChecksResponse {
  strict?: boolean;
  contexts?: unknown;
  checks?: unknown;
}

/** branch policy read가 성공했는지와 비교에 쓸 required check 이름을 보존한다. */
interface RequiredChecksPolicy {
  known: boolean;
  names: Set<string>;
  strict?: boolean;
}

/** statusCheckRollup GraphQL response의 필요한 최소 구조. */
interface GhChecksResponse {
  data?: {
    repository?: {
      pullRequest?: {
        commits?: {
          nodes?: Array<{
            commit?: {
              statusCheckRollup?: { contexts?: { nodes?: Array<GhCheckContext | null> | null } | null } | null;
            } | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
}

/** CheckRun/StatusContext union이 service에서 실제 읽는 field만 나타낸다. */
interface GhCheckContext {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  workflowName?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
  createdAt?: string | null;
}

/** Pull Request의 최신 head check rollup을 GitHub GraphQL에서 읽는다. */
export class PullRequestReviewChecksService {
  /** fixture runner를 주입해 check normalization과 GraphQL query를 실제 네트워크 없이 검증한다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /** owner/name PR의 latest head checks와 base branch required policy를 읽어 안전한 UI model로 정규화한다. */
  public async getSnapshot(repository: string, number: number, baseRefName: string | undefined, signal?: AbortSignal): Promise<PullRequestReviewChecksSnapshot> {
    const [owner, name] = splitRepository(repository);
    if (!Number.isInteger(number) || number <= 0) throw new Error("A valid pull request number is required to load checks.");
    const [response, policy] = await Promise.all([
      this.runner.runJson<GhChecksResponse>(
      [
        "api", "graphql",
        "-F", `owner=${owner}`,
        "-F", `name=${name}`,
        "-F", `number=${number}`,
        "-F", `limit=${CHECKS_LIMIT}`,
        "-f", `query=${PULL_REQUEST_CHECKS_QUERY}`,
      ],
      this.repoRoot,
      { operation: "review.checks.read", signal }
      ),
      this.getRequiredChecksPolicy(owner, name, baseRefName, signal),
    ]);
    const contexts = response.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
    return {
      checks: normalizeChecks(contexts, policy.names),
      requiredKnown: policy.known,
      ...(policy.known ? { requiredCount: policy.names.size, ...(typeof policy.strict === "boolean" ? { strict: policy.strict } : {}) } : {}),
    };
  }

  /** base branch protection의 required status checks를 read-only로 읽고, capability/권한 실패는 unknown으로 보존한다. */
  private async getRequiredChecksPolicy(owner: string, name: string, baseRefName: string | undefined, signal?: AbortSignal): Promise<RequiredChecksPolicy> {
    const branch = baseRefName?.trim();
    if (!branch) return { known: false, names: new Set() };
    try {
      const response = await this.runner.runJson<GhRequiredStatusChecksResponse>(
        ["api", `repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`],
        this.repoRoot,
        { operation: "review.checks.required", signal }
      );
      return { known: true, names: requiredCheckNames(response), ...(typeof response.strict === "boolean" ? { strict: response.strict } : {}) };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { known: false, names: new Set() };
    }
  }
}

/** CheckRun/legacy status context union을 중복 없는 renderer model로 바꾼다. */
export function normalizeChecks(contexts: readonly (GhCheckContext | null)[], requiredNames: ReadonlySet<string> = new Set()): PullRequestReviewCheck[] {
  const unique = new Map<string, PullRequestReviewCheck>();
  for (const context of contexts) {
    const name = (context?.name || context?.context || "").trim();
    if (!name) continue;
    const workflow = context?.workflowName?.trim() || undefined;
    const state = (context?.conclusion || context?.state || context?.status || "UNKNOWN").trim().toUpperCase();
    const id = `${workflow || ""}\0${name}\0${state}`;
    unique.set(id, {
      id,
      name,
      ...(workflow ? { workflow } : {}),
      bucket: checkBucket(context?.status, context?.conclusion, context?.state),
      state,
      isRequired: requiredNames.has(name),
      ...(safeUrl(context?.detailsUrl || context?.targetUrl) ? { url: safeUrl(context?.detailsUrl || context?.targetUrl) } : {}),
      ...(validTime(context?.startedAt || context?.createdAt) ? { startedAt: validTime(context?.startedAt || context?.createdAt) } : {}),
      ...(validTime(context?.completedAt) ? { completedAt: validTime(context?.completedAt) } : {}),
    });
  }
  return [...unique.values()].sort((left, right) => bucketOrder(left.bucket) - bucketOrder(right.bucket) || left.name.localeCompare(right.name) || (left.workflow || "").localeCompare(right.workflow || ""));
}

/** REST contexts와 새 checks 배열 모두에서 빈 값 없는 required status check 이름을 모은다. */
function requiredCheckNames(response: GhRequiredStatusChecksResponse): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(response.contexts)) response.contexts.forEach((value) => addRequiredName(names, value));
  if (Array.isArray(response.checks)) response.checks.forEach((value) => addRequiredName(names, typeof value === "object" && value !== null && "context" in value ? (value as { context?: unknown }).context : value));
  return names;
}

/** REST의 loose JSON 값을 non-empty status check 이름으로 좁혀 set에 추가한다. */
function addRequiredName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  names.add(value.trim());
}

/** GitHub CheckRun conclusion/status와 legacy StatusContext state를 공통 semantic bucket으로 바꾼다. */
function checkBucket(status: string | undefined, conclusion: string | null | undefined, legacyState: string | undefined): PullRequestCheckBucket {
  const value = (conclusion || legacyState || status || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL"].includes(value)) return "success";
  if (["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"].includes(value)) return "failure";
  if (["SKIPPED", "STALE"].includes(value)) return "skipped";
  if (["CANCELLED"].includes(value)) return "cancelled";
  if (["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"].includes(value)) return "pending";
  return "unknown";
}

/** 실패와 pending을 먼저 보이는 안정된 화면 우선순위다. */
function bucketOrder(bucket: PullRequestCheckBucket): number {
  return ["failure", "pending", "cancelled", "unknown", "skipped", "success"].indexOf(bucket);
}

/** owner/name 형식만 GraphQL 변수로 허용한다. */
function splitRepository(repository: string): [string, string] {
  const [owner, name, extra] = repository.trim().split("/");
  if (!owner || !name || extra) throw new Error("GitHub repository name is unavailable for pull request checks.");
  return [owner, name];
}

/** GitHub URL만 external action으로 renderer에 전달한다. */
function safeUrl(value: string | null | undefined): string | undefined {
  const url = value?.trim();
  return url && /^https:\/\/github(?:\.com|\.[^/]+)\//.test(url) ? url : undefined;
}

/** 파싱 가능한 ISO time만 UI에 전달한다. */
function validTime(value: string | null | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** AbortController로 중단된 gh 호출은 policy unknown으로 바꾸지 않고 상위 lifecycle에 전달한다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}
