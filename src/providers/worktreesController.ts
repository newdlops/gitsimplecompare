// worktree 트리뷰 상태를 조정하는 controller 모듈.
// - 워크스페이스 저장소 탐지 → worktree 조회 → provider/컨텍스트 키 갱신을 담당한다.
// - git 명령 실행은 WorktreeService, 표시 변환은 WorktreesTreeProvider 에 위임한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { WorktreeService } from "../git/worktreeService";
import { logError, logInfo } from "../ui/outputLog";
import {
  WorktreeCommandArg,
  WorktreeRepositoryGroup,
  WorktreesTreeProvider,
  toWorktreeCommandArg,
} from "./worktreesTreeProvider";

/** linked worktree 존재 여부를 view/title 메뉴 when 절에서 쓰기 위한 컨텍스트 키 */
export const HAS_LINKED_WORKTREES_CONTEXT =
  "gitSimpleCompare.hasLinkedWorktrees";

/** worktree 사이드 패널의 상태를 관리하는 컨트롤러 */
export class WorktreesController {
  private refreshing = false;
  private pendingRefresh = false;

  constructor(
    private readonly registry: GitServiceRegistry,
    private readonly provider: WorktreesTreeProvider
  ) {}

  /**
   * 현재 트리에 표시된 저장소별 worktree 상태를 반환한다.
   * - header 메뉴 명령이 별도 git 조회 없이 대상 목록을 고를 때 사용한다.
   */
  getState(): WorktreeRepositoryGroup[] {
    return this.provider.getState();
  }

  /**
   * 현재 트리에 표시된 linked worktree 들을 평면 목록으로 반환한다.
   * - main worktree 는 Git 이 삭제/이동 대상으로 허용하지 않아 제외한다.
   */
  getLinkedWorktrees(): WorktreeCommandArg[] {
    return this.getState().flatMap((group) =>
      group.worktrees
        .filter((worktree) => !worktree.isMain)
        .map((worktree) => toWorktreeCommandArg(group.repoRoot, worktree))
    );
  }

  /**
   * 워크스페이스의 git 저장소들을 다시 탐지하고 worktree 목록을 갱신한다.
   * - 파일 이벤트가 몰려도 git 조회가 겹치지 않도록 직렬화한다.
   * - 저장소가 없거나 일부 조회가 실패해도 사용자 경고를 띄우지 않고 OUTPUT 에만 남긴다.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }

    this.refreshing = true;
    try {
      do {
        this.pendingRefresh = false;
        await this.refreshOnce();
      } while (this.pendingRefresh);
    } finally {
      this.refreshing = false;
    }
  }

  /** 실제 worktree 상태를 한 번 읽어 provider 와 컨텍스트 키를 갱신한다. */
  private async refreshOnce(): Promise<void> {
    const repoRoots = await this.resolveWorkspaceRepoRoots();
    const groups: WorktreeRepositoryGroup[] = [];
    const seenRepositoryKeys = new Set<string>();

    for (const repoRoot of repoRoots) {
      try {
        const worktrees = await new WorktreeService(repoRoot).listWorktrees();
        const repositoryKey = worktrees[0]?.path ?? repoRoot;
        if (seenRepositoryKeys.has(repositoryKey)) {
          continue;
        }
        seenRepositoryKeys.add(repositoryKey);
        groups.push({ kind: "repository", repoRoot, worktrees });
      } catch (err) {
        logError("worktrees refresh failed for repository", err, { repoRoot });
      }
    }

    this.provider.setState(groups);
    this.updateContext(groups);
    logInfo("worktrees refreshed", {
      repositories: groups.length,
      worktrees: groups.reduce((sum, group) => sum + group.worktrees.length, 0),
      linkedWorktrees: groups.reduce(
        (sum, group) =>
          sum + group.worktrees.filter((worktree) => !worktree.isMain).length,
        0
      ),
    });
  }

  /**
   * 워크스페이스 안에서 접근 가능한 git 저장소 루트를 중복 없이 찾는다.
   * - 활성 에디터 파일을 먼저 보고, 이어서 모든 workspace folder 를 검사한다.
   */
  private async resolveWorkspaceRepoRoots(): Promise<string[]> {
    const roots = new Set<string>();
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === "file") {
      const fromActive = await this.registry.resolve(path.dirname(active.fsPath));
      if (fromActive) {
        roots.add(fromActive.repoRoot);
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const service = await this.registry.resolve(folder.uri.fsPath);
      if (service) {
        roots.add(service.repoRoot);
      }
    }
    return Array.from(roots);
  }

  /**
   * linked worktree 존재 여부를 VS Code context 에 반영한다.
   * @param groups 현재 조회된 저장소별 worktree 묶음
   */
  private updateContext(groups: WorktreeRepositoryGroup[]): void {
    const hasLinked = groups.some((group) =>
      group.worktrees.some((worktree) => !worktree.isMain)
    );
    void vscode.commands.executeCommand(
      "setContext",
      HAS_LINKED_WORKTREES_CONTEXT,
      hasLinked
    );
  }
}
