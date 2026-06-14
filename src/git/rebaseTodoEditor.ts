// 진행 중인 interactive rebase 의 todo 파일을 UI 계획과 동기화한다.
// - rebase 시작 후 drawer 에서 바꾼 action 도 다음 `git rebase --continue` 전에 반영한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import type { RebaseItem, RebasePausedState } from "./rebaseService";

/** rebase todo 동기화 결과 */
export interface RebaseTodoUpdateResult {
  changed: boolean;
  missingChangedEditHashes: string[];
}

/**
 * 현재 진행 중인 rebase todo 파일의 남은 commit action 을 UI 계획으로 갱신한다.
 * - 이미 적용된 커밋은 todo 에 없으므로 바꿀 수 없다.
 * - 호출부는 missingChangedEditHashes 를 사용자에게 경고해 조용히 종료되는 흐름을 막는다.
 * @param repoRoot 저장소 루트
 * @param items UI 가 가진 전체 rebase 계획
 * @param changedHashes rebase 시작 후 사용자가 action 을 바꾼 커밋 해시
 * @param paused 현재 edit 정지 상태
 */
export async function updateInProgressRebaseTodo(
  repoRoot: string,
  items: RebaseItem[],
  changedHashes: string[] = [],
  paused?: RebasePausedState
): Promise<RebaseTodoUpdateResult> {
  const todoPath = await findTodoPath(repoRoot);
  if (!todoPath) {
    return { changed: false, missingChangedEditHashes: [] };
  }
  const itemByHash = new Map(items.map((item) => [item.hash, item]));
  const pending = new Set<string>();
  const raw = await fs.readFile(todoPath, "utf8");
  let changed = false;
  const lines = raw.split("\n").map((line) => {
    const parsed = parseTodoCommitLine(line);
    if (!parsed) {
      return line;
    }
    const item = findItemForTodoHash(items, parsed.hash);
    if (!item) {
      return line;
    }
    pending.add(item.hash);
    if (parsed.action === item.action) {
      return line;
    }
    changed = true;
    return `${parsed.leading}${item.action}${parsed.gap}${parsed.hash}${parsed.rest}`;
  });
  if (changed) {
    await fs.writeFile(todoPath, lines.join("\n"), "utf8");
  }
  return {
    changed,
    missingChangedEditHashes: changedHashes.filter((hash) => {
      const item = itemByHash.get(hash);
      return item?.action === "edit" && !pending.has(item.hash) && !isPausedHash(hash, paused);
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

/** 현재 멈춰 있는 커밋 자체는 todo 에 없어도 누락 경고 대상이 아니다. */
function isPausedHash(hash: string, paused?: RebasePausedState): boolean {
  return Boolean(paused && (paused.hash === hash || paused.originalHash === hash));
}
