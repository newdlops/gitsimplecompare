// 진행 중인 interactive rebase 의 todo 파일을 UI 계획과 동기화한다.
// - rebase 시작 후 drawer 에서 바꾼 action 도 다음 `git rebase --continue` 전에 반영한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { normalizeRebaseTodoAction } from "./rebaseTodoValidation";
import { logError, logInfo } from "../ui/outputLog";
import type { RebaseItem, RebasePausedState } from "./rebaseService";
import {
  collectHistoryExcludePaths,
  isRebaseFileAmendExecLine,
} from "./rebaseFileExcludes";
import {
  hasFileRewriteForItem,
  hasFileRewriteSelection,
  rebaseFileRewriteExecLine,
} from "./rebaseFileRewriteOps";

/** rebase todo 동기화 결과 */
export interface RebaseTodoUpdateResult {
  changed: boolean;
  missingChangedEditHashes: string[];
  missingChangedFileHashes: string[];
}

/** 진행 중인 rebase todo 에 파일 제외 exec 를 다시 쓸 때 필요한 옵션 */
export interface RebaseTodoUpdateOptions {
  /** rebaseEditor.js 절대 경로. 없으면 기존 exec 줄은 건드리지 않고 action 만 갱신한다. */
  editorScript?: string;
  /** Electron/Node 실행 파일 경로. 기본값은 현재 확장 호스트의 process.execPath 이다. */
  nodePath?: string;
}

/**
 * 현재 진행 중인 rebase todo 파일의 남은 commit action 을 UI 계획으로 갱신한다.
 * - 이미 적용된 커밋은 todo 에 없으므로 바꿀 수 없다.
 * - 파일 단위 제외/포함 변경은 남은 todo 의 Git Simple Compare exec amend 줄을 다시 만든다.
 * - 호출부는 missingChangedEditHashes 를 사용자에게 경고해 조용히 종료되는 흐름을 막는다.
 * @param repoRoot 저장소 루트
 * @param items UI 가 가진 전체 rebase 계획
 * @param changedHashes rebase 시작 후 사용자가 action 을 바꾼 커밋 해시
 * @param paused 현재 edit 정지 상태
 * @param options 파일 제외 exec 를 만들 때 필요한 helper 경로 옵션
 */
export async function updateInProgressRebaseTodo(
  repoRoot: string,
  items: RebaseItem[],
  changedHashes: string[] = [],
  paused?: RebasePausedState,
  options: RebaseTodoUpdateOptions = {}
): Promise<RebaseTodoUpdateResult> {
  const unchanged = { changed: false, missingChangedEditHashes: [], missingChangedFileHashes: [] };
  if (!items.length && !changedHashes.length) return unchanged;
  const operation = await captureGitOperation(repoRoot);
  if (operation.operation !== "rebase") return unchanged;
  const todoPath = await findTodoPath(operation.gitDir);
  if (!todoPath) return unchanged;
  const itemByHash = new Map(items.map((item) => [item.hash, item]));
  const pending = new Set<string>();
  const raw = await fs.readFile(todoPath, "utf8");
  const canRewriteFileOps = Boolean(options.editorScript);
  const historyExcludePaths = collectHistoryExcludePaths(items);
  const rewriteItems = items.filter((item) => item.action !== "drop");
  const lines = raw.split("\n");
  const parsedLines = lines.map(parseTodoCommitLine);
  for (const parsed of parsedLines) {
    const item = parsed && findItemForTodoHash(itemByHash, parsed.hash);
    if (item) pending.add(item.hash);
  }
  const missingChangedEditHashes = changedHashes.filter((hash) => {
    const item = itemByHash.get(hash);
    return item?.action === "edit" && !pending.has(item.hash) && !isPausedHash(hash, paused);
  });
  const missingChangedFileHashes = changedHashes.filter((hash) => {
    const item = itemByHash.get(hash);
    return Boolean(item && hasFileExcludeSelection(item, rewriteItems) &&
      !pending.has(item.hash) && !isPausedHash(hash, paused));
  });
  if (missingChangedEditHashes.length || missingChangedFileHashes.length) {
    logInfo("rebase todo update skipped", { repoRoot, reason: "already-applied-selection" });
    return { changed: false, missingChangedEditHashes, missingChangedFileHashes };
  }
  const next: string[] = [];
  const pausedItem = paused ? findItemForPaused(items, paused) : undefined;
  const pausedExec = canRewriteFileOps && pausedItem
    ? await fileExcludeExecLine(repoRoot, pausedItem, rewriteItems, historyExcludePaths, options)
    : undefined;
  if (pausedExec) {
    next.push(pausedExec);
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (canRewriteFileOps && isRebaseFileAmendExecLine(line)) {
      if (!pausedItem) {
        next.push(line);
      }
      continue;
    }
    const parsed = parsedLines[index];
    if (!parsed) {
      next.push(line);
      continue;
    }
    const item = findItemForTodoHash(itemByHash, parsed.hash);
    if (!item) {
      next.push(line);
      continue;
    }
    const commitLine = parsed.action === item.action
      ? line
      : `${parsed.leading}${item.action}${parsed.gap}${parsed.hash}${parsed.rest}`;
    next.push(commitLine);
    if (!canRewriteFileOps) {
      continue;
    }
    while (
      index + 1 < lines.length &&
      isRebaseFileAmendExecLine(lines[index + 1])
    ) {
      index++;
    }
    const execLine = await fileExcludeExecLine(
      repoRoot,
      item,
      rewriteItems,
      historyExcludePaths,
      options
    );
    if (execLine) {
      next.push(execLine);
    }
  }
  const nextRaw = next.join("\n");
  const changed = nextRaw !== raw;
  if (changed) {
    await writeValidatedTodo(repoRoot, operation, todoPath, raw, nextRaw);
  }
  return { changed, missingChangedEditHashes, missingChangedFileHashes };
}

