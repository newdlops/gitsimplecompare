// 브랜치 비교 결과(변경 파일 목록)를 액티비티 바 트리뷰로 보여주는 프로바이더.
// - "지금 무엇을 비교 중인지"(BranchComparison)를 보관하고, 각 파일 항목 클릭 시
//   해당 파일의 diff 를 여는 명령을 연결한다.
import * as vscode from "vscode";
import {
  BranchComparison,
  FileChange,
  FileChangeStatus,
} from "../git/gitTypes";

/** openChangeDiff 명령에 넘길 인자 형태(파일 + 비교 컨텍스트) */
export interface ChangeDiffArgs {
  comparison: BranchComparison;
  change: FileChange;
}

/**
 * 변경 파일 트리뷰 데이터 프로바이더.
 * - element 타입은 FileChange 이며, 루트에서 변경 파일들을 평평하게 나열한다.
 * - 추후 디렉터리 그룹핑 등으로 확장하기 쉽도록 getChildren 한 곳에서 구성한다.
 */
export class ChangesTreeProvider
  implements vscode.TreeDataProvider<FileChange>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    FileChange | undefined
  >();
  /** 트리 갱신 이벤트(VS Code 가 구독한다) */
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private comparison?: BranchComparison;

  /**
   * 현재 비교 컨텍스트를 교체하고 트리를 새로고침한다.
   * @param comparison 새 브랜치 비교 결과
   */
  setComparison(comparison: BranchComparison): void {
    this.comparison = comparison;
    this.onDidChangeEmitter.fire(undefined);
  }

  /** 현재 비교 컨텍스트를 반환한다(없으면 undefined). 명령에서 base/target 참조용. */
  getComparison(): BranchComparison | undefined {
    return this.comparison;
  }

  /** 트리를 강제로 다시 그린다(데이터는 그대로, 표시만 갱신). */
  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  /**
   * 한 FileChange 를 트리 항목(TreeItem)으로 변환한다.
   * - 라벨은 파일명, 설명은 디렉터리 경로, 상태 글자는 접두 배지로 보여준다.
   * - 클릭하면 openChangeDiff 명령으로 해당 파일 diff 를 연다.
   * @param element 변환할 변경 파일
   */
  getTreeItem(element: FileChange): vscode.TreeItem {
    const slash = element.path.lastIndexOf("/");
    const fileName = slash >= 0 ? element.path.slice(slash + 1) : element.path;
    const dirName = slash >= 0 ? element.path.slice(0, slash) : "";

    const item = new vscode.TreeItem(
      `${statusBadge(element.status)} ${fileName}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = dirName;
    item.tooltip = `${statusLabel(element.status)}: ${element.path}${
      element.oldPath ? `\n← ${element.oldPath}` : ""
    }`;
    item.iconPath = new vscode.ThemeIcon(statusIcon(element.status));
    item.contextValue = "gitSimpleCompare.change";

    // 클릭 시 diff 를 여는 명령. 비교 컨텍스트와 파일을 함께 넘긴다.
    if (this.comparison) {
      const args: ChangeDiffArgs = { comparison: this.comparison, change: element };
      item.command = {
        command: "gitSimpleCompare.openChangeDiff",
        title: "변경 파일 비교 열기",
        arguments: [args],
      };
    }
    return item;
  }

  /**
   * 트리 자식 항목을 반환한다.
   * - 루트(element 없음)에서 현재 비교의 변경 파일 전체를 반환한다.
   * - 평평한 목록이라 하위 항목은 없다.
   * @param element 상위 항목(루트면 undefined)
   */
  getChildren(element?: FileChange): FileChange[] {
    if (element || !this.comparison) {
      return [];
    }
    return this.comparison.changes;
  }

  /**
   * 항목의 부모를 반환한다.
   * - 평평한 목록이라 모든 항목은 루트 직속이므로 undefined 를 반환한다.
   * - TreeView.reveal() 사용을 위해 반드시 구현해야 하는 메서드다.
   * @param _element 부모를 찾을 대상(여기선 사용하지 않음)
   */
  getParent(_element: FileChange): FileChange | undefined {
    return undefined;
  }
}

/**
 * 상태 코드를 한 글자 배지 텍스트로 변환한다(라벨 접두용).
 * @param status 변경 상태 코드
 */
function statusBadge(status: FileChangeStatus): string {
  return status;
}

/**
 * 상태 코드를 사람이 읽는 한글 라벨로 변환한다(툴팁용).
 * @param status 변경 상태 코드
 */
function statusLabel(status: FileChangeStatus): string {
  const map: Record<FileChangeStatus, string> = {
    A: "추가됨",
    M: "수정됨",
    D: "삭제됨",
    R: "이름변경",
    C: "복사됨",
    T: "타입변경",
    U: "충돌",
    X: "알수없음",
    B: "손상",
  };
  return map[status] ?? "변경됨";
}

/**
 * 상태 코드에 어울리는 코디콘 이름을 반환한다(아이콘용).
 * @param status 변경 상태 코드
 */
function statusIcon(status: FileChangeStatus): string {
  switch (status) {
    case "A":
      return "diff-added";
    case "D":
      return "diff-removed";
    case "R":
      return "diff-renamed";
    default:
      return "diff-modified";
  }
}
