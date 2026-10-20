// 원격 tag 조회의 공유·소비자별 취소·완료 캐시 상한을 소유한다.
import { SharedGitRead } from "./sharedGitRead";
import type { GitRemoteTagRef, GitTagQueryOptions, GitTagRunner } from "./gitTagService";
import { logInfo } from "../ui/outputLog";

export const REMOTE_TAG_CACHE_LIMIT = 128;
const REMOTE_TAG_CACHE_TTL_MS = 5 * 60 * 1000;
interface Entry {
  repoRoot: string; remote: string; touched: number; users: number;
  read: SharedGitRead<GitRemoteTagRef[]>; loading?: Promise<GitRemoteTagRef[]>;
}
const entries = new Map<string, Entry>();
const runnerIds = new WeakMap<object, number>();
let nextRunnerId = 1;

/**
 * 같은 runner/저장소/remote의 조회를 공유한다. 마지막 소비자의 취소는 실제 close까지 기다린다.
 * @param runner 실행기 identity @param repoRoot 저장소 @param remote 원격 이름
 * @param load 공통 Git runner까지 signal을 전달하는 실제 조회 @param options 소비자 취소와 TTL/강제 갱신
 * @returns 캐시나 다른 소비자의 객체를 변경하지 않는 tag 사본
 */
export async function readRemoteTags(runner: GitTagRunner, repoRoot: string, remote: string,
  load: (signal: AbortSignal) => Promise<GitRemoteTagRef[]>, options: GitTagQueryOptions): Promise<GitRemoteTagRef[]> {
  options.signal?.throwIfAborted();
  const key = cacheKey(runner, repoRoot, remote);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { repoRoot, remote, touched: Date.now(), users: 0, read: undefined! };
    created.read = new SharedGitRead(async signal => {
      const started = Date.now(), pending = load(signal);
      created.loading = pending;
      try {
        const tags = await pending;
        logInfo("graph remote tag cache complete", { repoRoot, remote, tags: tags.length,
          retained: entries.get(key) === created && !signal.aborted, elapsedMs: Date.now() - started });
        return tags;
      } finally { if (created.loading === pending) created.loading = undefined; }
    }, cloneTags);
    entry = created; entries.set(key, entry);
  }
  entry.touched = Date.now(); entries.delete(key); entries.set(key, entry);
  const maxAge = options.maxRemoteAgeMs ?? REMOTE_TAG_CACHE_TTL_MS;
  const cached = !options.forceRemote ? entry.read.peek(maxAge) : undefined;
  if (cached) {
    logInfo("graph remote tag cache hit", { repoRoot, remote, tags: cached.length });
    prune(); return cached;
  }
  const coalescing = entry.users > 0;
  entry.users++;
  logInfo(coalescing ? "graph remote tag cache coalesce" : "graph remote tag cache miss", {
    repoRoot, remote, forced: !!options.forceRemote,
  });
  try {
    // 진행 중 강제 요청도 기존 한 network read를 공유하는 계약을 유지한다.
    return await entry.read.read({ signal: options.signal, force: !!options.forceRemote && !coalescing, maxCacheAgeMs: maxAge });
  } catch (error) {
    if (options.signal?.aborted && entry.users === 1) await entry.loading?.catch(() => undefined);
    throw error;
  } finally { entry.users--; entry.touched = Date.now(); prune(); }
}

/**
 * tag 쓰기 뒤 새 소비자가 이전 결과를 재사용하지 않게 한다. 기존 소비자의 조회는 침범하지 않는다.
 * @param repoRoot 갱신한 저장소 @param remote 특정 원격 또는 전체 원격
 */
export function invalidateRemoteTagCache(repoRoot: string, remote?: string): void {
  for (const [key, entry] of entries) {
    if (entry.repoRoot !== repoRoot || (remote && entry.remote !== remote)) continue;
    entries.delete(key);
    if (!entry.users && !entry.loading) void entry.read.dispose();
  }
  logInfo("graph remote tag cache invalidated", { repoRoot, remote: remote ?? "all" });
}

/** 만료/오래된 완료 값만 해제한다. 소비자 또는 닫히는 Git이 있는 slot은 상한 때문에 교체하지 않는다. */
function prune(): void {
  const now = Date.now(); let removed = 0;
  for (const [key, entry] of entries) {
    if (entry.users || entry.loading || entry.read.hasConsumers()) continue;
    if (entries.size <= REMOTE_TAG_CACHE_LIMIT && now - entry.touched < REMOTE_TAG_CACHE_TTL_MS) continue;
    entries.delete(key); void entry.read.dispose(); removed++;
  }
  if (removed) logInfo("graph remote tag cache pruned", { removed, retained: entries.size, limit: REMOTE_TAG_CACHE_LIMIT });
}

/** runner를 약한 identity로 구분하고 저장소·원격 이름을 서로 다른 cache 경계로 유지한다. */
function cacheKey(runner: GitTagRunner, repoRoot: string, remote: string): string {
  let id = runnerIds.get(runner);
  if (!id) { id = nextRunnerId++; runnerIds.set(runner, id); }
  return `${id}:${repoRoot}\0${remote}`;
}

/** 소비자의 정렬/수정이 공유 캐시를 오염시키지 않도록 배열과 항목을 복제한다. */
function cloneTags(tags: GitRemoteTagRef[]): GitRemoteTagRef[] { return tags.map(tag => ({ ...tag })); }
