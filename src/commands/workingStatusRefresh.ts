// Changes 작업 상태의 조회 source 선택, 최신성 검증, 통계 보강을 조립한다.
// - VS Code Git의 빠른 snapshot과 실제 Git CLI SoT 사이의 동기화 경계를 한곳에서 관리한다.
// - stage/commit 전 요청이 늦게 끝나 최신 UI를 덮지 않도록 repo/request/generation을 모두 확인한다.
import type { GitService, StatusGroups } from "../git/gitService";
import {
  StatusSourceFence,
  statusRefreshFreshness,
  type StatusRefreshFreshness,
} from "../git/statusCache";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import type { CommandDeps } from "./shared";

/** 작업 상태 refresh 호출자가 선택할 수 있는 source 정책. */
export interface RefreshWorkingChangesOptions {
  /** true면 VS Code Git snapshot을 건너뛰고 실제 porcelain 상태를 읽는다. */
  forceGit?: boolean;
}

/** 저장소 하나의 최신 요청, provider fence, 지연된 통계 작업을 묶은 상태. */
interface WorkingStatusRefreshState {
  requestId: number;
  readonly providerFence: StatusSourceFence;
  statsTimer?: ReturnType<typeof setTimeout>;
  statsRunning?: Promise<void>;
  pendingStats?: StatusStatsRequest;
  lastApplied?: StatusGroups;
}

/** 실행 중 numstat 뒤에 합쳐 둘 최신 통계 보강 요청. */
interface StatusStatsRequest {
  request: WorkingStatusRequest;
  groups: StatusGroups;
  source: string;
}

/** refresh 한 번의 비동기 최신성 검사에 필요한 불변 토큰. */
interface WorkingStatusRequest {
  deps: CommandDeps;
  root: string;
  service: GitService;
  state: WorkingStatusRefreshState;
  requestId: number;
  generation: number;
  startedAt: number;
}

// 자체 Git mutation 직후에는 provider가 아직 옛 index를 들 수 있어 우선 CLI를 읽는다.
// 시간 창이 끝난 뒤에도 StatusSourceFence가 실제 fingerprint 수렴까지 정확성을 이어서 보장한다.
const RECENT_MUTATION_WINDOW_MS = 3000;
// 연속 Git 상태 이벤트마다 numstat 프로세스를 만들지 않고 마지막 snapshot만 보강한다.
const STATUS_STATS_DEBOUNCE_MS = 120;
// 한 status 조회 중 여러 ref watcher가 cache generation을 바꿔도 현재 refresh가 SoT 적용을 마치게 한다.
const STATUS_GENERATION_RETRY_LIMIT = 3;
const statesByActivation = new WeakMap<
  CommandDeps,
  Map<string, WorkingStatusRefreshState>
>();

/**
 * 활성 저장소의 작업 상태를 빠른 목록과 지연된 +/- 통계의 두 단계로 UI에 반영한다.
 * - 일반 이벤트는 VS Code Git snapshot을 즉시 사용하고, 자체 mutation/수동 refresh는 CLI porcelain을 사용한다.
 * - CLI로 상태를 확정한 뒤 provider가 다른 값을 주면 실제 새 변경인지 한 번 검증해 stale staged 재등장을 막는다.
 * @param deps 공유 의존성
 * @param options Git CLI를 명시적으로 강제할지 여부
 */
export async function refreshWorkingStatus(
  deps: CommandDeps,
  options: RefreshWorkingChangesOptions = {}
): Promise<void> {
  await refreshWorkingStatusAttempt(deps, options, 0);
}

/**
 * 작업 상태 조회 한 번을 실행하고, 동일 요청의 cache generation만 바뀌었으면 제한적으로 다시 읽는다.
 * - commit 직후 HEAD/ref watcher가 진행 중인 porcelain 조회를 무효화할 수 있다. 이때 결과를 단순 skip하면
 *   다음 queued pass 전까지 이전 staged 목록이 남으므로, 같은 활성 저장소/요청이면 CLI SoT를 즉시 재시도한다.
 * @param deps 공유 의존성
 * @param options source 선택 정책
 * @param generationRetry 이미 수행한 generation 재시도 횟수
 */
