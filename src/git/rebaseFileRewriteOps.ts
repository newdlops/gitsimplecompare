// interactive rebase 중 파일 변경을 제거/이동하기 위한 amend exec 작업을 만든다.
// - UI 의 파일 단위 선택을 Git 이 실행할 수 있는 JSON 작업 파일과 patch 파일로 변환한다.
// - patch 는 .git metadata 아래에 저장해 extension reload 후에도 rebase todo 의 exec 가 계속 참조할 수 있게 한다.
import * as fs from "node:fs/promises";
import { writeSync } from "node:fs";
import * as path from "node:path";
import { runGit, runGitStream } from "./gitExec";
import type { RebaseFileExcludeOp } from "./rebaseFileExcludes";
import { buildFileExcludeOps, rebaseFileAmendExecLine } from "./rebaseFileExcludes";
import type { RebaseFileMove, RebaseItem } from "./rebaseService";

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
  return new RebaseFileRewritePlanner(repoRoot, items, historyExcludePaths, nodePath, editorScript).execLine(item);
}

/** 작업 한 번에만 존재하는 파일 이동 색인과 metadata 경로. HEAD나 native todo 상태는 캐시하지 않는다. */
export class RebaseFileRewritePlanner {
  private readonly from = new Map<string, RebaseFileMove[]>();
  private readonly to = new Map<string, RebaseFileMove[]>();
  private readonly hashes: Set<string>;
  private directory?: Promise<string>;

  /** 전체 todo의 이동 선택을 한 번 색인한다. 경로 조회/Git 실행은 실제 rewrite가 필요할 때까지 미룬다. */
  constructor(
    private readonly repoRoot: string,
    items: RebaseItem[],
    private readonly historyExcludePaths: string[],
    private readonly nodePath: string,
    private readonly editorScript: string
  ) {
    this.hashes = new Set(items.map(item => item.hash));
    for (const move of collectFileMoves(items)) {
      const from = this.from.get(move.sourceHash), to = this.to.get(move.targetHash);
      if (from) from.push(move);
      else this.from.set(move.sourceHash, [move]);
      if (to) to.push(move);
      else this.to.set(move.targetHash, [move]);
    }
  }

  /** 항목 자체의 제외/이동 선택과 다른 커밋에서 들어오는 patch 유무를 확인한다. */
  hasRewrite(item: RebaseItem): boolean {
    return hasFileRewriteSelection(item) || this.movesFor(this.to, item.hash).length > 0;
  }

  /** 현재 항목의 JSON/patch를 만들고 native todo exec 줄을 반환한다. 선택이 없으면 Git을 실행하지 않는다. */
  async execLine(item: RebaseItem): Promise<{ line: string; opFile: string } | undefined> {
    if (item.action === "drop") return undefined;
    const files = [...buildFileExcludeOps(item, this.historyExcludePaths),
      ...this.movesFor(this.from, item.hash).map(move => ({
        path: move.sourcePath, oldPath: move.sourceOldPath, status: move.sourceOldPath ? "R" : undefined,
      }))];
    const patches = await this.patchOps(item);
    if (!files.length && !patches.length) return undefined;
    const opFile = path.join(await this.opsDirectory(), uniqueName("ops", "json"));
    const ops: RebaseFileRewriteOps = { version: 2, files: uniqueRestoreOps(files), patches };
    await fs.writeFile(opFile, `${JSON.stringify(ops)}\n`, "utf8");
    return { line: rebaseFileAmendExecLine(this.nodePath, this.editorScript, opFile), opFile };
  }

  /** 계획에 있는 전체 해시는 O(1)로 조회하고, 별도 호출자가 준 축약 해시만 기존 prefix 규칙으로 찾는다. */
  private movesFor(index: Map<string, RebaseFileMove[]>, hash: string): RebaseFileMove[] {
    if (this.hashes.has(hash)) return index.get(hash) ?? [];
    return Array.from(index).filter(([key]) => sameHash(key, hash)).flatMap(([, moves]) => moves);
  }

  /** 같은 source→target의 파일을 묶어 patch를 만든다. 인자 크기는 경로 수/바이트로 제한한다. */
  private async patchOps(item: RebaseItem): Promise<RebaseFilePatchOp[]> {
    const groups = new Map<string, RebaseFileMove[]>();
    for (const move of this.movesFor(this.to, item.hash)) {
      const group = groups.get(move.sourceHash);
      if (group) group.push(move);
      else groups.set(move.sourceHash, [move]);
    }
    const ops: RebaseFilePatchOp[] = [];
    for (const moves of groups.values()) {
      let batch: RebaseFileMove[] = [], bytes = 0;
      for (const move of moves) {
        const size = Buffer.byteLength(move.sourcePath) + Buffer.byteLength(move.sourceOldPath ?? "") + 2;
        if (batch.length && (batch.length >= 96 || bytes + size > 24 * 1024)) {
          ops.push(await this.writePatch(batch));
          batch = []; bytes = 0;
        }
        batch.push(move); bytes += size;
      }
      if (batch.length) ops.push(await this.writePatch(batch));
    }
    return ops;
  }

  /** root를 포함한 source 변경을 한 번 읽어 binary patch로 저장한다. rename의 old/new 경로는 같은 batch에 둔다. */
  private async writePatch(moves: RebaseFileMove[]): Promise<RebaseFilePatchOp> {
    const move = moves[0];
    const paths = uniquePaths(moves.flatMap(entry => [entry.sourceOldPath, entry.sourcePath]));
    const patchPath = path.join(await this.opsDirectory(), uniqueName("move", "patch"));
    const handle = await fs.open(patchPath, "wx", 0o600);
    let bytes = 0, complete = false;
    try {
      // 큰 binary patch를 문자열로 모으지 않는다. 작은 stdout 조각을 바로 기록해 메모리 사용을 제한한다.
      await runGitStream(["diff-tree", "--root", "--no-commit-id", "--no-ext-diff", "-r", "-p", "--binary", "--full-index", "-M",
        move.sourceHash, "--", ...paths], this.repoRoot, (chunk) => {
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(handle.fd, chunk, offset, chunk.length - offset);
        bytes += chunk.length;
      }, { env: { GIT_LITERAL_PATHSPECS: "1" } });
      if (!bytes) throw new Error(`No patch found for ${move.sourcePath} in ${move.sourceHash.slice(0, 10)}.`);
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await fs.unlink(patchPath).catch(() => undefined);
    }
    return { ...move, patchPath, paths };
  }

  /** linked worktree 전용 작업 디렉터리를 한 번만 확인한다. 캐시는 이 planner 인스턴스에만 남는다. */
  private opsDirectory(): Promise<string> {
    this.directory ??= gitMetadataDirectory(this.repoRoot);
    return this.directory;
  }
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

/** git metadata 상대 디렉터리를 현재 linked worktree의 절대 경로로 바꾸고 생성한다. */
async function gitMetadataDirectory(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", "gitsimplecompare/rebase-ops"], repoRoot)).replace(/\r?\n$/, "");
  const directory = path.resolve(repoRoot, raw);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

/** 같은 작업 내 여러 JSON/patch가 서로 덮어쓰지 않도록 고유 파일명을 반환한다. */
function uniqueName(prefix: string, extension: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
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
