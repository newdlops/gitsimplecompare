// 변경 파일 목록(FileChange[])을 트리뷰가 그릴 "노드 구조"로 변환하는 모델 모듈.
// - 보기 모드(tree/list)와 정렬 기준(name/path/status)에 따라 노드 트리를 만든다.
// - VS Code API 에 의존하지 않는 순수 변환이라 단위 테스트·재사용이 쉽다(경계 분리).
import { BranchComparison, FileChange, FileChangeStatus } from "../git/gitTypes";

/** 보기 모드: 폴더 계층(tree) 또는 평면 목록(list) */
export type ViewMode = "tree" | "list";

/** 정렬 기준: 파일명 / 전체 경로 / 변경 상태 */
export type SortKey = "name" | "path" | "status";

/** 폴더 노드. 압축(compact) 시 name 이 "a/b" 형태가 될 수 있다. */
export interface FolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

/** 파일(변경) 노드 */
export interface FileNode {
  kind: "file";
  change: FileChange;
}

/** 노드 합집합 타입(폴더/파일). 웹뷰가 JSON 으로 받아 렌더링한다. */
export type TreeNode = FolderNode | FileNode;

/** openChangeDiff 명령에 넘길 인자(비교 컨텍스트 + 클릭된 변경 파일) */
export interface ChangeDiffArgs {
  comparison: BranchComparison;
  change: FileChange;
}

/**
 * 변경 목록을 보기 모드·정렬에 맞춰 노드 배열(루트 자식)로 변환한다.
 * @param changes  변경 파일 목록
 * @param viewMode 보기 모드(tree/list)
 * @param sortKey  정렬 기준
 * @returns 루트 레벨 노드 배열
 */
export function buildNodes(
  changes: FileChange[],
  viewMode: ViewMode,
  sortKey: SortKey
): TreeNode[] {
  if (viewMode === "list") {
    return [...changes]
      .sort((a, b) => compareChanges(a, b, sortKey))
      .map((change) => ({ kind: "file", change } as FileNode));
  }
  return buildTree(changes, sortKey);
}

/** 트리 구성을 위한 가변(mutable) 폴더 컨테이너 */
interface MutableFolder {
  folders: Map<string, MutableFolder>;
  files: FileChange[];
}

/**
 * 경로를 세그먼트로 쪼개 폴더 계층을 만든 뒤 노드 배열로 변환한다.
 * @param changes 변경 파일 목록
 * @param sortKey 정렬 기준
 */
function buildTree(changes: FileChange[], sortKey: SortKey): TreeNode[] {
  const root: MutableFolder = { folders: new Map(), files: [] };
  for (const change of changes) {
    const segments = change.path.split("/");
    segments.pop(); // 마지막 세그먼트는 파일명이므로 제외
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.folders.get(seg);
      if (!next) {
        next = { folders: new Map(), files: [] };
        cursor.folders.set(seg, next);
      }
      cursor = next;
    }
    cursor.files.push(change);
  }
  return toNodes(root, "", sortKey);
}

/**
 * 가변 폴더 트리를 표시용 TreeNode 배열로 변환한다(폴더 먼저, 그다음 파일).
 * - 자식이 폴더 하나뿐이면 경로를 합쳐 표시를 간결하게 만든다(compact).
 * @param folder   변환할 폴더
 * @param basePath 현재 폴더까지의 누적 경로
 * @param sortKey  파일 정렬 기준
 */
function toNodes(
  folder: MutableFolder,
  basePath: string,
  sortKey: SortKey
): TreeNode[] {
  const folderNodes: FolderNode[] = [];
  for (const [name, child] of folder.folders) {
    const path = basePath ? `${basePath}/${name}` : name;
    const node: FolderNode = {
      kind: "folder",
      name,
      path,
      children: toNodes(child, path, sortKey),
    };
    folderNodes.push(compact(node));
  }
  folderNodes.sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes: FileNode[] = [...folder.files]
    .sort((a, b) => compareChanges(a, b, sortKey))
    .map((change) => ({ kind: "file", change }));

  return [...folderNodes, ...fileNodes];
}

/**
 * 폴더 체인을 압축한다(자식이 폴더 하나뿐이고 파일이 없으면 경로를 합침).
 * 예) a → b → c.ts 를 "a/b" 폴더 아래 c.ts 로 보여준다.
 * @param node 압축할 폴더 노드(자식은 이미 변환·압축된 상태)
 */
function compact(node: FolderNode): FolderNode {
  let current = node;
  while (
    current.children.length === 1 &&
    current.children[0].kind === "folder"
  ) {
    const only = current.children[0];
    current = {
      kind: "folder",
      name: `${current.name}/${only.name}`,
      path: only.path,
      children: only.children,
    };
  }
  return current;
}

/**
 * 정렬 기준에 따라 두 변경 항목의 순서를 비교한다.
 * @param a 변경 A
 * @param b 변경 B
 * @param sortKey 정렬 기준
 * @returns 음수면 a 우선
 */
function compareChanges(
  a: FileChange,
  b: FileChange,
  sortKey: SortKey
): number {
  switch (sortKey) {
    case "status": {
      const diff = statusRank(a.status) - statusRank(b.status);
      return diff !== 0 ? diff : baseName(a.path).localeCompare(baseName(b.path));
    }
    case "path":
      return a.path.localeCompare(b.path);
    case "name":
    default:
      return baseName(a.path).localeCompare(baseName(b.path));
  }
}

/** 상태 정렬 우선순위(추가→수정→이름변경→복사→타입→삭제→그 외) */
function statusRank(status: FileChangeStatus): number {
  const order: FileChangeStatus[] = ["A", "M", "R", "C", "T", "D", "U"];
  const idx = order.indexOf(status);
  return idx === -1 ? order.length : idx;
}

/** 경로에서 파일명(마지막 세그먼트)만 추출한다. */
function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
