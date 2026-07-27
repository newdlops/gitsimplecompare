// Pull Request pending review와 로컬 draft를 안전하게 연결하는 서비스.
// - 로컬 body/event는 server write 실패에도 보존하고, GitHub에는 viewer 자신의 PENDING review 하나만 연결한다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";

const DRAFT_VERSION = 1;
const MAX_BODY_LENGTH = 65_536;

/** pending review와 local draft가 속한 하나의 Pull Request 식별자. */
export interface PullRequestReviewDraftTarget {
  /** owner/name 형태 repository */
  repository: string;
  /** Pull Request 번호 */
  number: number;
  /** GraphQL mutation에 쓰는 Pull Request node id */
  pullRequestId: string;
  /** 현재 head commit OID. 변경 감지와 pending 생성에 사용한다. */
  headOid: string;
}

/** submit 때 선택할 GitHub review event의 안전한 로컬 표현. */
export type PendingReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** workspace 저장소에 보관할 복구 가능한 로컬 review draft. */
export interface LocalPullRequestReviewDraft {
  /** 미래 상태를 안전하게 거부하기 위한 레코드 버전 */
  version: typeof DRAFT_VERSION;
  /** 이 draft가 만든/연결한 GitHub pending review node id */
  reviewId?: string;
  /** 사용자가 아직 제출하지 않은 summary body 원문 */
  body: string;
  /** 마지막으로 선택한 submit event */
  event: PendingReviewEvent;
  /** 작성 당시 head OID. 다르면 re-anchor 전 write를 잠근다. */
  headOid: string;
  /** ISO timestamp로 저장한 마지막 local edit 시각 */
  updatedAt: string;
}

/** GitHub가 반환한 viewer 자신의 pending review 최소 상태. */
export interface PendingPullRequestReview {
  /** GraphQL PullRequestReview node id */
  id: string;
  /** server summary body */
  body: string;
  /** GitHub가 기록한 최종 수정 시각 */
  updatedAt?: string;
  /** 이 review가 대상인 commit OID */
  headOid?: string;
}

/** local/server pending 조합을 UI가 충돌 없이 표시할 reconciliation 결과. */
export interface PullRequestReviewDraftReconcileResult {
  /** 7.8 matrix의 안전한 상태 이름 */
  kind: "none" | "localOnly" | "serverOnly" | "linked" | "conflict" | "headChanged";
  /** 손상되지 않은 local draft가 있으면 보존한다. */
  local?: LocalPullRequestReviewDraft;
  /** GitHub에서 읽은 viewer pending review가 있으면 보존한다. */
  server?: PendingPullRequestReview;
  /** 같은 review id에서 어느 쪽 body가 더 최신인지 나타낸다. */
  bodySource?: "local" | "server" | "same";
}

/** vscode.workspaceState 등 실제 storage를 Git 서비스에 주입하는 최소 adapter. */
export interface PullRequestReviewDraftStorage {
  /** 저장했던 raw value를 읽는다. 없으면 undefined를 반환한다. */
  read(key: string): Promise<unknown>;
  /** serializable local draft를 저장한다. */
  write(key: string, value: LocalPullRequestReviewDraft): Promise<void>;
  /** local draft record를 제거한다. */
  remove(key: string): Promise<void>;
}

/** `reviews(states: PENDING)` GraphQL response의 최소 구조. */
interface PendingReviewQueryResponse {
  data?: {
    viewer?: { login?: string } | null;
    repository?: {
      pullRequest?: {
        reviews?: {
          nodes?: Array<{
            id?: string;
            state?: string;
            body?: string;
            updatedAt?: string;
            author?: { login?: string } | null;
            commit?: { oid?: string } | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
}

/** pending review 생성 mutation 응답의 최소 구조. */
interface CreatePendingReviewResponse {
  data?: {
    addPullRequestReview?: {
      pullRequestReview?: {
        id?: string;
        state?: string;
        body?: string;
        updatedAt?: string;
        commit?: { oid?: string } | null;
      } | null;
    } | null;
  };
}

/** review submit mutation 응답의 최소 검증 형태. */
interface SubmitPendingReviewResponse {
  data?: {
    submitPullRequestReview?: {
      pullRequestReview?: { id?: string; state?: string; submittedAt?: string | null } | null;
    } | null;
  };
}

const PENDING_REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, states: PENDING) {
        nodes { id state body updatedAt author { login } commit { oid } }
      }
    }
  }
}`;

const CREATE_PENDING_REVIEW_MUTATION = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID!, $body: String!, $clientMutationId: String!) {
  addPullRequestReview(input: {
    pullRequestId: $pullRequestId,
    commitOID: $commitOID,
    body: $body,
    clientMutationId: $clientMutationId
  }) {
    pullRequestReview { id state body updatedAt commit { oid } }
  }
}`;

const DELETE_PENDING_REVIEW_MUTATION = `
mutation($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) { clientMutationId }
}`;

const SUBMIT_PENDING_REVIEW_MUTATION = `
mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String!, $clientMutationId: String!) {
  submitPullRequestReview(input: {
    pullRequestReviewId: $reviewId,
    event: $event,
    body: $body,
    clientMutationId: $clientMutationId
  }) {
    pullRequestReview { id state submittedAt }
  }
}`;

/** local debounce와 pending review create/reuse를 PR 단위로 직렬화하는 서비스. */
export class PullRequestReviewDraftService {
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scheduledDrafts = new Map<string, LocalPullRequestReviewDraft>();

