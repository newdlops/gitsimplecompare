// Explorer 컨테이너의 Comparison 뷰에 활성 비교 파일을 폴더 트리로 제공한다.
// - 실제 작업트리에서 사라진 삭제 파일도 ghost 노드로 유지하고 Unicode 취소선을 표시한다.
// - 비교 조회/명령 실행은 하지 않으며 클릭 메시지만 명령 계층으로 전달한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComparisonKind, ComparisonSnapshot } from "../git/comparisonService";
import type { FileChange, FileChangeStatus } from "../git/gitTypes";
import { logInfo } from "../ui/outputLog";
import { ComparisonController } from "./comparisonController";
import {
  comparisonChangeTooltip,
  comparisonChangeUri,
  comparisonFileOpenTitle,
  getComparisonStatusPresentation,
  makeComparisonDiffCommandArgs,
} from "./comparisonFileDecorations";
import {
  editorGutterSettingAllowsMarkers,
  OPEN_COMPARISON_DIFF_COMMAND,
  OPEN_COMPARISON_FILE_COMMAND,
} from "./comparisonScmProvider";
/** package.json 의 Explorer 컨테이너 view id 와 공유하는 식별자. */
export const COMPARISON_EXPLORER_VIEW_ID =
  "gitSimpleCompare.comparisonExplorer";
/** 삭제 글자 뒤에 붙여 시각적 취소선을 만드는 Unicode combining long stroke overlay. */
const COMBINING_STRIKE = "\u0336";
/** 폴더 노드가 상태 요약을 빠르게 표시하도록 보관하는 상태별 개수. */
export type ComparisonStatusCounts = Partial<Record<FileChangeStatus, number>>;
/** Comparison Explorer가 지속적으로 보여 줄 편집기 gutter 상태. */
export type ComparisonGutterState =
  | "none"
  | "active"
  | "refsUnavailable"
  | "targetNotCurrent"
  | "settingHidden";
/** 폴더/파일 노드가 공유하는 트리 식별 정보. */
interface ComparisonExplorerNodeBase {
  /** 노드 종류. */
  kind: "folder" | "file";
  /** 저장소 루트 기준 상대 경로. */
  path: string;
  /** getParent/reveal 에 사용할 상위 폴더 노드. */
  parent?: ComparisonExplorerFolderNode;
}
/** 비교 트리의 폴더 노드. */
export interface ComparisonExplorerFolderNode
  extends ComparisonExplorerNodeBase {
  kind: "folder";
  /** 현재 폴더 한 단계 이름. */
  name: string;
  /** 폴더 아래에 표시할 폴더/파일 자식. */
  children: ComparisonExplorerNode[];
  /** 모든 하위 파일 변경 수. */
  changeCount: number;
  /** 모든 하위 파일 상태별 개수. */
  statusCounts: ComparisonStatusCounts;
}
/** 비교 트리의 파일 노드. */
export interface ComparisonExplorerFileNode extends ComparisonExplorerNodeBase {
  kind: "file";
  /** inline/context 명령이 현재 비교 저장소를 검증할 때 사용하는 루트. */
  repoRoot: string;
  /** git 서비스가 계산한 파일 변경 정보. */
  change: FileChange;
}
/** TreeDataProvider 가 다루는 폴더/파일 노드 합집합. */
export type ComparisonExplorerNode =
  | ComparisonExplorerFolderNode
  | ComparisonExplorerFileNode;

/** 외부 통합 코드가 TreeView.description/message 를 갱신할 때 읽는 요약 상태. */
export interface ComparisonExplorerStatus {
  /** Explorer 비교 표시 토글 값. */
  enabled: boolean;
  /** 활성화 여부와 무관하게 controller 에 비교 선택이 있는지 여부. */
  hasComparison: boolean;
  /** 활성 비교 종류. 비활성/미선택이면 undefined. */
  kind?: ComparisonKind;
  /** `base → target` 형태의 짧은 설명. */
  description?: string;
  /** 트리 상단에 지속 표시할 gutter 사용 가능 여부. */
  gutterState: ComparisonGutterState;
  /** gutter를 볼 수 없거나 사용하는 방법을 설명하는 메시지. */
  message?: string;
  /** 현재 트리에 표시되는 변경 파일 수. */
  changeCount: number;
  /** 현재 트리에 표시되는 삭제 ghost 수. */
  deletedCount: number;
  /** 서비스 제한 때문에 전체 결과가 아닌지 여부. */
  truncated: boolean;
}

