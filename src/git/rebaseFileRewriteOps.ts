// interactive rebase 중 파일 변경을 제거/이동하기 위한 amend exec 작업을 만든다.
// - UI 의 파일 단위 선택을 Git 이 실행할 수 있는 JSON 작업 파일과 patch 파일로 변환한다.
// - patch 는 .git metadata 아래에 저장해 extension reload 후에도 rebase todo 의 exec 가 계속 참조할 수 있게 한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import type { RebaseFileExcludeOp } from "./rebaseFileExcludes";
import { buildFileExcludeOps, rebaseFileAmendExecLine } from "./rebaseFileExcludes";
import type { RebaseFileMove, RebaseItem } from "./rebaseService";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** rebaseEditor.js amend 모드가 적용할 patch 작업 */
export interface RebaseFilePatchOp {
  sourceHash: string;
  sourcePath: string;
  sourceOldPath?: string;
  targetHash: string;
  patchPath: string;
  paths: string[];
}

/** amend exec JSON 파일의 현재 포맷 */
export interface RebaseFileRewriteOps {
  version: 2;
  files: RebaseFileExcludeOp[];
  patches: RebaseFilePatchOp[];
}

/**
 * 한 todo 항목에 필요한 파일 제거/이동 patch exec 줄을 만든다.
 * - source 커밋에서는 파일 변경을 제거하고, target 커밋에서는 source patch 를 적용한다.
 * @param repoRoot 저장소 루트
 * @param item 현재 todo 항목
 * @param items 전체 rebase todo 항목
 * @param historyExcludePaths 전체 history 에서 제외할 경로
 * @param nodePath Electron/Node 실행 파일 경로
 * @param editorScript rebaseEditor.js 절대 경로
 * @returns exec 줄과 생성된 작업 파일 경로. 할 일이 없으면 undefined
 */
export async function rebaseFileRewriteExecLine(
  repoRoot: string,
  item: RebaseItem,
  items: RebaseItem[],
  historyExcludePaths: string[],
  nodePath: string,
  editorScript: string
): Promise<{ line: string; opFile: string } | undefined> {
  if (item.action === "drop") {
    return undefined;
  }
  const files = [
    ...buildFileExcludeOps(item, historyExcludePaths),
    ...fileMoveRestoreOps(item, items),
  ];
  const patches = await fileMovePatchOps(repoRoot, item, items);
  if (files.length === 0 && patches.length === 0) {
    return undefined;
  }
  const opFile = await writeRewriteOps(repoRoot, {
    version: 2,
    files: uniqueRestoreOps(files),
    patches,
  });
  return {
    line: rebaseFileAmendExecLine(nodePath, editorScript, opFile),
    opFile,
  };
}

/**
 * 특정 항목이 파일 rewrite exec 를 필요로 하는지 빠르게 판단한다.
 * @param item 검사할 todo 항목
 */
export function hasFileRewriteSelection(item: RebaseItem): boolean {
  return Boolean(
    item.excludePaths?.length ||
    item.historyExcludePaths?.length ||
    item.fileMoves?.length
  );
}

/**
 * 전체 파일 이동 계획까지 포함해 특정 todo 항목에 rewrite exec 가 필요한지 판단한다.
 * - 파일 이동 target 커밋은 자기 item 에 fileMoves 가 없어도 patch 적용 exec 가 필요하다.
 * @param item 검사할 todo 항목
 * @param items 전체 rebase todo 항목
 */
export function hasFileRewriteForItem(
  item: RebaseItem,
  items: RebaseItem[]
): boolean {
  return hasFileRewriteSelection(item) ||
    collectFileMoves(items).some((move) => sameHash(move.targetHash, item.hash));
}

/** source 커밋에서 제거해야 하는 파일 이동 작업을 restore op 로 바꾼다. */
function fileMoveRestoreOps(
  item: RebaseItem,
  items: RebaseItem[]
): RebaseFileExcludeOp[] {
  return collectFileMoves(items)
    .filter((move) => sameHash(move.sourceHash, item.hash))
    .map((move) => ({
      path: move.sourcePath,
      oldPath: move.sourceOldPath,
      status: move.sourceOldPath ? "R" : undefined,
    }));
}

