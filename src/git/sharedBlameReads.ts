import { SharedGitRead } from "./sharedGitRead";
import type { GitBlameLine } from "./blameService";

const cache = new Map<string, { root: string; at: number; bytes: number; read: SharedGitRead<GitBlameLine[]> }>();
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
let cancelUnused: ((root: string) => boolean) | undefined;

/** 사용자 설정 경계만 주입하며 Git 모듈에 VS Code 의존성을 넣지 않는다. */
export function setBlameReadCancellationPolicy(policy: (root: string) => boolean): () => void {
  cancelUnused = policy;
  return () => { if (cancelUnused === policy) cancelUnused = undefined; };
}

/** 파일·범위·디스크 버전이 같은 라인/블록 요청은 하나의 실제 blame을 공유한다. */
export async function readSharedBlame(root: string, key: string, loader: (signal: AbortSignal) => Promise<GitBlameLine[]>, signal?: AbortSignal, maxCacheAgeMs = 60_000): Promise<GitBlameLine[]> {
  const now = Date.now();
  prune(now);
  let entry = cache.get(key);
  if (!entry) {
    const next = { root, at: now, bytes: 0, read: undefined! as SharedGitRead<GitBlameLine[]> };
    next.read = new SharedGitRead(async abort => {
      const value = await loader(abort);
      next.bytes = value.reduce((sum, line) => sum + 256 + 2 * (line.commit.length + line.authorName.length + line.authorMail.length + line.summary.length + line.filename.length + line.content.length), 0);
      return value;
    }, value => value.map(line => ({ ...line })), () => cancelUnused?.(root) ?? true);
    entry = next; cache.set(key, entry);
  }
  entry.at = now;
  try { return await entry.read.read({ signal, maxCacheAgeMs }); }
  finally { prune(Date.now()); }
}

/** 오래된 완료 값과 큰 결과를 LRU로 해제하되 진행 중 소비자가 필요한 조회는 유지한다. */
function prune(now: number): void {
  let bytes = [...cache.values()].reduce((sum, value) => sum + value.bytes, 0);
  for (const [name, entry] of [...cache].sort((a, b) => a[1].at - b[1].at)) {
    if ((now - entry.at > 60_000 || cache.size > 128 || bytes > MAX_RETAINED_BYTES) && !entry.read.hasConsumers()) {
      cache.delete(name); bytes -= entry.bytes; void entry.read.dispose();
    }
  }
}

/** HEAD/index/파일 이벤트에서 이전 완료 값을 폐기하며 필요한 조회의 소비자는 유지한다. */
export function invalidateSharedBlameReads(root: string): void { for (const entry of cache.values()) if (entry.root === root) entry.read.invalidate(); }

/** 확장 종료 때 소유한 모든 blame 소비자와 실제 조회를 해제한다. */
export async function disposeSharedBlameReads(): Promise<void> {
  const entries = [...cache.values()]; cache.clear(); await Promise.all(entries.map(entry => entry.read.dispose()));
}
