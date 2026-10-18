// 진행 중인 git rebase 의 todo 진행률을 읽는 헬퍼.
// - Git 이 직접 관리하는 rebase-merge/rebase-apply 상태 파일을 읽어, 충돌 지점과 남은 todo 를 UI 에 보여준다.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { normalizeRebaseTodoAction } from "./rebaseTodoValidation";

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
  role: "done" | "current" | "remaining";
  index: number;
  action: string;
  hash?: string;
  subject?: string;
}

const MAX_PROGRESS_ITEMS = 10;
const MAX_DONE_ITEMS = Math.min(3, MAX_PROGRESS_ITEMS - 1);
const TODO_HASH_PREFIX = /^\S+\s+([0-9a-f]{4,64})(?=\s|$)/i;

/**
 * 현재 저장소에서 진행 중인 rebase todo 진행률을 읽는다.
 * - `done` 은 이미 Git 이 처리 대상으로 꺼낸 todo 수이고, 충돌 중이면 보통 현재 커밋까지 포함한다.
 * - `remaining` 은 아직 `git-rebase-todo` 에 남아 있는 todo 수다.
 * @param repoRoot git 저장소 루트
 * @param knownGitDir 같은 작업에서 이미 확인한 worktree 전용 Git directory. 상태 파일은 매번 새로 읽는다.
 * @returns 진행 중인 rebase 가 있으면 진행률, 아니면 undefined
 */
export async function readRebaseTodoProgress(
  repoRoot: string,
  knownGitDir?: string
): Promise<RebaseTodoProgress | undefined> {
  const state = await readRebaseStateFiles(repoRoot, knownGitDir);
  if (!state) {
    return undefined;
  }
  return buildRebaseTodoProgress(state.done, state.todo, await resolveRebaseHead(repoRoot, state.gitDir));
}

/**
 * native todo 텍스트와 이번 호출의 REBASE_HEAD를 표시용 진행률로 변환한다.
 * @param doneRaw 이미 처리 대상으로 꺼낸 todo 원문 @param remainingRaw 남은 todo 원문
 * @param rebaseHead 현재 원본 OID. 없으면 done의 마지막 hash 또는 마지막 항목을 사용한다.
 * @returns 전체 항목 수와 최대 10개의 현재 주변 항목. Git/파일 IO는 수행하지 않는다.
 */
export function buildRebaseTodoProgress(
  doneRaw: string, remainingRaw: string, rebaseHead?: string
): RebaseTodoProgress {
  let done = scanDoneWindow(doneRaw, rebaseHead);
  const currentHash = rebaseHead || done.lastHash;
  if (!rebaseHead && currentHash) done = scanDoneWindow(doneRaw, currentHash);
  const current = currentHash
    ? done.currentRaw ? parseTodoEntry(done.currentRaw) : { action: "pick", hash: currentHash }
    : done.tail.length ? parseTodoEntry(done.tail[done.tail.length - 1]) : undefined;
  const doneBeforeCurrent = done.currentIndex >= 0 ? done.currentIndex : current ? Math.max(0, done.count - 1) : done.count;
  const before = done.currentIndex >= 0 ? done.before : current ? done.tail.slice(0, -1) : done.tail;
  const visibleDone = before.slice(Math.max(0, before.length - MAX_DONE_ITEMS));
  const doneItems = visibleDone.map((line, index) => ({
    role: "done" as const, index: doneBeforeCurrent - visibleDone.length + index + 1, ...parseTodoEntry(line),
  }));
  const currentItems = current ? [{
    role: "current" as const, index: Math.max(1, done.count), action: current.action,
    hash: current.hash || currentHash, subject: current.subject,
  }] : [];
  const remaining = scanRemainingWindow(remainingRaw, Math.max(0, MAX_PROGRESS_ITEMS - doneItems.length - currentItems.length));
  const next = remaining.nextRaw ? parseTodoEntry(remaining.nextRaw) : undefined;
  const remainingItems = remaining.visible.map((line, index) => ({
    role: "remaining" as const, index: done.count + index + 1, ...parseTodoEntry(line),
  }));
  return {
    currentHash: current?.hash || currentHash, currentSubject: current?.subject,
    nextHash: next?.hash, nextSubject: next?.subject,
    done: done.count, remaining: remaining.count, total: done.count + remaining.count,
    items: [...doneItems, ...currentItems, ...remainingItems],
    omittedItemCount: Math.max(0, doneBeforeCurrent - doneItems.length) + Math.max(0, remaining.count - remainingItems.length),
  };
}

