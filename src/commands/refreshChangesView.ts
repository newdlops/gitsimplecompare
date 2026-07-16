// Changes 웹뷰의 실제 데이터 새로고침 명령.
// - 단순 재렌더가 아니라 저장소/작업트리/stash/활성 브랜치 비교를 다시 읽는다.
import * as vscode from "vscode";
import { refreshActiveComparison } from "./compareBranches";
import { refreshFileHistory } from "./fileHistory";
import { refreshStashes } from "./stash";
import {
  CommandDeps,
  RepoInfo,
  discoverRepositories,
  repositoryPathKey,
  resolvePreferredRepositoryRoot,
} from "./shared";
import { refreshWorkingChanges } from "./workingChanges";
import { refreshWorktreesForChangesView } from "./worktreeState";
import { refreshCommitHooks } from "./commitHooks";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  ChangesRefreshSection,
  RefreshDrain,
  changesRefreshLanes,
  shouldForceChangesGitStatus,
  shouldInvalidateChangesStatus,
  shouldShowChangesRefreshProgress,
} from "../utils/extensionRefreshPolicy";

let refreshSequence = 0;
type ChangesRefreshLane = "local" | "auxiliary";

interface ChangesRefreshCoordinator {
  deps: CommandDeps;
  local: RefreshDrain;
  auxiliary: RefreshDrain;
}

let refreshCoordinator: ChangesRefreshCoordinator | undefined;

export interface RefreshRequest {
  reason?: string;
}

/**
 * Changes 웹뷰에 표시되는 모든 동적 데이터를 다시 조회한다.
 * - 사용자가 누르는 refresh 와 파일/git 변경 이벤트가 모두 이 함수로 수렴한다.
 * - 각 섹션은 독립적으로 실패할 수 있으므로 allSettled 로 가능한 섹션은 계속 갱신한다.
 * @param deps 공유 의존성
 * @param request refresh 를 요청한 출처 정보
 */
export async function refreshChangesView(
  deps: CommandDeps,
  request: RefreshRequest = {}
): Promise<void> {
  const reason = request.reason ?? "command";
  const refresh = () => requestChangesRefreshLanes(deps, reason);
  if (shouldShowChangesRefreshProgress(reason)) {
    await vscode.window.withProgress(
      { location: { viewId: "gitSimpleCompare.changes" } },
      refresh
    );
    return;
  }
  await refresh();
}

/**
 * 원인에 필요한 local/auxiliary lane을 각각 요청하고 두 결과를 함께 기다린다.
 * - 느린 History/stash/comparison pass가 실행 중이어도 local lane은 별도 drain에서 즉시 진행한다.
 * - 저장소 탐색이 포함된 pass만 auxiliary lane이 새 활성 저장소 확정을 기다린다.
 * @param deps 현재 확장 활성화에서 공유하는 명령 의존성
 * @param reason 단일 또는 합쳐진 새로고침 원인
 */
async function requestChangesRefreshLanes(
  deps: CommandDeps,
  reason: string
): Promise<void> {
  const lanes = changesRefreshLanes(reason);
  const coordinator = changesRefreshCoordinator(deps);
  const requestLane = (
    lane: ChangesRefreshLane,
    sections: ChangesRefreshSection[]
  ): Promise<void> => {
    if (!sections.length) return Promise.resolve();
    const drain = coordinator[lane];
    if (drain.isRunning()) {
      logInfo("changes refresh queued", { reason, lane });
    }
    return drain.request(reason);
  };
  const local = requestLane("local", lanes.local);
  const waitForRepositorySelection = lanes.local.includes("repositories");
  const auxiliary = lanes.auxiliary.length
    ? waitForRepositorySelection
      ? local.then(() => requestLane("auxiliary", lanes.auxiliary))
      : requestLane("auxiliary", lanes.auxiliary)
    : Promise.resolve();
  await Promise.all([local, auxiliary]);
}

/**
 * 현재 활성화가 공유할 local/auxiliary refresh drain을 반환한다.
 * @param deps 현재 확장 활성화에서 공유하는 명령 의존성
 * @returns 서로 독립적으로 요청을 합치고 완료를 보장하는 두 drain
 */
