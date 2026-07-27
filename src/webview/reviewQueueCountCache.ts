// Reviews sidebar의 민감하지 않은 queue count만 workspaceState에 보관하는 cache.
// - PR 행/제목/URL/인증 정보는 저장하지 않고 repository·account hash로 서로 다른 사용자와 저장소를 격리한다.
import { createHash } from "node:crypto";

/** count cache가 사용하는 현재 직렬화 구조 버전. */
const SCHEMA_VERSION = 1;
/** queue 검색 의미가 바뀌었을 때 이전 count를 재사용하지 않도록 하는 버전. */
const QUERY_VERSION = 1;
/** 첫 진입에서 즉시 보여 줄 수 있는 fresh cache 최대 나이. */
const FRESH_MAX_AGE_MS = 5 * 60 * 1000;
/** stale 안내와 함께 revalidate할 수 있는 cache 최대 나이. */
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = "gitSimpleCompare.reviewQueueCount.v1";

/** vscode.Memento를 직접 의존하지 않고 cache가 필요한 최소 저장 계약만 표현한다. */
export interface ReviewQueueCountStateStore {
  /** key에 저장된 JSON-like 값을 읽는다. */
  get<T>(key: string): T | undefined;
  /** key를 쓰거나 undefined로 삭제한다. */
  update(key: string, value: unknown): Thenable<void> | PromiseLike<void>;
}

/** Personal/Management를 독립적으로 표시할 queue 집계 count. */
export interface ReviewQueueCountProjection {
  /** 개인 review lane에서 중복을 제거한 열린 PR 수. */
  personal: number;
  /** management scope에서 열린 PR 수. */
  management: number;
}

/** workspaceState에 남겨도 되는 최소 cache 레코드. */
export interface ReviewQueueCountCacheV1 {
  schemaVersion: 1;
  queryVersion: 1;
  repositoryFingerprint: string;
  accountFingerprint: string;
  fetchedAt: number;
  counts: ReviewQueueCountProjection;
}

/** cache read가 성공했을 때 UI가 사용할 fresh/stale 표시 상태. */
export interface ReviewQueueCountCacheHit {
  kind: "fresh" | "stale";
  entry: ReviewQueueCountCacheV1;
}

/** cache read의 안전한 결과. invalid/expired record는 저장소에서 함께 제거된다. */
export type ReviewQueueCountCacheRead = ReviewQueueCountCacheHit | { kind: "missing" };

/** repository와 account identity를 cache key로 바꾸기 전 정규화한 값. */
export interface ReviewQueueCountCacheIdentity {
  repository: string;
  account: string;
}

/** cache timestamp를 테스트에서 고정할 수 있게 하는 clock 함수. */
export type ReviewQueueCountClock = () => number;

/** count cache의 TTL, validation, fingerprint와 Memento 입출력을 한 곳에서 관리한다. */
export class ReviewQueueCountCache {
  /**
   * @param state workspace 단위의 비밀이 아닌 UI 상태 저장소
   * @param now cache 나이를 계산할 clock. production에서는 현재 시각을 사용한다.
   */
  public constructor(
    private readonly state: ReviewQueueCountStateStore,
    private readonly now: ReviewQueueCountClock = Date.now
  ) {}

  /**
   * identity에 격리된 count를 읽고 fresh/stale/missing으로 분류한다.
   * @param identity 현재 GitHub repository와 인증된 account identity
   * @returns 만료·손상 cache를 삭제한 뒤 UI가 표시해도 되는 안전한 count 결과
   */
  public async read(
    identity: ReviewQueueCountCacheIdentity
  ): Promise<ReviewQueueCountCacheRead> {
    const normalized = normalizeIdentity(identity);
    const key = storageKey(normalized);
    const entry = parseEntry(this.state.get<unknown>(key));
    if (!entry || !sameIdentity(entry, normalized)) {
      if (this.state.get<unknown>(key) !== undefined) {
        await this.state.update(key, undefined);
      }
      return { kind: "missing" };
    }
    const age = this.now() - entry.fetchedAt;
    if (!Number.isFinite(age) || age < 0 || age > STALE_MAX_AGE_MS) {
      await this.state.update(key, undefined);
      return { kind: "missing" };
    }
    return { kind: age <= FRESH_MAX_AGE_MS ? "fresh" : "stale", entry };
  }

