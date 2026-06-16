// interactive rebase 중 파일 단위 제외 작업을 todo exec 로 표현하는 유틸.
// - UI 는 파일 경로만 선택하지만, git 에 실제로 적용할 때는 rename 의 old/new path 를 함께
//   되돌려야 하므로 이 모듈에서 선택 경로를 실행 가능한 파일 작업으로 정규화한다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 파일 제외 UI 가 알고 있는 커밋 변경 파일 정보 */
export interface RebaseFileExcludeFile {
  status?: string;
  path: string;
  oldPath?: string;
}

/** 파일 제외 작업을 만들 때 필요한 rebase todo 항목의 최소 형태 */
export interface RebaseFileExcludeItem {
  files?: RebaseFileExcludeFile[];
  excludePaths?: string[];
  historyExcludePaths?: string[];
}

/** rebaseEditor.js amend 모드가 실제로 되돌릴 파일 작업 한 건 */
export interface RebaseFileExcludeOp {
  path: string;
  oldPath?: string;
  status?: string;
}

/**
 * rebase 계획 전체에 적용할 history 제외 경로를 중복 없이 모은다.
 * @param items UI 가 가진 전체 rebase todo 항목
 * @returns 모든 커밋에 적용해야 하는 저장소 상대 경로 목록
 */
export function collectHistoryExcludePaths(
  items: RebaseFileExcludeItem[]
): string[] {
  return uniquePaths(items.flatMap((item) => item.historyExcludePaths ?? []));
}

/**
 * 한 rebase todo 항목에 적용할 파일 제외 작업을 만든다.
 * - commit 단위 제외와 history 단위 제외를 합친 뒤, 커밋 파일 목록과 매칭해 rename 은
 *   old/new path 를 함께 포함한다.
 * - 파일 목록에서 찾지 못한 경로도 raw path 작업으로 남겨 진행 중 todo 편집처럼
 *   메타데이터가 부족한 상황을 보존한다.
 * @param item rebase todo 항목
 * @param historyExcludePaths 계획 전체에 적용할 history 제외 경로
 * @returns rebaseEditor.js 에 넘길 파일 제외 작업 목록
 */
export function buildFileExcludeOps(
  item: RebaseFileExcludeItem,
  historyExcludePaths: string[]
): RebaseFileExcludeOp[] {
  const selected = uniquePaths([
    ...historyExcludePaths,
    ...(item.excludePaths ?? []),
  ]);
  const files = item.files ?? [];
  const ops: RebaseFileExcludeOp[] = [];
  for (const selectedPath of selected) {
    const matched = files.filter(
      (file) => file.path === selectedPath || file.oldPath === selectedPath
    );
    if (matched.length === 0) {
      ops.push({ path: selectedPath });
      continue;
    }
    for (const file of matched) {
      ops.push(fileExcludeOp(file));
    }
  }
  return uniqueOps(ops);
}

/**
 * 파일 제외 작업을 임시 JSON 파일로 저장한다.
 * @param ops rebaseEditor.js amend 모드가 읽을 파일 제외 작업
 * @returns 생성된 임시 파일의 절대 경로
 */
export function writeTempFileExcludeOps(ops: RebaseFileExcludeOp[]): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const file = path.join(os.tmpdir(), `gsc-rebase-ops-${suffix}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, files: ops }), "utf8");
  return file;
}

/**
 * rebase todo 의 exec 줄에 넣을 파일 제외 amend 명령을 만든다.
 * @param nodePath Electron/Node 실행 파일 경로
 * @param editorScript rebaseEditor.js 경로
 * @param opFile 파일 제외 작업 JSON 경로
 * @returns git rebase todo 에 그대로 넣을 exec 한 줄
 */
export function rebaseFileAmendExecLine(
  nodePath: string,
  editorScript: string,
  opFile: string
): string {
  return `exec ${editorCmdForTodo(nodePath, editorScript)} amend ${quoteArg(opFile)}`;
}

/**
 * todo 한 줄이 Git Simple Compare 가 만든 파일 제외 amend exec 인지 확인한다.
 * @param line git-rebase-todo 의 원문 한 줄
 * @returns 우리 helper 의 amend exec 줄이면 true
 */
export function isRebaseFileAmendExecLine(line: string): boolean {
  return (
    /^\s*exec\s+/.test(line) &&
    /rebaseEditor\.js["']?\s+amend\s+/.test(line)
  );
}

/**
 * rebase todo 의 exec 줄에 넣을 헬퍼 명령 문자열을 만든다.
 * @param nodePath Electron/Node 실행 파일 경로
 * @param editorScript rebaseEditor.js 경로
 */
function editorCmdForTodo(nodePath: string, editorScript: string): string {
  return `${quoteArg(nodePath)} ${quoteArg(editorScript)}`;
}

/**
 * rebase todo 에 안전하게 넣을 shell 인자를 만든다.
 * @param value 인자 문자열
 */
function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 변경 파일 메타데이터를 실제 되돌릴 파일 작업으로 바꾼다.
 * @param file 커밋의 변경 파일 한 건
 * @returns rename 은 oldPath 를 보존하고, 그 외 변경은 현재 path 만 되돌리는 작업
 */
function fileExcludeOp(file: RebaseFileExcludeFile): RebaseFileExcludeOp {
  return {
    path: file.path,
    oldPath: file.status?.startsWith("R") ? file.oldPath : undefined,
    status: file.status,
  };
}

/**
 * 파일 작업 목록에서 의미상 같은 작업을 한 번만 남긴다.
 * @param ops 중복 가능성이 있는 파일 제외 작업 목록
 */
function uniqueOps(ops: RebaseFileExcludeOp[]): RebaseFileExcludeOp[] {
  const seen = new Set<string>();
  const out: RebaseFileExcludeOp[] = [];
  for (const op of ops) {
    const key = `${op.status ?? ""}\0${op.oldPath ?? ""}\0${op.path}`;
    if (!op.path || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(op);
  }
  return out;
}

/**
 * 경로 배열의 빈 값과 중복을 제거한다.
 * @param paths 경로 후보 목록
 */
function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}
