import { SharedGitRead } from "./sharedGitRead";
import type { GitBlameLine } from "./blameService";

const cache = new Map<string, { root: string; at: number; read: SharedGitRead<GitBlameLine[]> }>();
let cancelUnused: ((root: string) => boolean) | undefined;

/** 사용자 설정 경계만 주입하며 Git 모듈에 VS Code 의존성을 넣지 않는다. */
export function setBlameReadCancellationPolicy(policy: (root: string) => boolean): () => void {
  cancelUnused = policy;
  return () => { if (cancelUnused === policy) cancelUnused = undefined; };
}

/** 파일·범위·디스크 버전이 같은 라인/블록 요청은 하나의 실제 blame을 공유한다. */
export function readSharedBlame(root: string, key: string, loader: (signal: AbortSignal) => Promise<GitBlameLine[]>, signal?: AbortSignal): Promise<GitBlameLine[]> {
  const now = Date.now();
  for (const [name, entry] of cache) {
    if ((now - entry.at > 60_000 || cache.size > 128) && !entry.read.hasConsumers()) {
      cache.delete(name); void entry.read.dispose();
    }
  }
  let entry = cache.get(key);
  if (!entry) { entry = { root, at: now, read: new SharedGitRead(loader, value => value.map(line => ({ ...line })), () => cancelUnused?.(root) ?? true) }; cache.set(key, entry); }
  entry.at = now;
  return entry.read.read({ signal, maxCacheAgeMs: 1000 });
}

/** HEAD/index/파일 이벤트에서 이전 완료 값을 폐기하며 필요한 조회의 소비자는 유지한다. */
export function invalidateSharedBlameReads(root: string): void { for (const entry of cache.values()) if (entry.root === root) entry.read.invalidate(); }

/** 확장 종료 때 소유한 모든 blame 소비자와 실제 조회를 해제한다. */
export async function disposeSharedBlameReads(): Promise<void> {
  const entries = [...cache.values()]; cache.clear(); await Promise.all(entries.map(entry => entry.read.dispose()));
}