async function refreshWorkingStatusAttempt(
  deps: CommandDeps,
  options: RefreshWorkingChangesOptions,
  generationRetry: number
): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root) {
    invalidateActivationRequests(deps);
    deps.changesView.setStatusGroups({ staged: [], unstaged: [] });
    return;
  }

  const state = stateFor(deps, root);
  const requestId = ++state.requestId;
  cancelPendingStats(state);
  const service = deps.registry.get(root);
  const request: WorkingStatusRequest = {
    deps,
    root,
    service,
    state,
    requestId,
    generation: service.getStatusGeneration(),
    startedAt: Date.now(),
  };
  const recentMutation = service.mutatedRecently(RECENT_MUTATION_WINDOW_MS);
  const forceGit = options.forceGit === true || recentMutation;

  let providerGroups: StatusGroups | undefined;
  if (!forceGit) {
    providerGroups = await deps.vscodeGitStatus.getStatusGroups(root);
    if (!isCurrentRequest(request, "provider-read")) {
      return retryAfterGenerationChange(request, generationRetry, "provider-read");
    }
    if (
      providerGroups &&
      state.providerFence.inspectProvider(providerGroups) === "accept"
    ) {
      applyStatusGroups(request, providerGroups, "vscodeGit", recentMutation);
      scheduleStatusStats(request, providerGroups, "vscodeGit");
      return;
    }
  }

  // force 요청, provider 미지원, 또는 fence와 다른 provider snapshot은 실제 porcelain으로 확정한다.
  try {
    const authoritative = await service.getStatusGroups({
      force: forceGit || !!providerGroups,
      includeStats: false,
    });
    if (!isCurrentRequest(request, "git-read")) {
      return retryAfterGenerationChange(request, generationRetry, "git-read");
    }
    if (providerGroups) {
      state.providerFence.reconcile(authoritative, providerGroups);
    } else if (forceGit) {
      state.providerFence.protect(authoritative);
    }
    const source = providerGroups ? "git-verified-provider" : "git";
    applyStatusGroups(request, authoritative, source, recentMutation);
    scheduleStatusStats(request, authoritative, source);
  } catch (error) {
    if (!isCurrentRequest(request, "git-error")) {
      return retryAfterGenerationChange(request, generationRetry, "git-error");
    }
    logError("working status refresh failed", error, {
      root,
      requestId,
      generation: request.generation,
      forceGit,
      providerFence: state.providerFence.isProtected(),
    });
    // 최초 로드 실패일 때만 빈 상태를 표시하고, 기존 화면이 있으면 마지막 정상 SoT를 보존한다.
    if (!state.lastApplied) {
      applyStatusGroups(
        request,
        { staged: [], unstaged: [] },
        "git-error-empty",
        recentMutation
      );
    }
  }
}

/**
 * 저장소와 requestId는 그대로인데 status generation만 바뀐 경우 authoritative 조회를 다시 수행한다.
 * - 새 요청이 이미 시작됐거나 활성 저장소가 바뀐 경우에는 그 요청이 UI를 책임지므로 재시도하지 않는다.
 * - watcher 폭주가 계속되는 비정상 상황에서는 상한 뒤 queued refresh에 맡겨 무한 루프를 막는다.
 * @param request 무효화된 조회 토큰
 * @param generationRetry 이미 수행한 generation 재시도 횟수
 * @param phase 재시도를 결정한 provider/CLI 단계
 */
async function retryAfterGenerationChange(
  request: WorkingStatusRequest,
  generationRetry: number,
  phase: string
): Promise<void> {
  const onlyGenerationChanged = requestFreshness(request) === "generationChanged";
  if (!onlyGenerationChanged) {
    return;
  }
  if (generationRetry >= STATUS_GENERATION_RETRY_LIMIT) {
    logWarn("working status generation retry exhausted", {
      root: request.root,
      requestId: request.requestId,
      generation: request.generation,
      currentGeneration: request.service.getStatusGeneration(),
      phase,
      retries: generationRetry,
    });
    return;
  }
  logInfo("working status generation changed; retrying", {
    root: request.root,
    requestId: request.requestId,
    generation: request.generation,
    currentGeneration: request.service.getStatusGeneration(),
    phase,
    retry: generationRetry + 1,
  });
  await refreshWorkingStatusAttempt(
    request.deps,
    { forceGit: true },
    generationRetry + 1
  );
}

/**
 * 요청 결과가 아직 같은 저장소/세대/최신 요청에 속하는지 확인한다.
 * - 하나라도 달라지면 과거 결과이므로 UI와 provider fence를 건드리지 않고 OUTPUT에 skip 근거를 남긴다.
 * @param request 조회 시작 때 만든 최신성 토큰
 * @param phase provider/CLI/stats 중 검사가 일어난 단계
 * @returns 현재 UI에 적용해도 안전하면 true
 */
