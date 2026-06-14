// 충돌(unmerged) 파일 목록을 액티비티 바 트리뷰로 보여주는 프로바이더.
// - 데이터(충돌 경로/저장소 루트)는 외부(ConflictsController)에서 주입받아 보관만 한다.
//   git 접근이나 해결 로직은 포함하지 않는다(경계 분리).
import * as vscode from "vscode";

/**
 * 충돌 파일 트리뷰. element 는 저장소 상대 경로(string)다.
 */
export class ConflictsTreeProvider
  implements vscode.TreeDataProvider<string>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    string | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private repoRoot = "";
  private conflicts: string[] = [];

  /**
   * 표시할 충돌 목록을 교체하고 트리를 갱신한다.
   * @param repoRoot  저장소 루트(파일 URI 계산용)
   * @param conflicts 충돌 파일의 저장소 상대 경로 목록
   */
  setState(repoRoot: string, conflicts: string[]): void {
    this.repoRoot = repoRoot;
    this.conflicts = conflicts;
    this.onDidChangeEmitter.fire(undefined);
  }

  /**
   * 충돌 파일 한 건을 트리 항목으로 변환한다.
   * - 클릭하면 해당 파일을 열어 충돌을 해결하도록 한다(머지 에디터 명령으로 위임).
   * @param rel 저장소 상대 경로
   */
  getTreeItem(rel: string): vscode.TreeItem {
    const slash = rel.lastIndexOf("/");
    const fileName = slash >= 0 ? rel.slice(slash + 1) : rel;
    const dirName = slash >= 0 ? rel.slice(0, slash) : "";
    const uri = vscode.Uri.file(`${this.repoRoot}/${rel}`);

    const item = new vscode.TreeItem(
      fileName,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = dirName;
    item.resourceUri = uri;
    item.iconPath = new vscode.ThemeIcon("git-merge");
    item.contextValue = "gitSimpleCompare.conflict";
    item.tooltip = vscode.l10n.t(
      "Conflicted: {0}\nOpen conflict editor to use Current, Incoming, Both, or Resolve Marked.",
      rel
    );
    item.command = {
      command: "gitSimpleCompare.openConflictEditor",
      title: vscode.l10n.t("Resolve Conflict"),
      arguments: [rel],
    };
    return item;
  }

  /** 루트에서 충돌 파일 목록을 반환한다(평면 목록). */
  getChildren(element?: string): string[] {
    return element ? [] : this.conflicts;
  }
}
