// 공용 FileSystemWatcher의 create/change/delete 이벤트 배선을 담당한다.
// - extension activation은 watcher 종류와 정책만 선언하고 반복적인 VS Code 구독 코드는 이 모듈에 위임한다.
import * as vscode from "vscode";
import { logInfo } from "../ui/outputLog";
import {
  RepositoryRefreshSkipFence,
  repoRootFromGitPath,
  repositoryRefreshScope,
  shouldLogIgnoredRefresh,
  shouldRefreshForGitPath,
} from "../utils/extensionRefreshPolicy";

/** 파일 시스템 watcher가 전달하는 이벤트 종류와 resource URI를 받는 handler. */
export type RefreshWatcherHandler = (
  event: "create" | "change" | "delete",
  uri: vscode.Uri
) => void;

/** focused 창에서만 감시할 안정적인 Git metadata 경로다. */
export const FOCUSED_GIT_METADATA_GLOB =
  "**/{.git/HEAD,.git/refs/**,.git/packed-refs,.git/MERGE_HEAD,.git/REBASE_HEAD,.git/CHERRY_PICK_HEAD,.git/REVERT_HEAD,.git/rebase-merge/**,.git/rebase-apply/**,.git/worktrees/**,.git/hooks/**,.husky/**,.githooks/**}";

/** Git metadata 이벤트를 extension의 cache/refresh queue에 연결하는 최소 callback 묶음이다. */
export interface GitMetadataRefreshTarget {
  relevantRoots: () => readonly (string | undefined)[];
  graphRoot: () => string | undefined;
  skipLog: RepositoryRefreshSkipFence;
  invalidateStatus: (repoRoot: string) => void;
  queueRepository: (repoRoot: string) => void;
  queueGraph: (repoRoot: string) => void;
  scheduleRefresh: (reason: string) => void;
}

/** provider event를 일반 표시 소비자와 Graph queue에 각각 보낼 최소 routing 결과다. */
export interface RepositoryEventRoute {
  scope: "active/full" | "repository-list-only" | "skip";
  graph: boolean;
}

/** linked-worktree admin delete의 동일 관측만 기억해 Graph queue 폭주를 막는다. */
class LinkedWorktreeDeleteLedger {
  private readonly deleted = new Set<string>();
  /** delete는 최초만 true이며 create/change는 새 material state로 다시 연다. */
  observe(path: string, event: "create" | "change" | "delete"): boolean {
    if (event !== "delete") { this.deleted.delete(path); return true; }
    if (this.deleted.has(path)) return false;
    this.deleted.add(path); return true;
  }
}

/**
 * watcher의 세 이벤트를 같은 handler에 연결하고 activation disposable 목록에 등록한다.
 * @param watcher 이미 생성한 VS Code FileSystemWatcher
 * @param handler create/change/delete와 URI를 함께 받을 refresh 정책 함수
 * @param subscriptions 이벤트 Disposable을 수명 주기에 묶을 activation 목록
 */
export function connectRefreshWatcher(
  watcher: vscode.FileSystemWatcher,
  handler: RefreshWatcherHandler,
  subscriptions: vscode.Disposable[]
): void {
  watcher.onDidCreate(
    (uri) => handler("create", uri),
    undefined,
    subscriptions
  );
  watcher.onDidChange(
    (uri) => handler("change", uri),
    undefined,
    subscriptions
  );
  watcher.onDidDelete(
    (uri) => handler("delete", uri),
    undefined,
    subscriptions
  );
}

/**
 * provider event의 일반 refresh 범위와 Graph reload 여부를 서로 독립적으로 계산한다.
 * @param reason vscodeGit state/head/identity/open/close 원인
 * @param repoRoot event 저장소 root
 * @param relevantRoots Changes·comparison·conflicts가 실제로 표시하는 roots
 * @param graphRoot 열린 Graph가 표시하는 정확한 root
 * @returns 일반 scope와 matching head Graph queue 여부
 */