function changesRefreshCoordinator(deps: CommandDeps): ChangesRefreshCoordinator {
  if (!refreshCoordinator || refreshCoordinator.deps !== deps) {
    refreshCoordinator = {
      deps,
      local: new RefreshDrain((reason) =>
        runChangesRefreshPass(deps, reason, "local")
      ),
      auxiliary: new RefreshDrain((reason) =>
        runChangesRefreshPass(deps, reason, "auxiliary")
      ),
    };
  }
  return refreshCoordinator;
}

/**
 * 합쳐진 원인으로 한 lane의 실제 Changes refresh pass를 실행하고 오류를 사용자/OUTPUT에 보고한다.
 * @param deps 공유 의존성
 * @param reason 이 pass에 포함된 중복 제거 원인 문자열
 * @param lane 로컬 작업 상태 또는 보조 정보 실행 lane
 */
async function runChangesRefreshPass(
  deps: CommandDeps,
  reason: string,
  lane: ChangesRefreshLane
): Promise<void> {
  const runId = ++refreshSequence;
  logInfo("changes refresh started", { runId, reason, lane });
  try {
    await refreshChangesViewOnce(deps, reason, lane);
    logInfo("changes refresh finished", { runId, lane });
  } catch (error) {
    logError("changes refresh failed", error, { runId, reason, lane });
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Git Simple Compare refresh failed. See the Git Simple Compare output for details."
      )
    );
  }
}

