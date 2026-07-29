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
  "**/.git/{HEAD,refs/**,packed-refs,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**,worktrees/**}";

/** Git metadata 이벤트를 extension의 cache/refresh queue에 연결하는 최소 callback 묶음이다. */
export interface GitMetadataRefreshTarget {
  relevantRoots: () => readonly (string | undefined)[];
  skipLog: RepositoryRefreshSkipFence;
  invalidateStatus: () => void;
  queueRepository: (repoRoot: string) => void;
  queueUnknownRepository: () => void;
  scheduleRefresh: (reason: string) => void;
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
 * 좁은 Git metadata watcher 이벤트를 repository-aware refresh handler로 만든다.
 * - volatile/irrelevant root를 먼저 버리고, 관련 root의 cache와 graph queue만 갱신해 extension 조립부를 작게 유지한다.
 * @param target 현재 소비 root, cache invalidation, 후속 refresh callback 묶음
 * @returns FocusScopedRefreshWatcher에 연결할 create/change/delete handler
 */
export function createGitMetadataRefreshHandler(
  target: GitMetadataRefreshTarget
): RefreshWatcherHandler {
  return (event, uri) => {
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
    const repoRoot = repoRootFromGitPath(uri.fsPath);
    const scope = repositoryRefreshScope({
      reason: "vscodeGit:head",
      repoRoot,
      relevantRoots: target.relevantRoots(),
    });
    if (scope === "skip") {
      const count = target.skipLog.record(
        `${repoRoot ?? "unknown"}\0metadata:${decision.reason}`
      );
      if (count !== undefined) {
        logInfo("metadata refresh event skipped", {
          event,
          repoRoot,
          reason: decision.reason,
          count,
        });
      }
      return;
    }
    target.invalidateStatus();
    if (repoRoot) target.queueRepository(repoRoot);
    else target.queueUnknownRepository();
    target.scheduleRefresh(`git:${event}:${decision.reason}`);
  };
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
