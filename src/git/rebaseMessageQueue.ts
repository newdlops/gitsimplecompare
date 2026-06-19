// interactive rebase 의 reword/squash 메시지 큐를 git metadata 아래에 보존하는 모듈.
// - rebase 시작 프로세스가 끝난 뒤 `git rebase --continue` 가 다시 실행되어도
//   같은 rebaseEditor.js msg 헬퍼가 남은 메시지를 적용할 수 있게 한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { readRebaseTodoProgress } from "./rebaseTodoProgress";
import type { RebaseItem } from "./rebaseService";

interface RebaseMessageQueueState {
  version: 1;
  queuePath: string;
  editorScript: string;
  nodePath: string;
}

interface TodoCommitLine {
  action: string;
  hash: string;
}

export interface RebaseMessageQueueOptions {
  includeCurrent?: boolean;
}

export interface RebaseMessageQueueRefreshResult {
  env: Record<string, string>;
  queueLength?: number;
}

const STATE_REL = "gitsimplecompare/rebase-message-queue-state.json";
const QUEUE_REL = "gitsimplecompare/rebase-message-queue.json";
const MESSAGE_ACTIONS = new Set(["reword", "squash"]);

/**
 * 새 graph interactive rebase 에 사용할 메시지 큐와 editor 상태를 저장한다.
 * - 큐 파일은 rebase 가 중간에 멈춘 뒤에도 `--continue` 에서 다시 읽을 수 있어야 하므로
 *   임시 디렉터리가 아니라 git metadata 경로에 둔다.
 * @param repoRoot 저장소 루트
 * @param items rebase 시작 시 확정된 todo 항목
 * @param editorScript rebaseEditor.js 절대 경로
 * @param nodePath helper 를 실행할 Node/Electron 실행 파일 경로
 * @returns git 실행 env 에 합칠 editor 관련 환경 변수
 */
export async function initializeRebaseMessageQueue(
  repoRoot: string,
  items: RebaseItem[],
  editorScript: string,
  nodePath = process.execPath
): Promise<Record<string, string>> {
  const state = await stateFor(repoRoot, editorScript, nodePath);
  await writeQueue(state.queuePath, messagesForItems(items));
  await writeState(repoRoot, state);
  return editorEnv(repoRoot, state);
}

/**
 * 진행 중인 rebase 의 남은 todo 기준으로 메시지 큐를 다시 만든다.
 * - rebase 시작 후 UI 에서 뒤쪽 commit message/action 을 바꾼 경우에도 다음 `--continue`
 *   또는 `--skip` 에서 Git 이 호출하는 editor 에 올바른 메시지가 들어가게 한다.
 * @param repoRoot 저장소 루트
 * @param items UI 가 현재 가진 전체 rebase 계획
 * @param options includeCurrent=false 이면 현재 정지 항목은 skip 될 예정으로 보고 큐에서 제외한다.
 * @returns 저장된 editor 상태가 있으면 git env, 없으면 undefined
 */
export async function refreshRebaseMessageQueueForContinue(
  repoRoot: string,
  items: RebaseItem[],
  options: RebaseMessageQueueOptions = {}
): Promise<RebaseMessageQueueRefreshResult | undefined> {
  const state = await readState(repoRoot);
  if (!state) {
    return undefined;
  }
  let queueLength: number | undefined;
  if (items.length > 0) {
    const queue = await messagesForActiveTodo(repoRoot, items, options);
    queueLength = queue.length;
    await writeQueue(state.queuePath, queue);
  }
  return { env: editorEnv(repoRoot, state), queueLength };
}

/**
 * 저장된 rebase 메시지 editor 상태를 읽어 `git rebase --continue` env 로 반환한다.
 * - graph UI 가 아닌 Conflicts 뷰의 Continue 도 같은 메시지 큐를 사용할 수 있게 한다.
 * @param repoRoot 저장소 루트
 */
export async function rebaseContinueEditorEnv(
  repoRoot: string
): Promise<Record<string, string> | undefined> {
  const state = await readState(repoRoot);
  return state ? editorEnv(repoRoot, state) : undefined;
}

/**
 * 완료/abort 된 rebase 의 메시지 큐 상태를 정리한다.
 * - 삭제 실패는 다음 rebase 시작 시 덮어써지므로 호출부 흐름을 막지 않는다.
 * @param repoRoot 저장소 루트
 */
export async function cleanupRebaseMessageQueue(repoRoot: string): Promise<void> {
  const state = await readState(repoRoot);
  await Promise.all([
    state ? fs.rm(state.queuePath, { force: true }).catch(() => undefined) : undefined,
    gitPath(repoRoot, STATE_REL).then((file) => fs.rm(file, { force: true })).catch(() => undefined),
  ]);
}