/** 실제 Git 조회를 한 lane에서 수행한다. 같은 lane의 겹친 호출만 RefreshDrain이 합친다. */
async function refreshChangesViewOnce(
  deps: CommandDeps,
  reason: string,
  lane: ChangesRefreshLane
): Promise<void> {
  const sections = changesRefreshLanes(reason)[lane];
  logInfo("changes refresh scoped", { reason, lane, sections });
  if (sections.length === 0) return;
  const initialRoot = deps.changesView.getActiveRepo();
  if (lane === "local" && shouldInvalidateChangesStatus(reason)) {
    if (initialRoot && !sections.includes("repositories")) {
      deps.registry.invalidateStatusCache(initialRoot);
    } else {
      deps.registry.invalidateStatusCaches();
    }
  }
  const forceGitStatus = shouldForceChangesGitStatus(reason);
  const shouldDiscover =
    sections.includes("repositories") || !deps.changesView.getActiveRepo();
  const repositoryLoad = shouldDiscover
    ? discoverRepositoriesForRefresh(deps, reason)
    : undefined;
  // 이미 활성 저장소가 있으면 느린 multi-root 탐색과 현재 저장소 status를 동시에 시작한다.
  let prefetchedWorking =
    repositoryLoad && initialRoot && sections.includes("workingChanges")
      ? timedRefreshSection("workingChanges", () =>
          refreshWorkingChanges(deps, { forceGit: forceGitStatus })
        )
      : undefined;
  // repositoryLoad가 먼저 실패해도 이미 시작한 status Promise가 unhandled rejection으로 남지 않게 한다.
  void prefetchedWorking?.catch(() => undefined);
  if (repositoryLoad) {
    const repositories = await repositoryLoad;
    const preferredRoot = resolvePreferredRepositoryRoot(repositories);
    deps.changesView.setRepositories(repositories, preferredRoot);
  }
  const activeRoot = deps.changesView.getActiveRepo();
  if (initialRoot && activeRoot !== initialRoot) {
    // 자동 저장소 전환은 수동 selectRepo와 같은 경계로 Explorer/SCM 비교 세대도 함께 무효화한다.
    deps.comparison.clearComparison("changesRepositoryChanged");
  }
  if (prefetchedWorking && activeRoot !== initialRoot) {
    // 탐색 결과 활성 저장소가 달라졌다면 잠깐 적용됐을 수 있는 이전 목록을 지우고 새 root를 즉시 조회한다.
    deps.changesView.setStatusGroups({ staged: [], unstaged: [] });
    observeSupersededWorkingPrefetch(prefetchedWorking, initialRoot);
    prefetchedWorking = undefined;
  }
  const tasks = [
    sections.includes("workingChanges")
      ? prefetchedWorking
        ? promisedSectionTask("workingChanges", prefetchedWorking)
        : sectionTask("workingChanges", () =>
            refreshWorkingChanges(deps, { forceGit: forceGitStatus })
          )
      : undefined,
    sections.includes("fileHistory")
      ? sectionTask("fileHistory", () => refreshFileHistory(deps, { reason }))
      : undefined,
    sections.includes("stashes")
      ? sectionTask("stashes", () => refreshStashes(deps))
      : undefined,
    sections.includes("worktrees")
      ? sectionTask("worktrees", () => refreshWorktreesForChangesView(deps))
      : undefined,
    sections.includes("commitHooks")
      ? sectionTask("commitHooks", () => refreshCommitHooks(deps))
      : undefined,
    sections.includes("comparison")
      ? sectionTask("comparison", () => refreshActiveComparison(deps))
      : undefined,
  ].filter((task): task is RefreshTask => !!task);
  const results = await Promise.allSettled(
    tasks.map((task) =>
      task.promise ?? timedRefreshSection(task.section, task.run)
    )
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const section = tasks[index]?.section ?? "unknown";
      logWarn("changes refresh section failed", {
        section,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });
}

/**
 * Changes 뷰에 표시할 저장소 목록을 조회한다.
 * - VS Code 내장 Git 이 이미 저장소/브랜치를 알고 있으면 그 상태를 즉시 재사용해 `rev-parse` 반복 실행을 피한다.
 * - 내장 Git이 아직 활성화/스캔 중이면 기다리지 않고 기존 CLI 기반 탐색으로 폴백한다.
 * - 최초 viewReady에서는 Git API의 부분 scan이 활성 파일 저장소를 빠뜨리지 않도록 workspace 결과와 병합한다.
 * @param deps 공유 의존성
 * @param reason 저장소 조회를 요청한 refresh 원인
 * @returns 현재 작업 컨텍스트에서 사용할 중복 없는 저장소 목록
 */
async function discoverRepositoriesForRefresh(
  deps: CommandDeps,
  reason: string
): Promise<RepoInfo[]> {
  const vscodeRepos = await deps.vscodeGitStatus.getRepositories();
  const firstView = reason
    .split(",")
    .some((part) => part.trim() === "viewReady");
  if (vscodeRepos && !firstView) {
    return vscodeRepos;
  }
  const workspaceRepos = await discoverRepositories(deps.registry);
  if (!vscodeRepos) {
    return workspaceRepos;
  }
  const merged = new Map(
    vscodeRepos.map((repo) => [repositoryPathKey(repo.root), repo])
  );
  for (const repo of workspaceRepos) {
    merged.set(repositoryPathKey(repo.root), repo);
  }
  return [...merged.values()];
}

interface RefreshTask {
  section: ChangesRefreshSection;
  run: () => Promise<void>;
  promise?: Promise<void>;
}

/** 실행할 section과 지연 실행 함수를 task로 묶는다. */
function sectionTask(
  section: ChangesRefreshSection,
  run: () => Promise<void>
): RefreshTask {
  return { section, run };
}

/** 이미 병렬 시작한 section Promise를 나머지 task와 같은 완료/오류 처리 경로로 묶는다. */
function promisedSectionTask(
  section: ChangesRefreshSection,
  promise: Promise<void>
): RefreshTask {
  return { section, run: () => promise, promise };
}

/**
 * 저장소 탐색 중 활성 root가 바뀌어 폐기한 status prefetch의 오류를 unhandled rejection 없이 기록한다.
 * @param promise 이전 활성 저장소에서 이미 시작한 status 조회
 * @param root 조회 시작 당시 활성 저장소
 */
function observeSupersededWorkingPrefetch(
  promise: Promise<void>,
  root: string | undefined
): void {
  void promise.catch((error) => {
    logWarn("superseded working status prefetch failed", {
      root,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * refresh 내부 섹션 시간을 측정하고 느린 경우에만 OUTPUT 에 남긴다.
 * - 전체 refresh 가 느릴 때 git status/stash/branch 비교 중 어느 쪽이 원인인지 분리하기 위함이다.
 * @param section 섹션 이름
 * @param run     실제 조회 작업
 */
async function timedRefreshSection(
  section: string,
  run: () => Promise<void>
): Promise<void> {
  const started = Date.now();
  try {
    await run();
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= 250) {
      logInfo("changes refresh section slow", { section, elapsed });
    }
  }
}