/** 폴더 트리를 구성하는 동안 사용하는 가변 내부 노드. */
interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: FileChange[];
}

/**
 * 활성 ComparisonSnapshot 을 Explorer TreeItem 계층으로 변환한다.
 * - controller 이벤트마다 순수 트리를 다시 만들므로 이전 snapshot 객체를 참조하지 않는다.
 */
export class ComparisonExplorerTreeProvider
  implements vscode.TreeDataProvider<ComparisonExplorerNode>, vscode.Disposable
{
  private readonly treeChangeEmitter = new vscode.EventEmitter<
    ComparisonExplorerNode | ComparisonExplorerNode[] | undefined
  >();
  private readonly statusChangeEmitter =
    new vscode.EventEmitter<ComparisonExplorerStatus>();
  private readonly controllerSubscription: vscode.Disposable;
  private comparison: ComparisonSnapshot | undefined;
  private roots: ComparisonExplorerNode[] = [];
  private disposed = false;
  /** VS Code 가 트리 전체/일부를 다시 요청하도록 알리는 이벤트. */
  readonly onDidChangeTreeData = this.treeChangeEmitter.event;
  /** TreeView description/welcome 상태를 갱신할 통합 계층용 이벤트. */
  readonly onDidChangeStatus = this.statusChangeEmitter.event;
  /**
   * controller 이벤트를 구독하고 초기 트리 상태를 구성한다.
   * @param controller 활성 비교와 Explorer 토글을 관리하는 controller
   */
  constructor(private readonly controller: ComparisonController) {
    this.controllerSubscription = controller.onDidChangeComparison(() => {
      this.rebuild("controllerEvent");
    });
    this.rebuild("activation");
    logInfo("comparison Explorer tree provider activated", {
      enabled: controller.enabled,
      hasComparison: controller.hasComparison,
    });
  }
  /**
   * 현재 controller/트리 상태의 직렬화 가능한 요약을 반환한다.
   * @returns view description, 빈 상태 문구, 진단 로그에 사용할 요약
   */
  getStatus(): ComparisonExplorerStatus {
    const comparison = this.comparison;
    const gutterState = comparison
      ? comparisonGutterState(comparison)
      : "none";
    return {
      enabled: this.controller.enabled,
      hasComparison: this.controller.hasComparison,
      kind: comparison?.kind,
      description: comparison
        ? comparisonDescription(comparison, gutterState)
        : undefined,
      gutterState,
      message:
        comparison && comparison.changes.length > 0
          ? comparisonGutterMessage(gutterState)
          : undefined,
      changeCount: comparison?.changes.length ?? 0,
      deletedCount:
        comparison?.changes.filter((change) => change.status === "D").length ??
        0,
      truncated: comparison?.truncated ?? false,
    };
  }
  /**
   * 내부 snapshot/tree 를 controller 의 최신 상태로 다시 만들고 전체 갱신을 알린다.
   * @param reason 활성화/토글/새 snapshot 같은 재구성 원인
   */
  refresh(reason = "manual"): void {
    this.rebuild(reason);
  }
  /**
   * 트리 노드를 VS Code TreeItem 표현으로 변환한다.
   * @param element 폴더 또는 파일 노드
   * @returns label/tooltip/status/command/accessibility 를 갖는 TreeItem
   */
  getTreeItem(element: ComparisonExplorerNode): vscode.TreeItem {
    return element.kind === "folder"
      ? this.makeFolderTreeItem(element)
      : this.makeFileTreeItem(element);
  }
  /**
   * 루트 또는 폴더의 자식 노드를 반환한다.
   * @param element 생략하면 트리 루트, 지정하면 해당 폴더/파일
   * @returns 안정적으로 정렬된 자식 배열
   */
  getChildren(element?: ComparisonExplorerNode): ComparisonExplorerNode[] {
    if (!element) {
      return this.roots;
    }
    return element.kind === "folder" ? element.children : [];
  }
  /**
   * TreeView.reveal 이 폴더 계층을 따라갈 수 있도록 노드 부모를 반환한다.
   * @param element 부모를 찾을 트리 노드
   * @returns 상위 폴더, 루트 자식이면 undefined
   */
  getParent(
    element: ComparisonExplorerNode
  ): ComparisonExplorerFolderNode | undefined {
    return element.parent;
  }
  /**
   * controller 구독과 provider 이벤트 emitter 를 해제한다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controllerSubscription.dispose();
    this.treeChangeEmitter.dispose();
    this.statusChangeEmitter.dispose();
    this.comparison = undefined;
    this.roots = [];
    logInfo("comparison Explorer tree provider disposed");
  }

  /**
   * controller snapshot 을 복제해 트리를 재구성하고 상태/트리 이벤트를 발생시킨다.
   * @param reason OUTPUT 에 남길 갱신 원인
   */
  private rebuild(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.comparison = this.controller.getComparison(false);
    this.roots = this.comparison
      ? buildComparisonTree(
          this.comparison.changes,
          this.comparison.repoRoot
        )
      : [];
    const status = this.getStatus();
    this.treeChangeEmitter.fire(undefined);
    this.statusChangeEmitter.fire(status);
    logInfo("comparison Explorer tree refreshed", {
      reason,
      enabled: status.enabled,
      hasComparison: status.hasComparison,
      kind: status.kind,
      changes: status.changeCount,
      deleted: status.deletedCount,
      truncated: status.truncated,
      gutterState: status.gutterState,
    });
  }

  /**
   * 폴더 노드를 펼침 가능한 TreeItem 으로 만든다.
   * @param node 표시할 폴더 노드
   * @returns 변경 수/상태 요약 툴팁과 접근성 label 을 가진 TreeItem
   */
  private makeFolderTreeItem(
    node: ComparisonExplorerFolderNode
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `gitSimpleCompare.comparison.folder:${node.path}`;
    item.resourceUri = this.comparison
      ? vscode.Uri.file(path.resolve(this.comparison.repoRoot, node.path))
      : undefined;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.description = vscode.l10n.t("{0} changes", node.changeCount);
    item.tooltip = folderTooltip(node);
    item.contextValue = "gitSimpleCompare.comparisonFolder";
    item.accessibilityInformation = {
      label: vscode.l10n.t(
        "Folder {0}, {1} changed files",
        node.path,
        node.changeCount
      ),
    };
    return item;
  }

  /**
   * 파일 노드를 상태 표시와 diff 열기 명령을 가진 TreeItem 으로 만든다.
   * - 삭제 파일 label 에 combining strike 를 넣되 스크린리더에는 정상 문자열을 제공한다.
   * @param node 표시할 파일 노드
   * @returns 삭제 ghost/rename/상태/통계를 표현하는 TreeItem
   */
  private makeFileTreeItem(node: ComparisonExplorerFileNode): vscode.TreeItem {
    const comparison = this.comparison;
    const change = node.change;
    const fileName = path.posix.basename(change.path);
    const presentation = getComparisonStatusPresentation(change.status);
    const deleted = change.status === "D";
    const editable = Boolean(
      comparison?.targetMatchesHead &&
      comparison.diffAvailable &&
      !deleted
    );
    const actionTitle = comparisonFileOpenTitle(
      comparison,
      deleted,
      editorGutterSettingAllowsMarkers()
    );
    const visibleLabel = deleted ? combiningStrike(fileName) : fileName;
    const item = new vscode.TreeItem(
      visibleLabel,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `gitSimpleCompare.comparison.file:${change.path}`;
    item.resourceUri = comparison
      ? comparisonChangeUri(comparison, change)
      : undefined;
    item.iconPath = vscode.ThemeIcon.File;
    item.description = fileDescription(change, presentation.badge);
    item.tooltip = comparison
      ? `${comparisonChangeTooltip(comparison, change)}\n${actionTitle}`
      : `${presentation.label}: ${change.path}`;
    item.contextValue = editable
      ? "gitSimpleCompare.comparisonFile.editable"
      : "gitSimpleCompare.comparisonFile.readonly";
    item.accessibilityInformation = {
      label: vscode.l10n.t(
        "{0}, {1}, {2}",
        fileName,
        presentation.label,
        `${change.path}, ${actionTitle}`
      ),
    };
    if (comparison) {
      item.command = {
        command: editable
          ? OPEN_COMPARISON_FILE_COMMAND
          : OPEN_COMPARISON_DIFF_COMMAND,
        title: actionTitle,
        arguments: [makeComparisonDiffCommandArgs(comparison, change)],
      };
    }
    return item;
  }
}

/**
 * 문자열의 각 비공백 문자 뒤에 combining strike 를 붙인다.
 * - 실제 삭제 파일이 없어 native Explorer 에 나타낼 수 없는 경우 ghost label 에 사용한다.
 * @param label 화면에 표시할 원래 파일명
 * @returns 취소선 combining 문자가 합성된 시각적 문자열
 */
export function combiningStrike(label: string): string {
  return [...label]
    .map((character) =>
      /\s/u.test(character) ? character : `${character}${COMBINING_STRIKE}`
    )
    .join("");
}

/**
 * 변경 경로 배열을 폴더/파일 계층으로 변환한다.
 * @param changes ComparisonSnapshot 의 파일 변경 목록
 * @param repoRoot 파일 노드의 inline/context 명령 검증에 넣을 저장소 루트
 * @returns 폴더 우선, 이름순으로 정렬된 루트 노드 배열
 */
export function buildComparisonTree(
  changes: FileChange[],
  repoRoot = ""
): ComparisonExplorerNode[] {
  const root: MutableFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  for (const change of [...changes].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    insertChange(root, change);
  }
  return materializeChildren(root, undefined, repoRoot);
}

/**
 * 파일 변경을 경로 세그먼트에 맞는 가변 폴더에 삽입한다.
 * @param root 삽입을 시작할 가변 루트
 * @param change 추가할 파일 변경
 */
function insertChange(root: MutableFolder, change: FileChange): void {
  const segments = normalizeTreePath(change.path).split("/").filter(Boolean);
  if (segments.length === 0) {
    return;
  }
  segments.pop();
  let current = root;
  for (const segment of segments) {
    const childPath = current.path ? `${current.path}/${segment}` : segment;
    let child = current.folders.get(segment);
    if (!child) {
      child = {
        name: segment,
        path: childPath,
        folders: new Map(),
        files: [],
      };
      current.folders.set(segment, child);
    }
    current = child;
  }
  current.files.push({ ...change, path: normalizeTreePath(change.path) });
}

/**
 * 가변 폴더의 자식을 parent 링크와 상태 집계가 있는 공개 노드로 변환한다.
 * @param folder 변환할 가변 폴더
 * @param parent 만들어진 자식들이 참조할 상위 공개 폴더
 * @param repoRoot 만들어지는 파일 노드에 보존할 비교 저장소 루트
 * @returns 정렬된 폴더/파일 노드
 */
function materializeChildren(
  folder: MutableFolder,
  parent: ComparisonExplorerFolderNode | undefined,
  repoRoot: string
): ComparisonExplorerNode[] {
  const folderNodes = [...folder.folders.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((mutable) => materializeFolder(mutable, parent, repoRoot));
  const fileNodes: ComparisonExplorerFileNode[] = folder.files
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((change) => ({
      kind: "file",
      path: change.path,
      repoRoot,
      change,
      parent,
    }));
  return [...folderNodes, ...fileNodes];
}

/**
 * 가변 폴더 하나를 재귀 공개 노드로 변환하고 하위 상태 수를 계산한다.
 * @param mutable 변환할 내부 폴더
 * @param parent 상위 공개 폴더
 * @param repoRoot 하위 파일 명령이 현재 비교를 검증할 저장소 루트
 * @returns 자식/집계/parent 링크를 가진 폴더 노드
 */
function materializeFolder(
  mutable: MutableFolder,
  parent: ComparisonExplorerFolderNode | undefined,
  repoRoot: string
): ComparisonExplorerFolderNode {
  const node: ComparisonExplorerFolderNode = {
    kind: "folder",
    name: mutable.name,
    path: mutable.path,
    parent,
    children: [],
    changeCount: 0,
    statusCounts: {},
  };
  node.children = materializeChildren(mutable, node, repoRoot);
  const changes = collectNodeChanges(node);
  node.changeCount = changes.length;
  node.statusCounts = countStatuses(changes);
  return node;
}

/**
 * 폴더 아래 모든 파일 변경을 재귀적으로 모은다.
 * @param folder 집계할 공개 폴더 노드
 * @returns 하위 FileChange 배열
 */
function collectNodeChanges(folder: ComparisonExplorerFolderNode): FileChange[] {
  const changes: FileChange[] = [];
  for (const child of folder.children) {
    if (child.kind === "file") {
      changes.push(child.change);
    } else {
      changes.push(...collectNodeChanges(child));
    }
  }
  return changes;
}

/**
 * 파일 변경 배열을 상태별 개수 객체로 집계한다.
 * @param changes 집계할 파일 변경들
 * @returns 값이 1 이상인 상태만 포함하는 개수 맵
 */
function countStatuses(changes: FileChange[]): ComparisonStatusCounts {
  const counts: ComparisonStatusCounts = {};
  for (const change of changes) {
    counts[change.status] = (counts[change.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * 폴더의 상대 경로와 상태별 개수를 여러 줄 툴팁으로 만든다.
 * @param node 툴팁을 만들 폴더 노드
 * @returns 경로/전체 변경 수/상태 요약 문자열
 */
function folderTooltip(node: ComparisonExplorerFolderNode): string {
  const statusSummary = Object.entries(node.statusCounts)
    .map(([status, count]) => {
      const presentation = getComparisonStatusPresentation(
        status as FileChangeStatus
      );
      return `${presentation.label}: ${count}`;
    })
    .join(", ");
  return [
    node.path,
    vscode.l10n.t("{0} changed files", node.changeCount),
    statusSummary,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 파일 상태와 폴더/이전 경로를 TreeItem.description 으로 압축한다.
 * @param change 설명할 파일 변경
 * @param badge 상태 badge 문자
 * @returns 트리 오른쪽에 표시할 짧은 문자열
 */
function fileDescription(change: FileChange, badge: string): string {
  if (change.oldPath && change.oldPath !== change.path) {
    return `${badge} · ${change.oldPath} →`;
  }
  const directory = path.posix.dirname(change.path);
  return directory === "." ? badge : `${badge} · ${directory}`;
}

/**
 * 비교 기준/대상 label 을 TreeView.description 에 적합한 문자열로 만든다.
 * @param comparison 활성 비교 snapshot
 * @returns `base → target` 형식의 설명
 */
function comparisonDescription(
  comparison: ComparisonSnapshot,
  gutterState: ComparisonGutterState
): string {
  const base = comparison.baseLabel || comparison.baseRef;
  const target = comparison.targetLabel || comparison.targetRef;
  const mode =
    gutterState === "active"
      ? vscode.l10n.t("Line markers on")
      : gutterState === "refsUnavailable"
      ? vscode.l10n.t("File list only")
      : gutterState === "settingHidden"
      ? vscode.l10n.t("Line markers hidden")
      : vscode.l10n.t("Diff only");
  return `${base} → ${target} · ${mode}`;
}

/**
 * 비교 스냅샷과 VS Code 설정을 사용해 Explorer의 지속 gutter 상태를 계산한다.
 * @param comparison 현재 활성 비교
 * @returns refs/checkout/설정까지 구분한 상태 값
 */
function comparisonGutterState(
  comparison: ComparisonSnapshot
): ComparisonGutterState {
  if (!comparison.diffAvailable) {
    return "refsUnavailable";
  }
  if (!comparison.targetMatchesHead) {
    return "targetNotCurrent";
  }
  return editorGutterSettingAllowsMarkers() ? "active" : "settingHidden";
}

/**
 * Explorer 파일 목록 위에 표시할 gutter 상태 설명을 만든다.
 * @param state 계산된 gutter 상태
 * @returns 사용자에게 다음 동작을 알려 주는 번역 문자열
 */
function comparisonGutterMessage(state: ComparisonGutterState): string {
  switch (state) {
    case "active":
      return vscode.l10n.t(
        "Open a changed file to see line markers. Use the Diff button for side-by-side view."
      );
    case "refsUnavailable":
      return vscode.l10n.t(
        "File list only: comparison refs are not available locally. Fetch them, then refresh."
      );
    case "targetNotCurrent":
      return vscode.l10n.t(
        "Diff only: this comparison does not target the current checkout."
      );
    case "settingHidden":
      return vscode.l10n.t(
        "Line markers are hidden by VS Code's scm.diffDecorations setting."
      );
    case "none":
      return "";
  }
}

/**
 * git 경로를 Explorer 트리 키로 안전하게 정규화한다.
 * @param value 서비스가 반환한 저장소 상대 경로
 * @returns 앞의 `./`와 중복 슬래시가 제거된 상대 경로
 */
function normalizeTreePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}