  /**
   * 한 snapshot에서 얻은 Personal/Management count를 같은 fetchedAt으로 원자 저장한다.
   * @param identity 현재 GitHub repository와 인증된 account identity
   * @param counts PR metadata 없이 화면에 보일 숫자만 담은 집계
   * @returns 저장된 current-schema record
   */
  public async write(
    identity: ReviewQueueCountCacheIdentity,
    counts: ReviewQueueCountProjection
  ): Promise<ReviewQueueCountCacheV1> {
    const normalized = normalizeIdentity(identity);
    const entry: ReviewQueueCountCacheV1 = {
      schemaVersion: SCHEMA_VERSION,
      queryVersion: QUERY_VERSION,
      repositoryFingerprint: fingerprint(normalized.repository),
      accountFingerprint: fingerprint(normalized.account),
      fetchedAt: this.now(),
      counts: normalizeCounts(counts),
    };
    await this.state.update(storageKey(normalized), entry);
    return entry;
  }

  /**
   * 현재 identity의 count만 명시적으로 제거한다.
   * @param identity auth revoke, repository/account 전환 등으로 더 이상 보이면 안 되는 cache key
   */
  public async invalidate(identity: ReviewQueueCountCacheIdentity): Promise<void> {
    await this.state.update(storageKey(normalizeIdentity(identity)), undefined);
  }
}

/** ReviewQueueSnapshot의 lane을 넘겨받은 caller가 count를 안전하게 제한하도록 숫자를 정규화한다. */
function normalizeCounts(counts: ReviewQueueCountProjection): ReviewQueueCountProjection {
  return {
    personal: safeCount(counts.personal),
    management: safeCount(counts.management),
  };
}

/** 음수·소수·비유한 숫자가 cache에 들어가지 않게 한다. */
function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** raw Memento 값을 현재 cache schema로 검증한다. */
function parseEntry(value: unknown): ReviewQueueCountCacheV1 | undefined {
  const fetchedAt = isRecord(value) ? value.fetchedAt : undefined;
  if (!isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.queryVersion !== QUERY_VERSION
    || typeof value.repositoryFingerprint !== "string"
    || typeof value.accountFingerprint !== "string"
    || typeof fetchedAt !== "number" || !Number.isSafeInteger(fetchedAt)
    || !isRecord(value.counts)) {
    return undefined;
  }
  const counts = value.counts as Record<string, unknown>;
  const personal = counts.personal;
  const management = counts.management;
  if (typeof personal !== "number" || !Number.isSafeInteger(personal) || personal < 0
    || typeof management !== "number" || !Number.isSafeInteger(management) || management < 0) {
    return undefined;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    queryVersion: QUERY_VERSION,
    repositoryFingerprint: value.repositoryFingerprint,
    accountFingerprint: value.accountFingerprint,
    fetchedAt,
    counts: { personal, management },
  };
}

/** repository/account을 case-insensitive identity로 정규화하고 빈 값은 호출자 오류로 막는다. */
function normalizeIdentity(identity: ReviewQueueCountCacheIdentity): ReviewQueueCountCacheIdentity {
  const repository = identity.repository.trim().toLowerCase();
  const account = identity.account.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !account) {
    throw new Error("A canonical GitHub repository and authenticated account are required for review queue cache.");
  }
  return { repository, account };
}

/** record fingerprint가 지금 인증된 repository/account pair와 정확히 일치하는지 확인한다. */
function sameIdentity(entry: ReviewQueueCountCacheV1, identity: ReviewQueueCountCacheIdentity): boolean {
  return entry.repositoryFingerprint === fingerprint(identity.repository)
    && entry.accountFingerprint === fingerprint(identity.account);
}

/** 원문 remote/path/account을 storage key나 value에 남기지 않는 SHA-256 fingerprint를 만든다. */
function fingerprint(value: string): string {
  return createHash("sha256").update(`gsc-review-queue\u0000${value}`, "utf8").digest("hex");
}

/** repository/account pair의 opaque workspaceState key를 만든다. */
function storageKey(identity: ReviewQueueCountCacheIdentity): string {
  return `${STORAGE_PREFIX}.${fingerprint(`${identity.repository}\u0000${identity.account}`)}`;
}

/** plain object만 cache record로 허용한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** test와 provider가 TTL 경계를 명시할 수 있게 export한다. */
export const reviewQueueCountCacheTiming = {
  freshMaxAgeMs: FRESH_MAX_AGE_MS,
  staleMaxAgeMs: STALE_MAX_AGE_MS,
};