  /** gh runner와 workspace storage를 분리해 UI/테스트가 같은 draft contract를 공유한다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly storage: PullRequestReviewDraftStorage,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /** local draft를 읽고 unknown/future shape는 화면을 막지 않고 안전하게 버린다. */
  public async loadLocal(target: PullRequestReviewDraftTarget): Promise<LocalPullRequestReviewDraft | undefined> {
    validateTarget(target);
    return decodeLocalDraft(await this.storage.read(storageKey(target)));
  }

  /** body/event/head를 즉시 durable storage에 저장한다. */
  public async saveLocal(
    target: PullRequestReviewDraftTarget,
    draft: Pick<LocalPullRequestReviewDraft, "body" | "event" | "reviewId">
  ): Promise<LocalPullRequestReviewDraft> {
    const record = makeLocalDraft(target, draft);
    await this.storage.write(storageKey(target), record);
    return record;
  }

  /** 300ms debounce로 입력 중 storage write를 줄이고 마지막 snapshot은 보존한다. */
  public scheduleSaveLocal(
    target: PullRequestReviewDraftTarget,
    draft: Pick<LocalPullRequestReviewDraft, "body" | "event" | "reviewId">
  ): void {
    const key = storageKey(target);
    const record = makeLocalDraft(target, draft);
    this.scheduledDrafts.set(key, record);
    const timer = this.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.saveTimers.set(key, setTimeout(() => { void this.flushKey(key); }, 300));
  }

  /** panel dispose 전 debounce되지 않은 현재 PR 입력을 storage에 기록한다. */
  public async flush(target: PullRequestReviewDraftTarget): Promise<void> {
    await this.flushKey(storageKey(target));
  }