/** target 커밋에서 적용해야 하는 파일 이동 patch 작업을 만든다. */
async function fileMovePatchOps(
  repoRoot: string,
  item: RebaseItem,
  items: RebaseItem[]
): Promise<RebaseFilePatchOp[]> {
  const ops: RebaseFilePatchOp[] = [];
  for (const move of collectFileMoves(items)) {
    if (!sameHash(move.targetHash, item.hash)) {
      continue;
    }
    const paths = uniquePaths([move.sourceOldPath, move.sourcePath]);
    const patchPath = await writeMovePatch(repoRoot, move, paths);
    ops.push({
      sourceHash: move.sourceHash,
      sourcePath: move.sourcePath,
      sourceOldPath: move.sourceOldPath,
      targetHash: move.targetHash,
      patchPath,
      paths,
    });
  }
  return ops;
}

/** 전체 todo 에서 유효한 파일 이동 작업만 중복 없이 모은다. */
function collectFileMoves(items: RebaseItem[]): RebaseFileMove[] {
  const hashes = new Set(items.map((item) => item.hash));
  const seen = new Set<string>();
  const moves: RebaseFileMove[] = [];
  for (const item of items) {
    for (const move of item.fileMoves ?? []) {
      if (!move.sourceHash || !move.sourcePath || !move.targetHash) {
        continue;
      }
      if (!hashes.has(move.sourceHash) || !hashes.has(move.targetHash)) {
        continue;
      }
      if (sameHash(move.sourceHash, move.targetHash)) {
        continue;
      }
      const key = `${move.sourceHash}\0${move.sourcePath}\0${move.targetHash}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      moves.push(move);
    }
  }
  return moves;
}

/** source 커밋의 파일 변경 patch 를 git metadata 아래에 저장한다. */
async function writeMovePatch(
  repoRoot: string,
  move: RebaseFileMove,
  paths: string[]
): Promise<string> {
  const parent = await firstParent(repoRoot, move.sourceHash);
  const patch = await runGit(
    ["diff", "--binary", "--full-index", "-M", parent, move.sourceHash, "--", ...paths],
    repoRoot
  );
  if (!patch.trim()) {
    throw new Error(`No patch found for ${move.sourcePath} in ${move.sourceHash.slice(0, 10)}.`);
  }
  const file = await gitMetadataPath(
    repoRoot,
    `gitsimplecompare/rebase-ops/move-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, patch, "utf8");
  return file;
}

/** amend 작업 JSON 을 git metadata 아래에 저장한다. */
async function writeRewriteOps(
  repoRoot: string,
  ops: RebaseFileRewriteOps
): Promise<string> {
  const file = await gitMetadataPath(
    repoRoot,
    `gitsimplecompare/rebase-ops/ops-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(ops)}\n`, "utf8");
  return file;
}

/** git metadata 상대 경로를 linked worktree 안전 절대 경로로 바꾼다. */
async function gitMetadataPath(repoRoot: string, rel: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", rel], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}

/** 커밋의 첫 부모를 구한다. 루트 커밋이면 empty tree 를 반환한다. */
async function firstParent(repoRoot: string, hash: string): Promise<string> {
  return (
    await runGit(["rev-parse", `${hash}^`], repoRoot).catch(() => EMPTY_TREE)
  ).trim();
}

/** restore op 중복을 제거한다. */
function uniqueRestoreOps(ops: RebaseFileExcludeOp[]): RebaseFileExcludeOp[] {
  const seen = new Set<string>();
  return ops.filter((op) => {
    const key = `${op.status ?? ""}\0${op.oldPath ?? ""}\0${op.path}`;
    if (!op.path || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** undefined/빈 경로를 제거하고 순서를 보존한다. */
function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return paths.filter((entry): entry is string => {
    if (!entry || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
}

/** 축약/전체 해시가 같은 커밋을 가리키는지 확인한다. */
function sameHash(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}
