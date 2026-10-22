import path from "node:path";
import { SharedGitRead, type SharedReadOptions } from "./sharedGitRead";
import { PrivateStatusIndex } from "./privateStatusIndex";
import type { WorkingTreeSnapshot, WorkingTreeSummary } from "./workingTreeStatusFormat";
import { invalidateSharedBlameReads } from "./sharedBlameReads";
import { gitProcesses } from "./gitProcessRegistry";
import { StatusIndexWarmCache } from "./statusIndexWarmCache";

interface SnapshotPolicy { useCache: boolean; cancelUnused: boolean }
let policy: ((root: string) => SnapshotPolicy) | undefined;
let logger: ((event: string, fields: Record<string, unknown>) => void) | undefined;
let warmCache: StatusIndexWarmCache | undefined;
interface SnapshotRead { summary: WorkingTreeSummary; snapshot?: WorkingTreeSnapshot }
interface SnapshotState { read: SharedGitRead<SnapshotRead>; index: PrivateStatusIndex; at: number; fullConsumers: number }
const roots = new Map<string, SnapshotState>();
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

/**
 * 같은 root의 전체 상태 소비자를 하나의 세대별 실행으로 묶는다. 먼저 읽은 요약은 완전한 목록으로 승격한다.
 * @param repoRoot 저장소 또는 linked worktree 루트 @param options force·변경 알림·유효 시간·소비자 취소 신호
 * @returns 모든 파일을 포함하는 독립 사본. 호출자의 통계 보강·배열 변경은 다른 소비자에 전파되지 않는다.
 */
export async function readWorkingTreeSnapshot(repoRoot: string, options: SharedReadOptions = {}): Promise<WorkingTreeSnapshot> {
  const state = snapshotState(repoRoot);
  state.fullConsumers++;
  try {
    let result = await state.read.read(options);
    // 먼저 실행된 Graph 요약은 전체 목록을 대체하지 않는다. 겹친 전체 소비자들은 다음 한 세대로 합친다.
    while (!result.snapshot) result = await state.read.read({ ...options, force: true });
    return structuredClone(result.snapshot);
  } finally { state.fullConsumers--; }
}

/**
 * Graph의 가상 노드에 필요한 요약만 반환하되, 완료·실행 중인 전체 상태는 같은 조회에서 공유한다.
 * @param repoRoot 저장소 또는 linked worktree 루트 @param signal 숨김·교체 때 해당 소비자만 해제할 신호
 * @returns 같은 Native status의 HEAD·변경 존재. 디렉터리 요약을 Changes 파일 목록으로 오인하지 않는다.
 */
export async function readWorkingTreeSummary(repoRoot: string, signal?: AbortSignal): Promise<WorkingTreeSummary> {
  const result = await snapshotState(repoRoot).read.read({ signal });
  return { ...result.summary };
}

/**
 * 전체·요약 소비자를 한 실행기로 묶고, 사용 중이 아닌 오래된 root만 정리한다.
 * @param repoRoot 정규화할 저장소 경로 @returns 전용 index·실행기·현재 전체 소비자 수를 소유하는 내부 상태
 */
function snapshotState(repoRoot: string): SnapshotState {
  const root = path.resolve(repoRoot);
  for (const [name, cached] of roots) {
    if (name !== root && roots.size >= 32 && !cached.read.hasConsumers()) {
      roots.delete(name); void cached.read.dispose().then(() => cached.index.dispose()).catch(() => undefined);
    }
  }
  let state = roots.get(root);
  if (!state) {
    const index = new PrivateStatusIndex(root, (event, fields) => logger?.(event, fields), warmCache);
    const next: SnapshotState = { index, at: Date.now(), fullConsumers: 0, read: undefined! };
    next.read = new SharedGitRead<SnapshotRead>(async signal => {
      const useCache = policy?.(root).useCache ?? true;
      if (!next.fullConsumers) return { summary: await index.readSummary(signal, useCache) };
      const snapshot = await index.read(signal, useCache);
      return { snapshot, summary: { head: snapshot.head, hasChanges: snapshot.hasChanges } };
    // 내부 값은 외부에 노출하지 않는다. 전체 반환만 복사해 Graph 요약이 큰 파일 목록까지 복제하지 않게 한다.
    }, value => value, () => policy?.(root).cancelUnused ?? true);
    state = next;
    roots.set(root, state);
  }
  state.at = Date.now();
  return state;
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