/** rebase 시작 시 전체 todo 항목에서 메시지 editor 호출 순서대로 큐를 만든다. */
function messagesForItems(items: RebaseItem[]): (string | null)[] {
  return items.filter((item) => MESSAGE_ACTIONS.has(item.action)).map(messageForItem);
}

/** 진행 중인 Git todo 와 현재 UI 계획을 맞춰 남은 메시지 큐를 만든다. */
async function messagesForActiveTodo(
  repoRoot: string,
  items: RebaseItem[],
  options: RebaseMessageQueueOptions
): Promise<(string | null)[]> {
  const todo = await readTodoCommitLines(repoRoot);
  const progress = await readRebaseTodoProgress(repoRoot).catch(() => undefined);
  const current = progress?.items.find((item) => item.role === "current");
  const currentInTodo = Boolean(
    current?.hash && todo.some((line) => sameHash(line.hash, current.hash!))
  );
  const queue: (string | null)[] = [];
  if (
    options.includeCurrent !== false &&
    current?.hash &&
    MESSAGE_ACTIONS.has(current.action) &&
    !currentInTodo
  ) {
    queue.push(messageForHash(items, current.hash));
  }
  for (const line of todo) {
    if (MESSAGE_ACTIONS.has(line.action)) {
      queue.push(messageForHash(items, line.hash));
    }
  }
  return queue;
}

/** git-rebase-todo 에 남아 있는 commit action 줄만 읽는다. */
async function readTodoCommitLines(repoRoot: string): Promise<TodoCommitLine[]> {
  const todoPath = await findTodoPath(repoRoot);
  if (!todoPath) {
    return [];
  }
  const raw = await fs.readFile(todoPath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).map(parseTodoCommitLine).filter((line): line is TodoCommitLine => Boolean(line));
}

/** rebase-merge/rebase-apply 중 실제 todo 파일 경로를 찾는다. */
async function findTodoPath(repoRoot: string): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const candidate = await gitPath(repoRoot, `${dir}/git-rebase-todo`);
    if (await fs.access(candidate).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  return undefined;
}

/** todo 한 줄에서 메시지 editor 대상이 될 수 있는 commit action 을 파싱한다. */
function parseTodoCommitLine(line: string): TodoCommitLine | undefined {
  const match = /^\s*(pick|reword|edit|squash|fixup|drop)\s+([0-9a-f]{4,40})\b/i.exec(line);
  return match ? { action: match[1].toLowerCase(), hash: match[2] } : undefined;
}

/** UI item 의 메시지를 Git editor 에 전달할 값으로 정규화한다. */
function messageForItem(item: RebaseItem | undefined): string | null {
  const message = item?.message?.trim();
  return message ? item!.message! : null;
}

/** 해시로 UI item 을 찾아 메시지 값을 반환한다. */
function messageForHash(items: RebaseItem[], hash: string): string | null {
  return messageForItem(items.find((item) => sameHash(item.hash, hash)));
}

/** 축약/전체 해시를 같은 커밋으로 비교한다. */
function sameHash(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/** 저장할 상태 객체를 만든다. */
async function stateFor(
  repoRoot: string,
  editorScript: string,
  nodePath: string
): Promise<RebaseMessageQueueState> {
  return {
    version: 1,
    queuePath: await gitPath(repoRoot, QUEUE_REL),
    editorScript,
    nodePath,
  };
}

/** 메시지 큐 파일을 쓴다. */
async function writeQueue(file: string, queue: (string | null)[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(queue), "utf8");
}

/** 상태 파일을 쓴다. */
async function writeState(repoRoot: string, state: RebaseMessageQueueState): Promise<void> {
  const file = await gitPath(repoRoot, STATE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state), "utf8");
}

/** 저장된 상태 파일을 읽는다. */
async function readState(repoRoot: string): Promise<RebaseMessageQueueState | undefined> {
  const file = await gitPath(repoRoot, STATE_REL);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }
  let value: Partial<RebaseMessageQueueState>;
  try {
    value = JSON.parse(raw) as Partial<RebaseMessageQueueState>;
  } catch {
    return undefined;
  }
  return value.version === 1 && value.queuePath && value.editorScript && value.nodePath
    ? value as RebaseMessageQueueState
    : undefined;
}

/** 저장된 상태를 git env 로 변환한다. */
function editorEnv(repoRoot: string, state: RebaseMessageQueueState): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    GIT_EDITOR: `"${state.nodePath}" "${state.editorScript}" msg`,
    GIT_SEQUENCE_EDITOR: "true",
    GSC_MSG_QUEUE: state.queuePath,
    GSC_REPO_ROOT: repoRoot,
  };
}

/** git metadata 상대 경로를 linked worktree 에서도 유효한 절대 경로로 변환한다. */
async function gitPath(repoRoot: string, rel: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", rel], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}