function isCurrentRequest(
  request: WorkingStatusRequest,
  phase: string
): boolean {
  const activeRoot = request.deps.changesView.getActiveRepo();
  const freshness = requestFreshness(request);
  const current = freshness === "current";
  if (!current) {
    logInfo("working status result skipped", {
      root: request.root,
      activeRoot,
      requestId: request.requestId,
      latestRequestId: request.state.requestId,
      generation: request.generation,
      currentGeneration: request.service.getStatusGeneration(),
      freshness,
      phase,
    });
  }
  return current;
}

/**
 * 현재 UI/repository state와 조회 시작 토큰을 순수 freshness 정책에 넣어 결과 상태를 계산한다.
 * @param request provider/CLI/stats 비동기 조회 토큰
 * @returns 즉시 적용, generation 재시도, 새 요청에 위임 중 하나
 */
function requestFreshness(
  request: WorkingStatusRequest
): StatusRefreshFreshness {
  return statusRefreshFreshness({
    activeRoot: request.deps.changesView.getActiveRepo(),
    requestRoot: request.root,
    latestRequestId: request.state.requestId,
    requestId: request.requestId,
    currentGeneration: request.service.getStatusGeneration(),
    requestGeneration: request.generation,
  });
}

/**
 * 상태 목록을 UI에 적용하고 다음 빠른 refresh가 기존 통계를 잠시 유지할 수 있게 snapshot을 저장한다.
 * @param request 최신성 검사를 통과한 요청
 * @param groups provider 또는 CLI에서 읽은 상태 목록
 * @param source 관찰 로그에 표시할 실제 source
 * @param recentMutation 최근 자체 Git mutation 때문에 CLI를 선택했는지 여부
 */
function applyStatusGroups(
  request: WorkingStatusRequest,
  groups: StatusGroups,
  source: string,
  recentMutation: boolean
): void {
  const display = carryForwardStats(groups, request.state.lastApplied);
  request.state.lastApplied = display;
  request.deps.changesView.setStatusGroups(display);
  logInfo("working status applied", {
    root: request.root,
    requestId: request.requestId,
    generation: request.generation,
    source,
    recentMutation,
    providerFence: request.state.providerFence.isProtected(),
    staged: display.staged.length,
    unstaged: display.unstaged.length,
    elapsed: Date.now() - request.startedAt,
  });
}

/**
 * 빠른 상태 목록을 먼저 보여준 뒤, 이벤트 폭주가 잦아들면 numstat을 비동기로 보강한다.
 * - 이 Promise를 본 refresh pass가 기다리지 않으므로 commit 후 authoritative pass가 앞선 통계 조회에 막히지 않는다.
 * @param request 목록을 적용한 최신 요청 토큰
 * @param groups 보강할 staged/unstaged 파일 목록
 * @param source 목록을 제공한 source 이름
 */
function scheduleStatusStats(
  request: WorkingStatusRequest,
  groups: StatusGroups,
  source: string
): void {
  if (!groups.staged.length && !groups.unstaged.length) {
    return;
  }
  request.state.statsTimer = setTimeout(() => {
    request.state.statsTimer = undefined;
    enqueueStatusStats({ request, groups, source });
  }, STATUS_STATS_DEBOUNCE_MS);
}

/**
 * 저장소별 numstat 작업을 한 번에 하나만 실행하고, 겹친 이벤트는 가장 최신 요청 하나로 합친다.
 * - read-only Git 프로세스도 무제한으로 겹치면 status tail latency가 늘어나므로 로컬 목록을 우선한다.
 * @param stats debounce를 통과한 최신성 토큰, 상태 목록, source 묶음
 */
function enqueueStatusStats(stats: StatusStatsRequest): void {
  const state = stats.request.state;
  if (state.statsRunning) {
    state.pendingStats = stats;
    logInfo("working status stats coalesced", {
      root: stats.request.root,
      requestId: stats.request.requestId,
    });
    return;
  }
  startStatusStats(stats);
}

/**
 * 통계 보강 하나를 시작하고 완료 직후 대기 중인 최신 요청만 이어서 실행한다.
 * @param stats 실제 addStatusStats를 실행할 요청
 */
