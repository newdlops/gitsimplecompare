import path from "node:path";
import { SharedGitRead, type SharedReadOptions } from "./sharedGitRead";
import { PrivateStatusIndex } from "./privateStatusIndex";
import type { WorkingTreeSnapshot } from "./workingTreeStatusFormat";
import { invalidateSharedBlameReads } from "./sharedBlameReads";
import { gitProcesses } from "./gitProcessRegistry";
import { StatusIndexWarmCache } from "./statusIndexWarmCache";

interface SnapshotPolicy { useCache: boolean; cancelUnused: boolean }
let policy: ((root: string) => SnapshotPolicy) | undefined;
let logger: ((event: string, fields: Record<string, unknown>) => void) | undefined;
let warmCache: StatusIndexWarmCache | undefined;
const roots = new Map<string, { read: SharedGitRead<WorkingTreeSnapshot>; index: PrivateStatusIndex; at: number }>();
const listeners = new Set<(root: string) => void>();
// 우리 실행기를 통해 완료된 쓰기는 watcher 도착 전부터 완료 캐시를 폐기한다.
gitProcesses.onDidFinishWrite(invalidateWorkingTreeSnapshot);

/**
 * VS Code 설정·OUTPUT·저장 공간을 activation에서 주입하고 Git 계층은 UI 없이 공유한다.
 * @param next 저장소별 캐시와 미사용 조회 취소 정책
 * @param log Git 계층의 상태 전환을 OUTPUT에 남길 함수
 * @param cacheDirectory 세션을 넘어 전용 index를 보존할 확장 소유 경로. 없으면 세션 내에서만 사용한다.
 * @returns 현재 등록만 해제하는 함수. 더 최근 등록은 유지한다.
 */
export function setWorkingTreeSnapshotPolicy(next: (root: string) => SnapshotPolicy, log: (event: string, fields: Record<string, unknown>) => void, cacheDirectory?: string): () => void {
  policy = next; logger = log;
  warmCache = cacheDirectory ? new StatusIndexWarmCache(cacheDirectory, (event, fields) => logger?.(event, fields)) : undefined;
  return () => { if (policy === next) { policy = undefined; logger = undefined; warmCache = undefined; } };
}

/** 같은 root의 Changes·Graph·다른 확장 status를 하나의 세대별 실행으로 묶는다. */
export function readWorkingTreeSnapshot(repoRoot: string, options: SharedReadOptions = {}): Promise<WorkingTreeSnapshot> {
  const root = path.resolve(repoRoot);
  for (const [name, cached] of roots) {
    if (name !== root && roots.size >= 32 && !cached.read.hasConsumers()) {
      roots.delete(name); void cached.read.dispose().then(() => cached.index.dispose()).catch(() => undefined);
    }
  }
  let state = roots.get(root);
  if (!state) {
    const index = new PrivateStatusIndex(root, (event, fields) => logger?.(event, fields), warmCache);
    state = { index, at: Date.now(), read: new SharedGitRead(signal => index.read(signal, policy?.(root).useCache ?? true), value => structuredClone(value), () => policy?.(root).cancelUnused ?? true) };
    roots.set(root, state);
  }
  state.at = Date.now();
  return state.read.read(options);
}

/** 기존 mutation/watch fence와 함께 공유 세대를 올리고 공개 API 소비자에게도 알린다. */
export function invalidateWorkingTreeSnapshot(repoRoot: string): void {
  const root = path.resolve(repoRoot); roots.get(root)?.read.invalidate();
  invalidateSharedBlameReads(root);
  for (const listener of listeners) listener(root);
}

/** 설정 변경 등으로 모든 root의 authoritative 결과를 무효화한다. */
export function invalidateWorkingTreeSnapshots(): void { for (const root of roots.keys()) invalidateWorkingTreeSnapshot(root); }

/** 공개 상태 provider의 구독을 등록하고 extension dispose 때 해제할 함수를 반환한다. */
export function onWorkingTreeSnapshotInvalidated(listener: (root: string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** 모든 실행 close를 기다린 뒤 각 root가 생성한 private index를 삭제한다. */
export async function disposeWorkingTreeSnapshots(): Promise<void> {
  const states = [...roots.values()]; roots.clear(); listeners.clear();
  await Promise.all(states.map(async state => { await state.read.dispose(); await state.index.dispose(); }));
}