  /** GitHub viewer의 pending review를 읽는다. 다른 사용자의 PENDING review는 절대 연결하지 않는다. */
  public async getServerPending(
    target: PullRequestReviewDraftTarget,
    signal?: AbortSignal
  ): Promise<PendingPullRequestReview | undefined> {
    validateTarget(target);
    const [owner, name] = splitRepository(target.repository);
    const response = await this.runner.runJson<PendingReviewQueryResponse>(
      ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${target.number}`, "-f", `query=${PENDING_REVIEW_QUERY}`],
      this.repoRoot,
      { operation: "review.draft.pending.read", signal }
    );
    const viewer = response.data?.viewer?.login?.trim();
    const reviews = response.data?.repository?.pullRequest?.reviews?.nodes || [];
    const pending = reviews
      .filter((review): review is NonNullable<typeof review> => Boolean(review))
      .filter((review) => review.state === "PENDING" && Boolean(viewer) && review.author?.login === viewer)
      .map(normalizePendingReview)
      .filter((review): review is PendingPullRequestReview => Boolean(review))
      .sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""));
    return pending[0];
  }

  /** local/server 조합을 7.8 matrix에 맞춰 lossless하게 복원한다. */
  public async reconcile(target: PullRequestReviewDraftTarget, signal?: AbortSignal): Promise<PullRequestReviewDraftReconcileResult> {
    const [local, server] = await Promise.all([this.loadLocal(target), this.getServerPending(target, signal)]);
    if ((local && local.headOid !== target.headOid) || (server?.headOid && server.headOid !== target.headOid)) {
      return { kind: "headChanged", local, server };
    }
    if (!local && !server) return { kind: "none" };
    if (local && !server) return { kind: "localOnly", local };
    if (!local && server) return { kind: "serverOnly", server };
    if (local?.reviewId && local.reviewId === server?.id) {
      return { kind: "linked", local, server, bodySource: compareBodies(local, server) };
    }
    return { kind: "conflict", local, server };
  }

  /** 기존 pending review를 우선 재사용하고 없을 때만 event 없는 review를 만든다. */
  public async ensurePending(
    target: PullRequestReviewDraftTarget,
    body: string,
    signal?: AbortSignal
  ): Promise<PendingPullRequestReview> {
    validateBody(body);
    const existing = await this.getServerPending(target, signal);
    if (existing) {
      if (existing.headOid && existing.headOid !== target.headOid) {
        throw new Error("New commits changed this pull request. Reload before adding review comments.");
      }
      return existing;
    }
    const clientMutationId = createClientMutationId();
    try {
      const created = await this.createPending(target, body, clientMutationId, signal);
      return created;
    } catch (error) {
      const recovered = await this.getServerPending(target, signal);
      if (recovered) return recovered;
      throw error;
    }
  }

  /** server pending review가 있으면 삭제 성공 뒤 local draft를 지우고, local-only draft는 바로 제거한다. */
  public async discard(
    target: PullRequestReviewDraftTarget,
    reviewId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    validateTarget(target);
    const key = storageKey(target);
    const server = reviewId ? { id: reviewId } : await this.getServerPending(target, signal);
    if (server?.id) {
      await this.runner.runJson(
        ["api", "graphql", "-F", `reviewId=${server.id}`, "-f", `query=${DELETE_PENDING_REVIEW_MUTATION}`],
        this.repoRoot,
        { operation: "review.draft.pending.discard", signal }
      );
    }
    const timer = this.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(key);
    this.scheduledDrafts.delete(key);
    await this.storage.remove(key);
  }

  /** 최신 head의 viewer pending review 하나를 명시 event로 제출하고 성공한 경우에만 local draft를 지운다. */
  public async submit(
    target: PullRequestReviewDraftTarget,
    reviewId: string,
    event: PendingReviewEvent,
    body: string,
    signal?: AbortSignal
  ): Promise<void> {
    validateTarget(target);
    validateBody(body);
    if (!isPendingReviewEvent(event)) throw new Error("A valid pull request review event is required.");
    const pendingId = reviewId.trim();
    if (!pendingId) throw new Error("A pending pull request review is required before submission.");
    const server = await this.getServerPending(target, signal);
    if (!server || server.id !== pendingId) throw new Error("The pending review changed on GitHub. Reload before submitting it.");
    if (server.headOid && server.headOid !== target.headOid) throw new Error("New commits changed this pull request. Reload before submitting the review.");
    const response = await this.runner.runJson<SubmitPendingReviewResponse>(
      [
        "api", "graphql",
        "-F", `reviewId=${pendingId}`,
        "-F", `event=${event}`,
        "-F", `body=${body}`,
        "-F", `clientMutationId=${createClientMutationId()}`,
        "-f", `query=${SUBMIT_PENDING_REVIEW_MUTATION}`,
      ],
      this.repoRoot,
      { operation: "review.draft.pending.submit", signal }
    );
    const submitted = response.data?.submitPullRequestReview?.pullRequestReview;
    if (submitted?.id?.trim() !== pendingId || !submitted.state?.trim() || submitted.state === "PENDING") {
      throw new Error("GitHub did not confirm that the pull request review was submitted.");
    }
    const key = storageKey(target);
    const timer = this.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(key);
    this.scheduledDrafts.delete(key);
    await this.storage.remove(key);
  }

  /** event 없는 GraphQL addPullRequestReview를 호출해 GitHub pending review 하나를 만든다. */
  private async createPending(
    target: PullRequestReviewDraftTarget,
    body: string,
    clientMutationId: string,
    signal?: AbortSignal
  ): Promise<PendingPullRequestReview> {
    const response = await this.runner.runJson<CreatePendingReviewResponse>(
      [
        "api", "graphql",
        "-F", `pullRequestId=${target.pullRequestId}`,
        "-F", `commitOID=${target.headOid}`,
        "-F", `body=${body}`,
        "-F", `clientMutationId=${clientMutationId}`,
        "-f", `query=${CREATE_PENDING_REVIEW_MUTATION}`,
      ],
      this.repoRoot,
      { operation: "review.draft.pending.create", signal }
    );
    const pending = normalizePendingReview(response.data?.addPullRequestReview?.pullRequestReview);
    if (!pending) throw new Error("GitHub did not return a pending pull request review.");
    return pending;
  }

  /** one key의 마지막 queued draft를 durable storage에 쓰고 timer bookkeeping을 끝낸다. */
  private async flushKey(key: string): Promise<void> {
    const timer = this.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(key);
    const draft = this.scheduledDrafts.get(key);
    if (!draft) return;
    this.scheduledDrafts.delete(key);
    await this.storage.write(key, draft);
  }
}

/** repository/number/node/head가 write 가능한 현재 PR을 가리키는지 확인한다. */
function validateTarget(target: PullRequestReviewDraftTarget): void {
  const [owner, name, extra] = target.repository.trim().split("/");
  if (!owner || !name || extra || !Number.isInteger(target.number) || target.number <= 0 || !target.pullRequestId.trim() || !target.headOid.trim()) {
    throw new Error("A repository, pull request id, number, and head OID are required for a review draft.");
  }
}

/** local record key가 workspace 안의 다른 repository/PR과 충돌하지 않게 만든다. */
function storageKey(target: PullRequestReviewDraftTarget): string {
  return `gitSimpleCompare.reviewDraft.v${DRAFT_VERSION}:${target.repository}:${target.number}`;
}

/** repository owner/name을 GraphQL variable에 넣을 두 안정 문자열로 나눈다. */
function splitRepository(repository: string): [string, string] {
  const [owner, name] = repository.trim().split("/");
  if (!owner || !name) throw new Error("A valid GitHub repository is required for a review draft.");
  return [owner, name];
}

/** local body hard limit을 server 호출보다 먼저 강제해 입력 유실 없이 UI가 오류를 표시하게 한다. */
function validateBody(body: string): void {
  if (body.length > MAX_BODY_LENGTH) throw new Error("A pull request review body cannot exceed 65,536 characters.");
}

/** 선택 draft 일부와 target head를 하나의 storage-safe immutable record로 만든다. */
function makeLocalDraft(
  target: PullRequestReviewDraftTarget,
  draft: Pick<LocalPullRequestReviewDraft, "body" | "event" | "reviewId">
): LocalPullRequestReviewDraft {
  validateTarget(target);
  validateBody(draft.body);
  if (!isPendingReviewEvent(draft.event)) throw new Error("A valid pending review event is required.");
  return {
    version: DRAFT_VERSION,
    ...(draft.reviewId?.trim() ? { reviewId: draft.reviewId.trim() } : {}),
    body: draft.body,
    event: draft.event,
    headOid: target.headOid.trim(),
    updatedAt: new Date().toISOString(),
  };
}

/** unknown workspace value를 안전한 current-version local draft로만 해석한다. */
function decodeLocalDraft(value: unknown): LocalPullRequestReviewDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<LocalPullRequestReviewDraft>;
  if (raw.version !== DRAFT_VERSION || typeof raw.body !== "string" || raw.body.length > MAX_BODY_LENGTH || !isPendingReviewEvent(raw.event) || typeof raw.headOid !== "string" || !raw.headOid.trim() || typeof raw.updatedAt !== "string") return undefined;
  return {
    version: DRAFT_VERSION,
    ...(typeof raw.reviewId === "string" && raw.reviewId.trim() ? { reviewId: raw.reviewId.trim() } : {}),
    body: raw.body,
    event: raw.event,
    headOid: raw.headOid.trim(),
    updatedAt: raw.updatedAt,
  };
}

/** GitHub pending review node의 필요한 필드만 검증해 expose한다. */
function normalizePendingReview(value: {
  id?: string;
  body?: string;
  updatedAt?: string;
  commit?: { oid?: string } | null;
} | null | undefined): PendingPullRequestReview | undefined {
  const id = value?.id?.trim();
  if (!value || !id) return undefined;
  return { id, body: value.body || "", updatedAt: value.updatedAt, headOid: value.commit?.oid?.trim() || undefined };
}

/** local/server body와 update time을 비교해 UI가 자동 overwrite하지 않도록 source만 선언한다. */
function compareBodies(local: LocalPullRequestReviewDraft, server: PendingPullRequestReview): "local" | "server" | "same" {
  if (local.body === server.body) return "same";
  return local.updatedAt.localeCompare(server.updatedAt || "") >= 0 ? "local" : "server";
}

/** UI가 허용하는 submit event만 local storage로 유지한다. */
function isPendingReviewEvent(value: unknown): value is PendingReviewEvent {
  return value === "COMMENT" || value === "APPROVE" || value === "REQUEST_CHANGES";
}

/** recover query correlation에 쓸 non-secret client mutation id를 생성한다. */
function createClientMutationId(): string {
  return `gsc-review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
