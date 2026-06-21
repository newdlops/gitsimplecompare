// Git worktree 목록을 액티비티 바 트리뷰로 보여주는 프로바이더.
// - git 조회/생성/삭제는 controller/command 에 위임하고, 여기서는 상태를 보관해 TreeItem 으로 변환한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorktreeInfo } from "../git/worktreeService";

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
  kind: "repository";
  /** 이 저장소 그룹에서 git 명령을 실행할 기준 루트 */
  repoRoot: string;
  /** 표시할 worktree 목록 */
  worktrees: WorktreeInfo[];
}

/** 트리에 표시되는 worktree 행 */
export interface WorktreeNode {
  kind: "worktree";
  /** 이 worktree 가 속한 저장소 그룹의 기준 루트 */
  repoRoot: string;
  /** 실제 worktree 상태 */
  worktree: WorktreeInfo;
}

/** worktree 트리에서 쓰는 element 타입 */
export type WorktreeTreeElement = WorktreeRepositoryGroup | WorktreeNode;

/** Git worktree 트리뷰 provider */
export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<WorktreeTreeElement>
{
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<WorktreeTreeElement | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private groups: WorktreeRepositoryGroup[] = [];

  /**
   * 표시할 저장소별 worktree 목록을 교체하고 트리를 갱신한다.
   * @param groups 저장소별 worktree 묶음. provider 는 그대로 보관하고 표시만 담당한다.
   */
  setState(groups: WorktreeRepositoryGroup[]): void {
    this.groups = groups;
    this.onDidChangeEmitter.fire(undefined);
  }

  /**
   * 현재 provider 가 보관 중인 worktree 상태를 복사해 반환한다.
   * - 명령 레이어가 header 메뉴에서 대상 worktree 를 고를 때 최신 트리 상태를 재사용한다.
   */
  getState(): WorktreeRepositoryGroup[] {
    return this.groups.map((group) => ({
      ...group,
      worktrees: group.worktrees.map((item) => ({ ...item })),
    }));
  }

  /**
   * 저장소 그룹 또는 worktree 한 건을 VS Code TreeItem 으로 변환한다.
   * @param element 트리 element
   */
  getTreeItem(element: WorktreeTreeElement): vscode.TreeItem {
    return element.kind === "repository"
      ? this.repositoryTreeItem(element)
      : this.worktreeTreeItem(element);
  }

  /**
   * 루트에서는 저장소 그룹 목록을, 저장소 그룹 아래에서는 worktree 목록을 반환한다.
   * @param element 부모 element. 없으면 트리 루트를 뜻한다.
   */
  getChildren(element?: WorktreeTreeElement): WorktreeTreeElement[] {
    if (!element) {
      return this.groups;
    }
    if (element.kind === "repository") {
      return element.worktrees.map((worktree) => ({
        kind: "worktree",
        repoRoot: element.repoRoot,
        worktree,
      }));
    }
    return [];
  }

  /** 저장소 그룹을 접을 수 있는 트리 항목으로 만든다. */
  private repositoryTreeItem(group: WorktreeRepositoryGroup): vscode.TreeItem {
    const mainPath = group.worktrees[0]?.path ?? group.repoRoot;
    const item = new vscode.TreeItem(
      path.basename(mainPath) || mainPath,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = vscode.l10n.t("{0} worktree(s)", group.worktrees.length);
    item.tooltip = vscode.l10n.t("Repository: {0}", group.repoRoot);
    item.iconPath = new vscode.ThemeIcon("repo");
    item.contextValue = "gitSimpleCompare.worktreeRepository";
    return item;
  }

  /** worktree 한 건을 열기 가능한 트리 항목으로 만든다. */
  private worktreeTreeItem(node: WorktreeNode): vscode.TreeItem {
    const info = node.worktree;
    const label = path.basename(info.path) || info.path;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = this.worktreeDescription(info);
    item.resourceUri = vscode.Uri.file(info.path);
    item.iconPath = new vscode.ThemeIcon(info.isMain ? "repo" : "repo-forked");
    item.contextValue = info.isMain
      ? "gitSimpleCompare.worktree.main"
      : "gitSimpleCompare.worktree.linked";
    item.tooltip = this.worktreeTooltip(info);
    item.command = {
      command: "gitSimpleCompare.openWorktree",
      title: vscode.l10n.t("Open Worktree"),
      arguments: [toWorktreeCommandArg(node.repoRoot, info)],
    };
    return item;
  }

  /** worktree 행 오른쪽에 표시할 짧은 상태 설명을 만든다. */
  private worktreeDescription(info: WorktreeInfo): string {
    const labels = [
      info.branch ?? vscode.l10n.t("detached"),
      info.isMain ? vscode.l10n.t("main") : undefined,
      info.locked !== undefined ? vscode.l10n.t("locked") : undefined,
      info.prunable !== undefined ? vscode.l10n.t("prunable") : undefined,
    ].filter((value): value is string => Boolean(value));
    return labels.join(" · ");
  }

  /** hover 에서 worktree 경로와 git 상태를 확인할 수 있는 상세 문자열을 만든다. */
  private worktreeTooltip(info: WorktreeInfo): string {
    const lines = [
      vscode.l10n.t("Path: {0}", info.path),
      info.branch
        ? vscode.l10n.t("Branch: {0}", info.branch)
        : vscode.l10n.t("Detached HEAD"),
      info.head ? vscode.l10n.t("HEAD: {0}", info.head) : undefined,
      info.locked !== undefined
        ? vscode.l10n.t("Locked: {0}", info.locked || vscode.l10n.t("yes"))
        : undefined,
      info.prunable !== undefined
        ? vscode.l10n.t("Prunable: {0}", info.prunable || vscode.l10n.t("yes"))
        : undefined,
      vscode.l10n.t("Click to open this worktree in a new window."),
    ].filter((value): value is string => Boolean(value));
    return lines.join("\n");
  }
}

/**
 * TreeItem command/context menu 에 전달할 안전한 POJO 인자를 만든다.
 * @param repoRoot git 명령 기준 루트
 * @param info worktree 정보
 */
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