function startStatusStats(stats: StatusStatsRequest): void {
  const state = stats.request.state;
  const running = enrichStatusStats(stats.request, stats.groups, stats.source);
  state.statsRunning = running;
  void running.finally(() => {
    if (state.statsRunning !== running) return;
    state.statsRunning = undefined;
    const pending = state.pendingStats;
    state.pendingStats = undefined;
    if (pending && isCurrentRequest(pending.request, "stats-queued")) {
      startStatusStats(pending);
    }
  });
}

/**
 * numstat을 읽어 최신 요청일 때만 두 번째 UI payload를 적용한다.
 * @param request 목록 조회 당시 최신성 토큰
 * @param groups 통계를 붙일 원본 상태 목록
 * @param source 원본 목록 source
 */
async function enrichStatusStats(
  request: WorkingStatusRequest,
  groups: StatusGroups,
  source: string
): Promise<void> {
  try {
    const enriched = await request.service.addStatusStats(groups);
    if (!isCurrentRequest(request, "stats")) {
      return;
    }
    request.state.lastApplied = enriched;
    request.deps.changesView.setStatusGroups(enriched);
    logInfo("working status stats applied", {
      root: request.root,
      requestId: request.requestId,
      source,
      staged: enriched.staged.length,
      unstaged: enriched.unstaged.length,
      elapsed: Date.now() - request.startedAt,
    });
  } catch (error) {
    if (isCurrentRequest(request, "stats-error")) {
      logWarn("working status stats skipped", {
        root: request.root,
        requestId: request.requestId,
        source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 같은 상태 항목에 직전 +/- 통계가 있으면 빠른 1차 렌더 동안만 이어받는다.
 * @param groups 새 provider/porcelain 상태 목록
 * @param previous 마지막으로 UI에 적용한 상태와 통계
 * @returns 새 상태 구조에 일치하는 기존 통계만 복사한 목록
 */
function carryForwardStats(
  groups: StatusGroups,
  previous: StatusGroups | undefined
): StatusGroups {
  if (!previous) {
    return cloneGroups(groups);
  }
  const known = new Map<string, { additions?: number; deletions?: number }>();
  for (const [bucket, items] of [
    ["S", previous.staged],
    ["W", previous.unstaged],
  ] as const) {
    for (const item of items) {
      known.set(itemKey(bucket, item), item);
    }
  }
  const carry = (bucket: "S" | "W", items: StatusGroups["staged"]) =>
    items.map((item) => {
      const stat = known.get(itemKey(bucket, item));
      return stat
        ? { ...item, additions: stat.additions, deletions: stat.deletions }
        : { ...item };
    });
  return {
    staged: carry("S", groups.staged),
    unstaged: carry("W", groups.unstaged),
  };
}

/** 상태 항목의 stage/status/path identity를 통계 재사용 key로 만든다. */
function itemKey(
  bucket: "S" | "W",
  item: StatusGroups["staged"][number]
): string {
  return `${bucket}\0${item.status}\0${item.path}\0${item.oldPath ?? ""}`;
}

/** 호출자가 준 상태 배열/항목을 UI 상태와 분리된 새 객체로 복사한다. */
function cloneGroups(groups: StatusGroups): StatusGroups {
  return {
    staged: groups.staged.map((item) => ({ ...item })),
    unstaged: groups.unstaged.map((item) => ({ ...item })),
  };
}

/** 활성화/deps와 저장소에 대응하는 최신성 상태를 반환한다. */
function stateFor(
  deps: CommandDeps,
  root: string
): WorkingStatusRefreshState {
  let repositories = statesByActivation.get(deps);
  if (!repositories) {
    repositories = new Map();
    statesByActivation.set(deps, repositories);
  }
  let state = repositories.get(root);
  if (!state) {
    state = { requestId: 0, providerFence: new StatusSourceFence() };
    repositories.set(root, state);
  }
  return state;
}

/** 저장소가 사라졌을 때 해당 활성화의 진행 중 요청과 통계 timer를 모두 무효화한다. */
function invalidateActivationRequests(deps: CommandDeps): void {
  for (const state of statesByActivation.get(deps)?.values() ?? []) {
    state.requestId++;
    cancelPendingStats(state);
  }
}

/** 새 상태 요청을 시작하기 전에 아직 실행되지 않은 numstat 보강 timer를 취소한다. */
function cancelPendingStats(state: WorkingStatusRefreshState): void {
  if (state.statsTimer) {
    clearTimeout(state.statsTimer);
    state.statsTimer = undefined;
  }
  // 실행 중인 read-only Git은 강제 종료하지 않되, 아직 시작하지 않은 과거 요청은 최신 요청으로 대체한다.
  state.pendingStats = undefined;
}
