// 진행 중인 git rebase 의 todo 진행률을 읽는 헬퍼.
// - Git 이 직접 관리하는 rebase-merge/rebase-apply 상태 파일을 읽어, 충돌 지점과 남은 todo 를 UI 에 보여준다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";

export interface RebaseTodoEntry {
  action: string;
  hash?: string;
  subject?: string;
}

export interface RebaseTodoProgress {
  currentHash?: string;
  currentSubject?: string;
  nextHash?: string;
  nextSubject?: string;
  done: number;
  remaining: number;
  total: number;
  items: RebaseTodoProgressItem[];
  omittedItemCount: number;
}

export interface RebaseTodoProgressItem {
  role: "current" | "remaining";
  index: number;
  action: string;
  hash?: string;
  subject?: string;
}

const MAX_PROGRESS_ITEMS = 10;

/**
 * 현재 저장소에서 진행 중인 rebase todo 진행률을 읽는다.
 * - `done` 은 이미 Git 이 처리 대상으로 꺼낸 todo 수이고, 충돌 중이면 보통 현재 커밋까지 포함한다.
 * - `remaining` 은 아직 `git-rebase-todo` 에 남아 있는 todo 수다.
 * @param repoRoot git 저장소 루트
 * @returns 진행 중인 rebase 가 있으면 진행률, 아니면 undefined
 */
export async function readRebaseTodoProgress(
  repoRoot: string
): Promise<RebaseTodoProgress | undefined> {
  const state = await readRebaseStateFiles(repoRoot);
  if (!state) {
    return undefined;
  }
  const done = parseTodoEntries(state.done);
  const remaining = parseTodoEntries(state.todo);
  const currentHash = (await resolveRebaseHead(repoRoot)) || lastCommitHash(done);
  const current = currentHash
    ? findEntryByHash(done, currentHash) || { action: "pick", hash: currentHash }
    : done[done.length - 1];
  const next = remaining.find((entry) => Boolean(entry.hash)) || remaining[0];
  const currentItem = current
    ? [{
        role: "current" as const,
        index: Math.max(1, done.length),
        action: current.action,
        hash: current.hash || currentHash,
        subject: current.subject,
      }]
    : [];
  const remainingItems = remaining.slice(0, MAX_PROGRESS_ITEMS - currentItem.length).map((entry, index) => ({
    role: "remaining" as const,
    index: done.length + index + 1,
    action: entry.action,
    hash: entry.hash,
    subject: entry.subject,
  }));
  return {
    currentHash: current?.hash || currentHash,
    currentSubject: current?.subject,
    nextHash: next?.hash,
    nextSubject: next?.subject,
    done: done.length,
    remaining: remaining.length,
    total: done.length + remaining.length,
    items: [...currentItem, ...remainingItems],
    omittedItemCount: Math.max(0, remaining.length - remainingItems.length),
  };
}

/**
 * rebase 진행률을 사용자 안내 문장으로 만든다.
 * @param progress readRebaseTodoProgress 가 반환한 진행률
 * @returns 알림/로그에 넣기 좋은 짧은 문장
 */
export function formatRebaseTodoProgress(
  progress: RebaseTodoProgress | undefined
): string {
  if (!progress || progress.total <= 0) {
    return "";
  }
  const step = Math.min(progress.done, progress.total);
  const current = progress.currentHash
    ? `Current ${shortHash(progress.currentHash)}${progress.currentSubject ? ` ${progress.currentSubject}` : ""}.`
    : "";
  const next = progress.remaining > 0
    ? `Next ${progress.nextHash ? shortHash(progress.nextHash) : "todo"}${progress.nextSubject ? ` ${progress.nextSubject}` : ""}.`
    : "No remaining todo.";
  return `Todo ${step}/${progress.total}. ${progress.remaining} remaining. ${current} ${next}`.trim();
}

interface RebaseStateFiles {
  done: string;
  todo: string;
}

/** rebase-merge/rebase-apply 디렉터리에서 done/todo 파일을 읽는다. */
async function readRebaseStateFiles(repoRoot: string): Promise<RebaseStateFiles | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const [donePath, todoPath] = await Promise.all([
      gitPath(repoRoot, `${dir}/done`),
      gitPath(repoRoot, `${dir}/git-rebase-todo`),
    ]);
    const [done, todo] = await Promise.all([
      fs.readFile(donePath, "utf8").catch(() => ""),
      fs.readFile(todoPath, "utf8").catch(() => ""),
    ]);
    if (done || todo) {
      return { done, todo };
    }
  }
  return undefined;
}

/** git metadata 상대 경로를 linked worktree 에서도 유효한 절대 경로로 변환한다. */
async function gitPath(repoRoot: string, rel: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", rel], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}

/** rebase todo 텍스트에서 주석/빈 줄을 제외한 todo entry 를 파싱한다. */
function parseTodoEntries(raw: string): RebaseTodoEntry[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseTodoEntry);
}

/** rebase todo 한 줄을 action/hash/subject 로 나눈다. */
function parseTodoEntry(line: string): RebaseTodoEntry {
  const [action = "", hash, ...subject] = line.split(/\s+/);
  return {
    action,
    hash: looksLikeHash(hash) ? hash : undefined,
    subject: subject.join(" ").trim() || undefined,
  };
}

/** 현재 충돌 중인 rebase commit 을 REBASE_HEAD 로 확인한다. */
async function resolveRebaseHead(repoRoot: string): Promise<string | undefined> {
  const hash = (await runGit(["rev-parse", "--verify", "REBASE_HEAD"], repoRoot).catch(() => "")).trim();
  return hash || undefined;
}

/** done 목록에서 마지막 commit hash 를 찾는다. */
function lastCommitHash(entries: RebaseTodoEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].hash) {
      return entries[i].hash;
    }
  }
  return undefined;
}

/** 축약/전체 해시가 같은 todo entry 를 찾는다. */
function findEntryByHash(entries: RebaseTodoEntry[], hash: string): RebaseTodoEntry | undefined {
  return entries.find((entry) =>
    Boolean(entry.hash) && (hash.startsWith(entry.hash!) || entry.hash!.startsWith(hash))
  );
}

/** rebase todo 의 두 번째 토큰이 commit hash 처럼 보이는지 확인한다. */
function looksLikeHash(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{4,40}$/i.test(value));
}

/** 긴 commit hash 를 UI 메시지용으로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