/** 이미 확인한 worktree 전용 git-dir에서 진행 중 backend의 todo 경로를 찾는다. */
async function findTodoPath(gitDir: string): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const candidate = path.join(gitDir, dir, "git-rebase-todo");
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** todo 한 줄이 commit action 이면 구성 요소로 파싱한다. */
function parseTodoCommitLine(line: string): {
  leading: string;
  action: string;
  gap: string;
  hash: string;
  rest: string;
} | undefined {
  const match = /^(\s*)([a-z-]+)(\s+)([0-9a-f]{4,64})(?=\s|$)(.*)$/i.exec(line);
  const action = match && normalizeRebaseTodoAction(match[2]);
  if (!match || !action || !["pick", "reword", "edit", "squash", "fixup", "drop"].includes(action)) {
    return undefined;
  }
  return {
    leading: match[1],
    action,
    gap: match[3],
    hash: match[4],
    rest: match[5],
  };
}

/** 전체 해시는 O(1)로 찾고 축약 해시는 유일한 항목일 때만 수용해 잘못된 커밋 변경을 막는다. */
function findItemForTodoHash(
  items: ReadonlyMap<string, RebaseItem>,
  todoHash: string
): RebaseItem | undefined {
  const exact = items.get(todoHash);
  if (exact) return exact;
  let found: RebaseItem | undefined;
  for (const item of items.values()) {
    if (!item.hash.startsWith(todoHash) && !todoHash.startsWith(item.hash)) continue;
    if (found) throw new Error("The rebase todo contains an ambiguous commit hash. Refresh the rebase plan and retry.");
    found = item;
  }
  return found;
}

/**
 * 준비한 todo를 별도 lock 파일에 완성한 뒤, 원래 작업/내용이 유지될 때만 원자적으로 교체한다.
 * - lock은 rebase-merge 밖에 두어 준비 자체가 operation epoch를 바꾸지 않게 한다.
 * - 실패 시 원본 todo는 남기고 자신이 만든 lock만 정리하며 다른 writer의 lock은 건드리지 않는다.
 * @param repoRoot 대상 worktree
 * @param operation 원문을 읽기 전에 고정한 rebase 세대와 현재 HEAD/todo 상태
 * @param todoPath 교체할 native todo 파일
 * @param previous 조립에 사용한 원문. 외부 편집이 끼어들면 덮어쓰지 않는다.
 * @param content 모든 선택 검증을 통과한 새 todo
 */
