// git worktree 상태 조회와 웹뷰 상태 변환 모듈.
// - 명령 핸들러(worktrees.ts)가 사용자 입력 흐름에 집중하도록 상태 수집/컨텍스트 갱신을 분리한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { WorktreeInfo, WorktreeService } from "../git/worktreeService";
import type { WorktreeView } from "../webview/changesViewTypes";
import { logError, logInfo } from "../ui/outputLog";
import { CommandDeps, discoverRepositories } from "./shared";

/** worktree 명령에 전달할 최소 컨텍스트 */
export interface WorktreeCommandArg {
  /** `git worktree` 명령을 실행할 저장소 루트 */
  repoRoot: string;
  /** 대상 worktree 루트 경로 */
  path: string;
  /** main worktree 여부. main worktree 는 삭제/이동할 수 없다. */
  isMain: boolean;
  /** 표시용 브랜치 이름. detached worktree 면 undefined 다. */
  branch?: string;
}

/** 하나의 저장소에서 조회한 worktree 묶음 */
export interface WorktreeRepositoryGroup {
  /** 이 저장소 그룹에서 git 명령을 실행할 기준 루트 */
  repoRoot: string;
  /** 표시할 저장소 이름 */
  repoName: string;
  /** 표시할 worktree 목록 */
  worktrees: WorktreeInfo[];
}

/**
 * Changes 웹뷰의 Worktrees 섹션에 표시할 상태를 다시 읽는다.
 * - native TreeView 없이도 같은 git 조회 결과를 웹뷰와 view/title when 컨텍스트에 공급한다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function refreshWorktreesForChangesView(
  deps: CommandDeps
): Promise<void> {
  const groups = await readWorkspaceWorktreeGroups(deps);
  const rows = groups.flatMap((group) =>
    group.worktrees.map((worktree) => toWorktreeView(group, worktree))
  );
  deps.changesView.setWorktrees(rows);
  await updateLinkedWorktreeContext(groups);
  logInfo("worktrees refreshed", {
    repositories: groups.length,
    worktrees: rows.length,
    linkedWorktrees: rows.filter((worktree) => !worktree.isMain).length,
  });
}

/**
 * 워크스페이스에서 접근 가능한 저장소들의 worktree 목록을 읽는다.
 * - 같은 저장소가 여러 workspace folder 로 잡혀도 main worktree 경로 기준으로 중복 제거한다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function readWorkspaceWorktreeGroups(
  deps: CommandDeps
): Promise<WorktreeRepositoryGroup[]> {
  const knownRepositories = deps.changesView.getRepositories();
  const repositories = knownRepositories.length
    ? knownRepositories
    : await discoverRepositories(deps.registry);
  const activeRepo = deps.changesView.getActiveRepo();
  repositories.sort((a, b) => {
    if (a.root === activeRepo) {
      return -1;
    }
    if (b.root === activeRepo) {
      return 1;
    }
    return a.root.localeCompare(b.root);
  });

  const groups: WorktreeRepositoryGroup[] = [];
  const seenRepositoryKeys = new Set<string>();
  const coveredWorktreeRoots = new Set<string>();
  for (const repo of repositories) {
    if (coveredWorktreeRoots.has(normalizeWorktreeRoot(repo.root))) {
      continue;
    }
    try {
      const worktrees = await new WorktreeService(repo.root).listWorktrees();
      const repositoryKey = normalizeWorktreeRoot(worktrees[0]?.path ?? repo.root);
      if (seenRepositoryKeys.has(repositoryKey)) {
        continue;
      }
      seenRepositoryKeys.add(repositoryKey);
      for (const worktree of worktrees) {
        coveredWorktreeRoots.add(normalizeWorktreeRoot(worktree.path));
      }
      groups.push({
        repoRoot: repo.root,
        repoName: path.basename(worktrees[0]?.path ?? repo.root) || repo.root,
        worktrees,
      });
    } catch (err) {
      logError("worktrees refresh failed for repository", err, {
        repoRoot: repo.root,
      });
    }
  }
  return groups;
}

/**
 * worktree 루트 경로를 중복 판정용 문자열로 정규화한다.
 * - 첫 `git worktree list` 결과에 포함된 linked worktree가 뒤의 workspace repository 후보로
 *   다시 나타나도 Git 명령 실행 전에 건너뛸 수 있게 한다.
 * @param root worktree 절대 경로
 * @returns 플랫폼 경로 규칙을 반영한 비교 키
 */
function normalizeWorktreeRoot(root: string): string {
  const normalized = path.resolve(root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** TreeItem/webview command 에 전달할 안전한 POJO 인자를 만든다. */
export function toWorktreeCommandArg(
  repoRoot: string,
  info: WorktreeInfo
): WorktreeCommandArg {
  return {
    repoRoot,
    path: info.path,
    isMain: info.isMain,
    branch: info.branch,
  };
}

/** worktree 정보를 웹뷰 렌더 payload 행으로 변환한다. */
function toWorktreeView(
  group: WorktreeRepositoryGroup,
  worktree: WorktreeInfo
): WorktreeView {
  return {
    repoRoot: group.repoRoot,
    repoName: group.repoName,
    path: worktree.path,
    name: path.basename(worktree.path) || worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    isMain: worktree.isMain,
    locked: worktree.locked,
    prunable: worktree.prunable,
  };
}

/** linked worktree 존재 여부를 VS Code view/title when 컨텍스트에 반영한다. */
async function updateLinkedWorktreeContext(
  groups: WorktreeRepositoryGroup[]
): Promise<void> {
  const hasLinked = groups.some((group) =>
    group.worktrees.some((worktree) => !worktree.isMain)
  );
  await vscode.commands.executeCommand(
    "setContext",
    "gitSimpleCompare.hasLinkedWorktrees",
    hasLinked
  );
}
