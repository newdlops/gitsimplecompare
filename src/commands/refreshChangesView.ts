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
import { logError, logInfo, logWarn } from "../ui/outputLog";

let refreshInFlight = false;
let refreshPending = false;
let refreshPendingReason = "";
let refreshSequence = 0;

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
  if (refreshInFlight) {
    refreshPending = true;
    refreshPendingReason = mergeReason(refreshPendingReason, reason);
    logInfo("changes refresh queued", { reason });
    return;
  }
  const runId = ++refreshSequence;
  refreshInFlight = true;
  logInfo("changes refresh started", { runId, reason });
  try {
    let currentReason = reason;
    do {
      refreshPending = false;
      refreshPendingReason = "";
      await refreshChangesViewOnce(deps, currentReason);
      currentReason = refreshPendingReason || reason;
    } while (refreshPending);
    logInfo("changes refresh finished", { runId });
  } catch (error) {
    logError("changes refresh failed", error, { runId, reason });
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Git Simple Compare refresh failed. See the Git Simple Compare output for details."
      )
    );
  } finally {
    refreshInFlight = false;
  }
}

/** 실제 git 조회를 한 번 수행한다. 겹친 호출은 refreshChangesView 가 직렬화한다. */
async function refreshChangesViewOnce(
  deps: CommandDeps,
  reason: string
): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: "gitSimpleCompare.changes" } },
    async () => {
      const sections = refreshSectionsForReason(reason);
      logInfo("changes refresh scoped", { reason, sections });
      if (shouldInvalidateStatusCaches(reason)) {
        deps.registry.invalidateStatusCaches();
      }
      if (sections.includes("repositories") || !deps.changesView.getActiveRepo()) {
        const repositories = await discoverRepositoriesForRefresh(deps);
        const preferredRoot = await resolvePreferredRepositoryRoot(deps.registry, repositories);
        deps.changesView.setRepositories(repositories, preferredRoot);
      }
      const forceGitStatus = shouldForceGitStatus(reason);
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
    }
  );
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

type RefreshSection =
  | "repositories"
  | "workingChanges"
  | "fileHistory"
  | "stashes"
  | "worktrees"
  | "comparison";

interface RefreshTask {
  section: RefreshSection;
  run: () => Promise<void>;
}

/** refresh 사유를 합쳐 pending refresh 가 어떤 범위를 봐야 하는지 보존한다. */
function mergeReason(previous: string, reason: string): string {
  return previous ? `${previous},${reason}` : reason;
}

/**
 * refresh 사유에 따라 필요한 git 조회 범위를 고른다.
 * - 파일 저장/작업트리 변경/hunk stage/VS Code Git 상태 이벤트는 stash 와 branch comparison 을 다시 읽지 않는다.
 * @param reason refresh 요청 사유
 */
function refreshSectionsForReason(reason: string): RefreshSection[] {
  if (isWorkingOnlyReason(reason)) {
    return ["workingChanges"];
  }
  return [
    "repositories",
    "workingChanges",
    "fileHistory",
    "stashes",
    "worktrees",
    "comparison",
  ];
}

/** 작업트리 상태만 바뀐 refresh 사유인지 확인한다. */
function isWorkingOnlyReason(reason: string): boolean {
  const parts = reason.split(",").map((part) => part.trim()).filter(Boolean);
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        part.includes("working-tree-file") ||
        part === "documentSaved" ||
        part === "filesCreated" ||
        part === "filesDeleted" ||
        part === "filesRenamed" ||
        part === "vscodeGit:state" ||
        part.includes("ignore-rules") ||
        part.includes("conflict") ||
        part.startsWith("hunkCheckbox:") ||
        part.startsWith("editorHunks:")
    )
  );
}

/** 직접 git index 를 바꾸는 명령은 watcher 를 기다리지 않고 status cache 를 먼저 비운다. */
function shouldInvalidateStatusCaches(reason: string): boolean {
  return (
    reason === "command" ||
    reason.split(",").some((part) => {
      const item = part.trim();
      return (
        item === "command" ||
        item.includes("conflict") ||
        item.includes("ignore-rules") ||
        item.startsWith("hunkCheckbox:") ||
        item.startsWith("editorHunks:")
      );
    })
  );
}

/**
 * 작업트리 상태를 VS Code Git provider 캐시 대신 Git CLI 로 직접 다시 읽어야 하는지 판단한다.
 * - 사용자가 누른 refresh/뷰 진입/ignore 규칙 변경은 provider 상태가 아직 이전 값일 수 있으므로 강제 조회한다.
 * @param reason refresh 요청 사유 목록
 */
function shouldForceGitStatus(reason: string): boolean {
  return reason.split(",").some((part) => {
    const item = part.trim();
    return (
      item === "command" ||
      item === "viewReady" ||
      item === "viewVisible" ||
      item.includes("ignore-rules")
    );
  });
}

/** 선택된 section 만 실행 목록에 넣는다. */
function sectionTask(
  sections: RefreshSection[],
  section: RefreshSection,
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