async function writeValidatedTodo(
  repoRoot: string,
  operation: GitOperationIdentity,
  todoPath: string,
  previous: string,
  content: string
): Promise<void> {
  const lockPath = path.join(operation.gitDir, "gitsimplecompare", "rebase-todo.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await fs.open(lockPath, "wx", 0o600);
  let identity: { dev: number; ino: number } | undefined;
  try {
    identity = await lock.stat();
    await lock.writeFile(content, "utf8");
    await lock.sync();
    await lock.close();
    await assertGitOperation(repoRoot, operation);
    const current = await fs.readFile(todoPath, "utf8");
    if (current !== previous || !await ownsTodoLock(lockPath, identity)) {
      throw new Error("The rebase todo changed while preparing the update. Refresh the rebase plan and retry.");
    }
    await fs.rename(lockPath, todoPath);
    logInfo("rebase todo updated", { repoRoot, generation: operation.generation });
  } finally {
    try {
      // 첫 stat만 실패했다면 닫기 전에 소유권을 다시 확인해 복구 가능한 lock을 정리한다.
      identity ??= await lock.stat();
    } catch (error) {
      logError("rebase todo lock identity unavailable", error, { repoRoot, lockPath });
    }
    await lock.close().catch(() => undefined);
    try {
      if (identity && await ownsTodoLock(lockPath, identity)) await fs.unlink(lockPath);
    } catch (error) {
      logError("rebase todo lock cleanup failed", error, { repoRoot, lockPath });
    }
  }
}

/**
 * inode/device까지 같은 일반 파일일 때만 자신이 만든 lock으로 판단한다.
 * @param lockPath 처음 배타적으로 생성한 lock의 경로
 * @param identity 열린 파일 handle에서 얻은 소유권 정보
 * @returns 외부 writer가 교체하거나 삭제한 경로는 false로 반환한다.
 */
async function ownsTodoLock(lockPath: string, identity: { dev: number; ino: number }): Promise<boolean> {
  try {
    const current = await fs.lstat(lockPath);
    return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 현재 paused edit 상태와 같은 원본 커밋을 가리키는 UI 항목을 찾는다.
 * @param items UI 가 가진 전체 rebase 계획
 * @param paused 현재 edit 정지 상태
 */
function findItemForPaused(
  items: RebaseItem[],
  paused: RebasePausedState
): RebaseItem | undefined {
  return items.find((item) => item.hash === paused.hash || item.hash === paused.originalHash);
}

/** 현재 멈춰 있는 커밋 자체는 todo 에 없어도 누락 경고 대상이 아니다. */
function isPausedHash(hash: string, paused?: RebasePausedState): boolean {
  return Boolean(paused && (paused.hash === hash || paused.originalHash === hash));
}

/**
 * rebase todo 에 넣을 파일 제외 amend exec 줄을 만든다.
 * @param item rebase todo 항목
 * @param historyExcludePaths 계획 전체에 적용할 파일 제외 경로
 * @param options helper 경로 옵션
 * @returns 제외 작업이 없거나 helper 경로가 없으면 undefined
 */
async function fileExcludeExecLine(
  repoRoot: string,
  item: RebaseItem,
  items: RebaseItem[],
  historyExcludePaths: string[],
  options: RebaseTodoUpdateOptions
): Promise<string | undefined> {
  if (item.action === "drop" || !options.editorScript) {
    return undefined;
  }
  return (await rebaseFileRewriteExecLine(
    repoRoot,
    item,
    items,
    historyExcludePaths,
    options.nodePath ?? process.execPath,
    options.editorScript
  ))?.line;
}

/**
 * 사용자가 파일 단위 제외 상태를 선택해 둔 항목인지 확인한다.
 * @param item rebase todo 항목
 */
function hasFileExcludeSelection(item: RebaseItem, items: RebaseItem[]): boolean {
  return hasFileRewriteForItem(item, items) || hasFileRewriteSelection(item);
}
