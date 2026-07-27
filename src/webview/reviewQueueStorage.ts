// Reviews의 사용자별 saved queue를 globalState에 보존하는 storage adapter.
// - GitHub 결과는 저장하지 않고 query 정의만 저장해 stale PR 목록을 화면에 복원하지 않는다.
const STORAGE_VERSION = 1;
const MAX_QUEUE_NAME_LENGTH = 80;
const MAX_QUEUE_QUERY_LENGTH = 500;

/** Management 탭에서 다시 실행할 로컬 saved queue 정의. */
export interface SavedReviewQueue {
  /** future shape를 안전하게 거부할 storage 형식 버전 */
  version: typeof STORAGE_VERSION;
  /** UI가 선택·삭제할 안정된 local id */
  id: string;
  /** 사용자가 정한 짧은 queue 이름 */
  name: string;
  /** `gh` search에 추가할 GitHub search qualifier 문자열 */
  query: string;
  /** 생성 시각 */
  createdAt: string;
  /** 마지막 편집 시각 */
  updatedAt: string;
}

/** Memento 의존성을 테스트 가능한 최소 저장 인터페이스로 좁힌다. */
export interface ReviewQueueStateStorage {
  /** key에 저장했던 JSON-safe value를 읽는다. */
  get<T>(key: string): T | undefined;
  /** key의 value를 교체하거나 undefined로 제거한다. */
  update(key: string, value: unknown): Thenable<void>;
}

/** repository와 viewer 단위로 saved queue를 읽고 쓴다. */
export class ReviewQueueStorage {
  /** globalState 구현체를 주입해 extension host와 단위 테스트가 같은 계약을 사용한다. */
  public constructor(private readonly state: ReviewQueueStateStorage) {}

  /** 현재 viewer/repository에 저장한 queue를 손상 레코드 없이 저장 순서대로 반환한다. */
  public load(repository: string, viewer: string): SavedReviewQueue[] {
    const raw = this.state.get<unknown>(storageKey(repository, viewer));
    if (!Array.isArray(raw)) return [];
    return raw.map(decodeQueue).filter((queue): queue is SavedReviewQueue => Boolean(queue));
  }

  /** 새 query definition만 저장하고 중복 이름은 명시 오류로 막는다. */
  public async create(repository: string, viewer: string, name: string, query: string): Promise<SavedReviewQueue> {
    const normalizedName = normalizeName(name);
    const normalizedQuery = normalizeQuery(query);
    const queues = this.load(repository, viewer);
    if (queues.some((queue) => queue.name.localeCompare(normalizedName, undefined, { sensitivity: "accent" }) === 0)) {
      throw new Error("A saved review queue with this name already exists.");
    }
    const now = new Date().toISOString();
    const queue: SavedReviewQueue = {
      version: STORAGE_VERSION,
      id: `gsc-review-queue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: normalizedName,
      query: normalizedQuery,
      createdAt: now,
      updatedAt: now,
    };
    await this.state.update(storageKey(repository, viewer), [...queues, queue]);
    return queue;
  }

  /** 명시적으로 선택한 id만 제거하고 존재하지 않는 id에는 write하지 않는다. */
  public async remove(repository: string, viewer: string, id: string): Promise<boolean> {
    const queues = this.load(repository, viewer);
    const next = queues.filter((queue) => queue.id !== id.trim());
    if (next.length === queues.length) return false;
    await this.state.update(storageKey(repository, viewer), next);
    return true;
  }

  /** 선택한 queue의 이름·검색 조건을 갱신하고 이름 중복은 기존 queue와 동일하게 막는다. */
  public async update(repository: string, viewer: string, id: string, name: string, query: string): Promise<SavedReviewQueue | undefined> {
    const normalizedId = id.trim();
    const normalizedName = normalizeName(name);
    const normalizedQuery = normalizeQuery(query);
    const queues = this.load(repository, viewer);
    const current = queues.find((queue) => queue.id === normalizedId);
    if (!current) return undefined;
    if (queues.some((queue) => queue.id !== normalizedId && queue.name.localeCompare(normalizedName, undefined, { sensitivity: "accent" }) === 0)) {
      throw new Error("A saved review queue with this name already exists.");
    }
    const updated: SavedReviewQueue = { ...current, name: normalizedName, query: normalizedQuery, updatedAt: new Date().toISOString() };
    await this.state.update(storageKey(repository, viewer), queues.map((queue) => queue.id === normalizedId ? updated : queue));
    return updated;
  }

  /** 선택한 queue를 한 칸만 이동해 화면과 저장소의 같은 순서를 유지한다. */
  public async move(repository: string, viewer: string, id: string, direction: "up" | "down"): Promise<boolean> {
    const queues = this.load(repository, viewer);
    const index = queues.findIndex((queue) => queue.id === id.trim());
    const destination = index + (direction === "up" ? -1 : 1);
    if (index < 0 || destination < 0 || destination >= queues.length) return false;
    const next = [...queues];
    [next[index], next[destination]] = [next[destination], next[index]];
    await this.state.update(storageKey(repository, viewer), next);
    return true;
  }
}

/** owner/name과 viewer가 있는 경우에만 다른 계정의 local queue와 분리된 key를 만든다. */
function storageKey(repository: string, viewer: string): string {
  const repo = repository.trim().toLowerCase();
  const login = viewer.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !login) throw new Error("A GitHub repository and viewer are required for saved review queues.");
  return `gitSimpleCompare.reviewQueues.v${STORAGE_VERSION}:${repo}:${login}`;
}

/** user-visible name의 빈 값·과도한 길이를 write 전에 막는다. */
function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a name for the saved review queue.");
  if (name.length > MAX_QUEUE_NAME_LENGTH) throw new Error("A saved review queue name cannot exceed 80 characters.");
  return name;
}

/** query는 GitHub search에 넘길 공백 정규화 문자열이며 결과 자체는 저장하지 않는다. */
function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/g, " ");
  if (!query) throw new Error("Enter at least one GitHub search qualifier for the saved review queue.");
  if (query.length > MAX_QUEUE_QUERY_LENGTH) throw new Error("A saved review queue query cannot exceed 500 characters.");
  return query;
}

/** unknown globalState 값을 current version의 안전한 saved queue로만 변환한다. */
function decodeQueue(value: unknown): SavedReviewQueue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SavedReviewQueue>;
  if (raw.version !== STORAGE_VERSION || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || typeof raw.query !== "string" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
  try {
    return { version: STORAGE_VERSION, id: raw.id.trim(), name: normalizeName(raw.name), query: normalizeQuery(raw.query), createdAt: raw.createdAt, updatedAt: raw.updatedAt };
  } catch {
    return undefined;
  }
}