/** done 전체를 배열로 보관하지 않고 현재 항목 전후의 작은 원문 창만 유지한다. */
interface DoneWindow {
  count: number;
  lastHash?: string;
  currentRaw?: string;
  currentIndex: number;
  before: string[];
  tail: string[];
}

/**
 * 모든 done 항목 수와 마지막 hash를 세고, 최초 현재 hash 앞의 최대 세 행만 보관한다.
 * @param raw native done 원문 @param currentHash 찾을 전체/축약 OID. 없으면 마지막 hash만 수집한다.
 * @returns 현재 위치·직전 창과 fallback을 위한 마지막 네 행. 항목 수와 무관한 크기다.
 */
function scanDoneWindow(raw: string, currentHash?: string): DoneWindow {
  const result: DoneWindow = { count: 0, currentIndex: -1, before: [], tail: [] };
  for (const line of todoLines(raw)) {
    const hash = todoLineHash(line);
    if (hash) {
      result.lastHash = hash;
      if (result.currentIndex < 0 && currentHash && (currentHash.startsWith(hash) || hash.startsWith(currentHash))) {
        result.currentRaw = line;
        result.currentIndex = result.count;
        result.before = result.tail.slice(Math.max(0, result.tail.length - MAX_DONE_ITEMS));
      }
    }
    result.tail.push(line);
    if (result.tail.length > MAX_DONE_ITEMS + 1) result.tail.shift();
    result.count++;
  }
  return result;
}

/**
 * 남은 항목 전체를 세되 표시할 행과 첫 다음 commit 원문만 보관한다.
 * @param raw 남은 todo 원문 @param limit 현재/완료 행을 제외한 표시 행 수
 * @returns 전체 수·표시 창·다음 hash가 있는 행. commit이 없으면 첫 directive를 선택한다.
 */
function scanRemainingWindow(raw: string, limit: number): { count: number; visible: string[]; nextRaw?: string } {
  let count = 0, first: string | undefined, next: string | undefined;
  const visible: string[] = [];
  for (const line of todoLines(raw)) {
    if (first === undefined) first = line;
    if (visible.length < limit) visible.push(line);
    if (next === undefined && todoLineHash(line)) next = line;
    count++;
  }
  return { count, visible, nextRaw: next ?? first };
}

/** 줄 배열을 만들지 않고 기존 정책대로 빈 줄과 주석을 제외한 todo 원문을 하나씩 반환한다. */
function* todoLines(raw: string): Generator<string> {
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf("\n", start);
    const line = raw.slice(start, end < 0 ? raw.length : end).trim();
    start = end < 0 ? raw.length : end + 1;
    if (line && !line.startsWith("#")) yield line;
  }
}

/** subject를 토큰 배열로 분할하지 않고 기존 두 번째 토큰 규칙의 hash만 찾는다. */
function todoLineHash(line: string): string | undefined {
  return TODO_HASH_PREFIX.exec(line)?.[1];
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
  gitDir: string;
  done: string;
  todo: string;
}

/**
 * worktree 전용 git-dir를 한 번 해석한 뒤 두 backend의 done/todo 파일을 읽는다.
 * - 상태 파일은 매번 다시 읽어 Continue/Skip 이후의 진행률을 캐시 없이 반영한다.
 * @param repoRoot 대상 worktree 루트
 * @param knownGitDir 이번 호출 안에서만 재사용할, 이미 확인한 worktree 전용 경로
 * @returns 내용이 있는 첫 backend의 상태, 진행 중 todo가 없으면 undefined
 */
