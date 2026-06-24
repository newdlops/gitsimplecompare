// 진행 중인 interactive rebase 의 todo 파일을 UI 계획과 동기화한다.
// - rebase 시작 후 drawer 에서 바꾼 action 도 다음 `git rebase --continue` 전에 반영한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
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
  const todoPath = await findTodoPath(repoRoot);
  if (!todoPath) {
    return {
      changed: false,
      missingChangedEditHashes: [],
      missingChangedFileHashes: [],
    };
  }
  const itemByHash = new Map(items.map((item) => [item.hash, item]));
  const pending = new Set<string>();
  const raw = await fs.readFile(todoPath, "utf8");
  const canRewriteFileOps = Boolean(options.editorScript);
  const historyExcludePaths = collectHistoryExcludePaths(items);
  const rewriteItems = items.filter((item) => item.action !== "drop");
  const lines = raw.split("\n");
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
    const parsed = parseTodoCommitLine(line);
    if (!parsed) {
      next.push(line);
      continue;
    }
    const item = findItemForTodoHash(items, parsed.hash);
    if (!item) {
      next.push(line);
      continue;
    }
    pending.add(item.hash);
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
    await fs.writeFile(todoPath, nextRaw, "utf8");
  }
  return {
    changed,
    missingChangedEditHashes: changedHashes.filter((hash) => {
      const item = itemByHash.get(hash);
      return item?.action === "edit" && !pending.has(item.hash) && !isPausedHash(hash, paused);
    }),
    missingChangedFileHashes: changedHashes.filter((hash) => {
      const item = itemByHash.get(hash);
      return Boolean(
        item &&
        hasFileExcludeSelection(item, rewriteItems) &&
        !pending.has(item.hash) &&
        !isPausedHash(hash, paused)
      );
    }),
  };
}

/** rebase-merge/rebase-apply 중 실제 todo 파일 경로를 찾는다. */
async function findTodoPath(repoRoot: string): Promise<string | undefined> {
  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], repoRoot)).trim();
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const candidate = path.join(gitDir, dir, "git-rebase-todo");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 다른 rebase backend 후보를 계속 확인한다.
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
  const match = /^(\s*)(pick|reword|edit|squash|fixup|drop)(\s+)([0-9a-f]{4,40})(.*)$/i.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    leading: match[1],
    action: match[2],
    gap: match[3],
    hash: match[4],
    rest: match[5],
  };
}

/** todo 의 축약 해시와 UI 계획의 전체 해시를 매칭한다. */
function findItemForTodoHash(
  items: RebaseItem[],
  todoHash: string
): RebaseItem | undefined {
  return items.find((item) =>
    item.hash === todoHash || item.hash.startsWith(todoHash) || todoHash.startsWith(item.hash)
  );
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
