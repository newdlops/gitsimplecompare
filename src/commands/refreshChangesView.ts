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
  resolvePreferredRepositoryRoot,
} from "./shared";
import { refreshWorkingChanges } from "./workingChanges";
import { refreshWorktreesForChangesView } from "./worktreeState";
import { refreshCommitHooks } from "./commitHooks";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  ChangesRefreshSection,
  RefreshDrain,
  changesRefreshSections,
  shouldForceChangesGitStatus,
  shouldInvalidateChangesStatus,
  shouldShowChangesRefreshProgress,
} from "../utils/extensionRefreshPolicy";

let refreshSequence = 0;
let refreshCoordinator:
  | { deps: CommandDeps; drain: RefreshDrain }
  | undefined;

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
  const drain = changesRefreshDrain(deps);
  if (drain.isRunning()) {
    logInfo("changes refresh queued", { reason });
  }
  await drain.request(reason);
}

/**
 * 현재 활성화의 공유 refresh drain을 반환한다.
 * - 확장 재활성화로 CommandDeps 인스턴스가 바뀌면 이전 모듈 상태를 재사용하지 않고 새 queue를 만든다.
 * @param deps 현재 확장 활성화에서 공유하는 명령 의존성
 * @returns 겹친 refresh를 직렬화하고 호출자 완료를 보장하는 drain
 */
function changesRefreshDrain(deps: CommandDeps): RefreshDrain {
  if (!refreshCoordinator || refreshCoordinator.deps !== deps) {
    refreshCoordinator = {
      deps,
      drain: new RefreshDrain((reason) => runChangesRefreshPass(deps, reason)),
    };
  }
  return refreshCoordinator.drain;
}

/**
 * 합쳐진 원인으로 실제 Changes refresh 한 pass를 실행하고 오류를 사용자/OUTPUT에 보고한다.
 * @param deps 공유 의존성
 * @param reason 이 pass에 포함된 중복 제거 원인 문자열
 */
async function runChangesRefreshPass(
  deps: CommandDeps,
  reason: string
): Promise<void> {
  const runId = ++refreshSequence;
  logInfo("changes refresh started", { runId, reason });
  try {
    await refreshChangesViewOnce(deps, reason);
    logInfo("changes refresh finished", { runId });
    scheduleDeferredReadyRefresh(deps, reason);
  } catch (error) {
    logError("changes refresh failed", error, { runId, reason });
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Git Simple Compare refresh failed. See the Git Simple Compare output for details."
      )
    );
  }
}

/**
 * 웹뷰 최초 표시의 저장소/working 상태가 그려진 뒤 부가 섹션을 별도 silent pass로 예약한다.
 * @param deps 같은 activation의 refresh drain을 찾기 위한 명령 의존성
 * @param reason 방금 완료한 pass에 합쳐진 refresh 원인
 */
function scheduleDeferredReadyRefresh(deps: CommandDeps, reason: string): void {
  const reasons = new Set(
    reason.split(",").map((item) => item.trim()).filter(Boolean)
  );
  if (!reasons.has("viewReady") || reasons.has("viewReadyDeferred")) return;
  void changesRefreshDrain(deps).request("viewReadyDeferred").catch((error) => {
    logWarn("deferred Changes sections refresh failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

/** 실제 git 조회를 한 번 수행한다. 겹친 호출은 refreshChangesView 가 직렬화한다. */
async function refreshChangesViewOnce(
  deps: CommandDeps,
  reason: string
): Promise<void> {
  const refresh = async (): Promise<void> => {
    const sections = changesRefreshSections(reason);
    logInfo("changes refresh scoped", { reason, sections });
    if (shouldInvalidateChangesStatus(reason)) {
      deps.registry.invalidateStatusCaches();
    }
    if (sections.includes("repositories") || !deps.changesView.getActiveRepo()) {
      const repositories = await discoverRepositoriesForRefresh(deps);
      const preferredRoot = await resolvePreferredRepositoryRoot(deps.registry, repositories);
      deps.changesView.setRepositories(repositories, preferredRoot);
    }
    const forceGitStatus = shouldForceChangesGitStatus(reason);
    const tasks = [
      sectionTask(sections, "workingChanges", () =>
        refreshWorkingChanges(deps, { forceGit: forceGitStatus })
      ),
      sectionTask(sections, "fileHistory", () =>
        refreshFileHistory(deps, { reason })
      ),
      sectionTask(sections, "stashes", () => refreshStashes(deps)),
      sectionTask(sections, "worktrees", () =>
        refreshWorktreesForChangesView(deps)
      ),
      sectionTask(sections, "commitHooks", () => refreshCommitHooks(deps)),
      sectionTask(sections, "comparison", () => refreshActiveComparison(deps)),
    ].filter((task): task is RefreshTask => !!task);
    const results = await Promise.allSettled(
      tasks.map((task) => timedRefreshSection(task.section, task.run))
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
  };
  if (shouldShowChangesRefreshProgress(reason)) {
    await vscode.window.withProgress(
      { location: { viewId: "gitSimpleCompare.changes" } },
      refresh
    );
  } else {
    await refresh();
  }
}

/**
 * Changes 뷰에 표시할 저장소 목록을 조회한다.
 * - VS Code 내장 Git 이 이미 저장소/브랜치를 알고 있으면 그 상태를 재사용해 `rev-parse` 반복 실행을 피한다.
 * - 내장 Git API 를 사용할 수 없는 환경에서만 기존 CLI 기반 탐색으로 폴백한다.
 * @param deps 공유 의존성
 */
async function discoverRepositoriesForRefresh(
  deps: CommandDeps
): Promise<RepoInfo[]> {
  const vscodeRepos = await deps.vscodeGitStatus.getRepositories();
  if (vscodeRepos) {
    return vscodeRepos;
  }
  return discoverRepositories(deps.registry);
}

interface RefreshTask {
  section: ChangesRefreshSection;
  run: () => Promise<void>;
}

/** 선택된 section 만 실행 목록에 넣는다. */
function sectionTask(
  sections: ChangesRefreshSection[],
  section: ChangesRefreshSection,
  run: () => Promise<void>
): RefreshTask | undefined {
  return sections.includes(section) ? { section, run } : undefined;
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
