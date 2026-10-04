// 작업 상태 소비자의 요청 토큰·timer·실제 Git 취소 수명을 모은 순수 상태 모듈.
import type { GitService, StatusGroups } from '../git/gitService';
import { StatusSourceFence } from '../git/statusCache';
import type { CommandDeps } from './shared';
/** 저장소 하나의 최신 요청, provider fence, 지연된 통계 작업을 묶은 상태. */
export interface WorkingStatusRefreshState {
  requestId: number;
  statusController?: AbortController;
  statsController?: AbortController;
  readonly providerFence: StatusSourceFence;
  statsTimer?: ReturnType<typeof setTimeout>;
  statsRunning?: Promise<void>;
  pendingStats?: StatusStatsRequest;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  lastApplied?: StatusGroups;
}

/** 실행 중 numstat 뒤에 합쳐 둘 최신 통계 보강 요청. */
export interface StatusStatsRequest {
  request: WorkingStatusRequest;
  groups: StatusGroups;
  source: string;
}

/** refresh 한 번의 비동기 최신성 검사에 필요한 불변 토큰. */
export interface WorkingStatusRequest {
  deps: CommandDeps;
  root: string;
  service: GitService;
  state: WorkingStatusRefreshState;
  requestId: number;
  generation: number;
  providerRevision?: number;
  startedAt: number;
}


export const statesByActivation = new WeakMap<
  CommandDeps,
  Map<string, WorkingStatusRefreshState>
>();

/** 활성화/deps와 저장소에 대응하는 최신성 상태를 반환한다. */
export function stateFor(
  deps: CommandDeps,
  root: string
): WorkingStatusRefreshState {
  let repositories = statesByActivation.get(deps);
  if (!repositories) {
    repositories = new Map();
    statesByActivation.set(deps, repositories);
  }
  for (const [previousRoot, previous] of repositories) {
    if (previousRoot !== root) {
      previous.requestId++; previous.statusController?.abort(); cancelPendingStats(previous);
      clearTimeout(previous.fallbackTimer); previous.fallbackTimer = undefined;
    }
  }
  let state = repositories.get(root);
  if (!state) {
    state = { requestId: 0, providerFence: new StatusSourceFence() };
    repositories.set(root, state);
  }
  return state;
}


/** 새 상태 요청을 시작하기 전에 아직 실행되지 않은 numstat 보강 timer를 취소한다. */
export function cancelPendingStats(state: WorkingStatusRefreshState): void {
  if (state.statsTimer) {
    clearTimeout(state.statsTimer);
    state.statsTimer = undefined;
  }
  state.statsController?.abort();
  state.statsController = undefined;
  state.pendingStats = undefined;
}