export function routeRepositoryEvent(
  reason: string,
  repoRoot: string | undefined,
  relevantRoots: readonly (string | undefined)[],
  graphRoot: string | undefined
): RepositoryEventRoute {
  return {
    scope: repositoryRefreshScope({ reason, repoRoot, relevantRoots }),
    graph: shouldQueueGraphRefresh(reason, repoRoot, graphRoot),
  };
}

/**
 * Graph를 다시 읽어야 하는 repository reason/root 조합인지 판정한다.
 * @param reason provider·metadata·focus refresh 원인
 * @param repoRoot 원인이 가리키는 저장소 root
 * @param graphRoot 열린 Graph 저장소 root
 * @returns 동일 root의 head/stable metadata/focus reconciliation이면 true
 */
export function shouldQueueGraphRefresh(
  reason: string,
  repoRoot: string | undefined,
  graphRoot: string | undefined
): boolean {
  if (!repoRoot || !graphRoot || rootKey(repoRoot) !== rootKey(graphRoot)) {
    return false;
  }
  return reason === "vscodeGit:head" ||
    reason.includes("stable-git-state") ||
    reason === "windowFocusedReconcile";
}

/**
 * linked-worktree broadcast에 사용할 표시 root를 경로 정규화 key로 중복 제거한다.
 * @param roots Changes·comparison·conflicts·Graph에서 읽은 root 후보
 * @returns undefined와 중복을 제거하되 첫 실제 root 문자열을 보존한 배열
 */
export function visibleRepositoryRoots(
  roots: readonly (string | undefined)[]
): string[] {
  const unique = new Map<string, string>();
  for (const root of roots) {
    if (root && !unique.has(rootKey(root))) unique.set(rootKey(root), root);
  }
  return [...unique.values()];
}

/**
 * 좁은 Git metadata watcher 이벤트를 repository-aware refresh handler로 만든다.
 * - volatile/irrelevant root를 먼저 버리고, 관련 root의 cache와 graph queue만 갱신해 extension 조립부를 작게 유지한다.
 * @param target 현재 소비 root, cache invalidation, 후속 refresh callback 묶음
 * @returns FocusScopedRefreshWatcher에 연결할 create/change/delete handler
 */
export function createGitMetadataRefreshHandler(
  target: GitMetadataRefreshTarget
): RefreshWatcherHandler {
  const linkedWorktreeDeletes = new LinkedWorktreeDeleteLedger();
  return (event, uri) => {
    const relevantRoots = visibleRepositoryRoots(target.relevantRoots());
    const graphRoot = target.graphRoot();
    const hook = classifyHookPath(uri.fsPath, relevantRoots);
    if (hook) {
      if (hook.kind === "git-hook") {
        const roots = internalGitHookRefreshRoots(hook.repoRoot, relevantRoots);
        if (!roots.length) {
          logSkipped(target.skipLog, uri.fsPath, hook.kind, event);
          return;
        }
        logInfo("internal git hook refresh broadcast", {
          event,
          roots: roots.length,
          exactRoot: !!hook.repoRoot,
        });
        target.scheduleRefresh(`git:${event}:commit-hooks`);
        return;
      }
      if (!hook.repoRoot) {
        logSkipped(target.skipLog, uri.fsPath, hook.kind, event);
        return;
      }
      target.invalidateStatus(hook.repoRoot);
      target.scheduleRefresh(
        `working-tree-file:${event}:workspace-hook,custom-hook:${event}:commit-hooks`
      );
      return;
    }
    const decision = shouldRefreshForGitPath(uri.fsPath);
    if (!decision.refresh) {
      if (shouldLogIgnoredRefresh(decision.reason)) {
        logInfo("refresh event ignored", {
          source: "git",
          event,
          path: uri.fsPath,
          reason: decision.reason,
        });
      }
      return;
    }
    if (isLinkedWorktreeAdminPath(uri.fsPath)) {
      const broadcastRoots = visibleRepositoryRoots([...relevantRoots, graphRoot]);
      if (!broadcastRoots.length) {
        logSkipped(target.skipLog, uri.fsPath, "linked-worktree", event);
        return;
      }
      for (const root of broadcastRoots) {
        target.invalidateStatus(root);
        target.queueRepository(root);
        if (graphRoot && rootKey(root) === rootKey(graphRoot) && linkedWorktreeDeletes.observe(uri.fsPath, event)) {
          target.queueGraph(graphRoot);
        }
      }
      logInfo("linked worktree metadata refresh broadcast", {
        event,
        roots: broadcastRoots.length,
        reason: decision.reason,
      });
      target.scheduleRefresh(`git:${event}:${decision.reason}`);
      return;
    }
    const repoRoot = repoRootFromGitPath(uri.fsPath);
    const route = routeRepositoryEvent(
      `git:${event}:${decision.reason}`,
      repoRoot,
      relevantRoots,
      graphRoot
    );
    if (route.scope === "skip" && !route.graph) {
      logSkipped(target.skipLog, repoRoot ?? uri.fsPath, decision.reason, event);
      return;
    }
    if (!repoRoot) return;
    if (route.scope !== "skip") {
      target.invalidateStatus(repoRoot);
      target.queueRepository(repoRoot);
    }
    if (route.graph && graphRoot) target.queueGraph(graphRoot);
    target.scheduleRefresh(
      route.scope === "skip"
        ? `graph:git:${event}:${decision.reason}`
        : `git:${event}:${decision.reason}`
    );
  };
}