async function readRebaseStateFiles(repoRoot: string, knownGitDir?: string): Promise<RebaseStateFiles | undefined> {
  const gitDir = knownGitDir ?? path.resolve(repoRoot,
    (await runGit(["rev-parse", "--git-dir"], repoRoot)).replace(/\r?\n$/, ""));
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const [done, todo] = await Promise.all([
      fs.readFile(path.join(gitDir, dir, "done"), "utf8").catch(() => ""),
      fs.readFile(path.join(gitDir, dir, "git-rebase-todo"), "utf8").catch(() => ""),
    ]);
    if (done || todo) {
      return { gitDir, done, todo };
    }
  }
  return undefined;
}

/** rebase todo 한 줄을 action/hash/subject 로 나눈다. */
function parseTodoEntry(line: string): RebaseTodoEntry {
  const [action = "", hash, ...subject] = line.split(/\s+/);
  return {
    action: copyTodoField(normalizeRebaseTodoAction(action)),
    hash: looksLikeHash(hash) ? copyTodoField(hash) : undefined,
    subject: subject.length ? copyTodoField(subject.join(" ").trim()) || undefined : undefined,
  };
}

/**
 * 현재 항목의 REBASE_HEAD를 매번 다시 읽되 일반 loose pseudoref는 Git spawn을 생략한다.
 * - 짧은 일반 파일의 완전한 OID만 사용하고 symbolic/ref backend·부재·오류는 Git으로 해석한다.
 * @param repoRoot 저장소 루트 @param gitDir 이번 호출에서 확인한 worktree 전용 Git directory
 * @returns Git과 같은 현재 원본 OID. 확인할 수 없으면 done 목록의 fallback을 사용하도록 undefined
 */
async function resolveRebaseHead(repoRoot: string, gitDir: string): Promise<string | undefined> {
  const loose = await readLooseRebaseHead(gitDir);
  if (loose) return loose;
  const hash = (await runGit(["rev-parse", "--verify", "REBASE_HEAD"], repoRoot).catch(() => "")).trim();
  return hash || undefined;
}

/** HEAD와 OID 길이가 같은 loose REBASE_HEAD만 사용해 저장소 객체 형식과 다른 길이는 Git에 위임한다. */
async function readLooseRebaseHead(gitDir: string): Promise<string | undefined> {
  const [head, rebaseHead] = await Promise.all([readLooseOidFile(gitDir, "HEAD"), readLooseOidFile(gitDir, "REBASE_HEAD")]);
  return head && rebaseHead?.length === head.length ? rebaseHead : undefined;
}

/**
 * loose OID를 FD 하나로 최대 256바이트만 읽어 대용량/링크/비표준 ref는 Git에 위임한다.
 * @param gitDir 현재 worktree의 Git directory
 * @param name 현재 HEAD 또는 REBASE_HEAD 파일 이름
 * @returns 전체 파일이 40/64자리 소문자 OID와 선택적 줄바꿈이면 그 OID, 아니면 undefined
 */
async function readLooseOidFile(gitDir: string, name: "HEAD" | "REBASE_HEAD"): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(gitDir, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256) return undefined;
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /^([0-9a-f]{40}|[0-9a-f]{64})(?:\r?\n)?$/.exec(buffer.subarray(0, bytesRead).toString("utf8"))?.[1];
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

/**
 * 선택된 문자열만 독립 복사해 짧은 hash/subject가 거대한 todo 원문 전체를 붙잡지 않게 한다.
 * @param value 최대 열 표시 행에서 선택한 필드 @returns UTF-16 코드 단위까지 같은 독립 문자열
 */
function copyTodoField(value: string): string {
  return Buffer.from(value, "utf16le").toString("utf16le");
}

/** rebase todo 의 두 번째 토큰이 commit hash 처럼 보이는지 확인한다. */
function looksLikeHash(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{4,64}$/i.test(value));
}

/** 긴 commit hash 를 UI 메시지용으로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