/**
 * linked worktree의 공용 admin metadata 경로인지 플랫폼 구분자와 무관하게 확인한다.
 * - main repository root로 잘못 귀속하면 inactive 저장소까지 갱신할 수 있어 별도 broadcast 경로로 보낸다.
 * @param fsPath FileSystemWatcher가 전달한 Git metadata 절대 경로
 * @returns `/.git/worktrees/<id>/...` 구조이면 true
 */
export function isLinkedWorktreeAdminPath(fsPath: string): boolean {
  return /\/\.git\/worktrees\/[^/]+\//.test(fsPath.replace(/\\/g, "/"));
}

/**
 * `.git/hooks`와 workspace hook 경로를 현재 표시 소비자 저장소에 연결한다.
 * - 내부 hook은 exact Git root만 먼저 찾고, workspace hook은 중첩 저장소에서 가장 깊은 포함 root를 선택한다.
 * @param fsPath watcher가 전달한 hook 파일 절대 경로
 * @param relevantRoots Changes·comparison·conflicts가 현재 표시하는 중복 제거된 root
 * @returns hook 종류와 exact/deepest root, hook 경로가 아니면 undefined
 */
export function classifyHookPath(
  fsPath: string,
  relevantRoots: readonly string[]
): { kind: "git-hook" | "workspace-hook"; repoRoot?: string } | undefined {
  const normalized = fsPath.replace(/\\/g, "/");
  if (/\/\.git\/hooks\//.test(normalized)) {
    const root = repoRootFromGitPath(fsPath);
    return {
      kind: "git-hook",
      repoRoot: relevantRoots.find((item) => root && rootKey(item) === rootKey(root)),
    };
  }
  if (!/\/(?:\.husky|\.githooks)\//.test(normalized)) return undefined;
  const repoRoot = [...relevantRoots]
    .filter((root) => pathBelongsToRoot(normalized, root))
    .sort((left, right) => rootKey(right).length - rootKey(left).length)[0];
  return { kind: "workspace-hook", repoRoot };
}

/**
 * 내부 Git hook이 exact main root와 일치하지 않을 때 안전하게 갱신할 표시 root를 고른다.
 * - linked worktree는 main `.git/hooks`를 공유하므로 visible root가 있으면 hook-only refresh를 허용한다.
 * @param exactRoot hook 경로와 정확히 일치한 표시 저장소 root
 * @param relevantRoots 현재 표시 소비자의 저장소 root 후보
 * @returns exact root 하나 또는 중복 제거한 visible roots, 소비자가 없으면 빈 배열
 */
export function internalGitHookRefreshRoots(
  exactRoot: string | undefined,
  relevantRoots: readonly string[]
): string[] {
  return exactRoot ? [exactRoot] : visibleRepositoryRoots(relevantRoots);
}

/**
 * TTL fence를 통과한 watcher skip만 root/reason/count와 함께 OUTPUT에 남긴다.
 * - 반복 metadata 이벤트를 집계해 진단 가능성은 유지하면서 OUTPUT 폭주를 막는다.
 * @param fence root/reason별 누적 횟수와 마지막 로그 시각을 보관하는 제한기
 * @param root skip된 저장소 root 또는 아직 해석하지 못한 원본 경로
 * @param reason stable/hook/linked 등 skip 판정 이유
 * @param event watcher가 전달한 create/change/delete 종류
 * @returns 로그와 집계 상태만 갱신하며 반환값은 없다
 */
function logSkipped(
  fence: RepositoryRefreshSkipFence,
  root: string,
  reason: string,
  event: "create" | "change" | "delete"
): void {
  const count = fence.record(`${rootKey(root)}\0${reason}`);
  if (count !== undefined) {
    logInfo("metadata refresh event skipped", { event, repoRoot: root, reason, count });
  }
}

/**
 * 파일 또는 metadata 경로가 저장소 root 자체이거나 하위인지 경계 안전하게 확인한다.
 * - 단순 prefix 비교가 `/repo-old`을 `/repo` 하위로 오인하지 않도록 slash 경계를 강제한다.
 * @param fsPath 포함 여부를 확인할 파일 절대 경로
 * @param root 후보 저장소의 절대 root
 * @returns 정규화된 동일 경로 또는 root 하위 경로이면 true
 */
function pathBelongsToRoot(fsPath: string, root: string): boolean {
  const file = rootKey(fsPath);
  const candidate = rootKey(root);
  return file === candidate || file.startsWith(`${candidate}/`);
}

/**
 * 저장소 경로 비교에서 slash·trailing slash·Windows drive 대소문자 차이를 제거한다.
 * - 실제 파일 접근 경로는 바꾸지 않고 watcher routing과 dedupe에만 쓰는 안정적인 key를 만든다.
 * @param value 저장소 root 또는 비교할 파일 경로
 * @returns slash와 끝 구분자가 정규화된 비교 전용 문자열
 */
function rootKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * activation-level Git metadata watcher를 창 focus 수명에 맞춰 하나만 유지한다.
 * - unfocused 동안 watcher와 세 이벤트 구독을 모두 해제해 여러 창/worktree의 watcher 비용을 없앤다.
 * - focus 복귀 후 새 watcher를 만든 사실만 반환하고, 누락 상태 reconciliation은 extension 조립부가 결정한다.
 */
export class FocusScopedRefreshWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly eventDisposables: vscode.Disposable[] = [];

  /**
   * @param pattern 안정적인 Git metadata만 포함하는 좁은 glob
   * @param handler create/change/delete 이벤트 처리 함수
   */
  constructor(
    private readonly pattern: vscode.GlobPattern,
    private readonly handler: RefreshWatcherHandler
  ) {}

  /**
   * 현재 창 focus에 맞춰 watcher를 생성하거나 완전히 해제한다.
   * @param focused VS Code window의 최신 focus 상태
   * @returns watcher 수명이 실제로 바뀌었으면 true
   */
  setFocused(focused: boolean): boolean {
    if (focused === !!this.watcher) {
      return false;
    }
    if (!focused) {
      this.disposeWatcher();
      return true;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(this.pattern);
    connectRefreshWatcher(this.watcher, this.handler, this.eventDisposables);
    return true;
  }

  /** activation 종료 시 watcher와 동적 이벤트 구독을 모두 정리한다. */
  dispose(): void {
    this.disposeWatcher();
  }

  /**
   * 현재 watcher의 이벤트 구독을 먼저 끊고 watcher 자체를 해제한다.
   * @returns 반환값 없이 다음 focus에서 안전하게 재생성할 빈 상태를 만든다.
   */
  private disposeWatcher(): void {
    for (const disposable of this.eventDisposables.splice(0)) {
      disposable.dispose();
    }
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
