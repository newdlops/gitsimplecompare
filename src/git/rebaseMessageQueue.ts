// interactive rebase 의 reword/squash 메시지 큐를 git metadata 아래에 보존하는 모듈.
// - rebase 시작 프로세스가 끝난 뒤 `git rebase --continue` 가 다시 실행되어도
//   같은 rebaseEditor.js msg 헬퍼가 남은 메시지를 적용할 수 있게 한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveGitStatePath } from "./gitStatePathScope";
import { readRebaseTodoProgress } from "./rebaseTodoProgress";
import type { RebaseItem } from "./rebaseService";
import { logInfo } from "../ui/outputLog";

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
  const file = await gitPath(repoRoot, STATE_REL);
  const state = stateFor(file, editorScript, nodePath);
  await writeQueue(state.queuePath, messagesForItems(items));
  await writeState(file, state);
  return editorEnv(repoRoot, state, file);
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
  const file = await gitPath(repoRoot, STATE_REL);
  const state = await readStateFile(file);
  if (!state) {
    return undefined;
  }
  let queueLength: number | undefined;
  if (items.length > 0) {
    const queue = await messagesForActiveTodo(repoRoot, items, options, path.dirname(path.dirname(file)));
    queueLength = queue.length;
    await writeQueue(state.queuePath, queue);
  }
  return { env: await editorEnv(repoRoot, state, file), queueLength };
}

/**
 * 저장된 rebase 메시지 editor 상태를 읽어 `git rebase --continue` env 로 반환한다.
 * - graph UI 가 아닌 Conflicts 뷰의 Continue 도 같은 메시지 큐를 사용할 수 있게 한다.
 * @param repoRoot 저장소 루트
 */
export async function rebaseContinueEditorEnv(
  repoRoot: string
): Promise<Record<string, string> | undefined> {
  const file = await gitPath(repoRoot, STATE_REL);
  const state = await readStateFile(file);
  return state ? editorEnv(repoRoot, state, file) : undefined;
}

/**
 * 완료/abort 된 rebase 의 메시지 큐 상태를 정리한다.
 * - 삭제 실패는 다음 rebase 시작 시 덮어써지므로 호출부 흐름을 막지 않는다.
 * @param repoRoot 저장소 루트
 */
export async function cleanupRebaseMessageQueue(repoRoot: string): Promise<void> {
  const file = await gitPath(repoRoot, STATE_REL);
  const state = await readStateFile(file);
  await Promise.all([
    state ? fs.rm(state.queuePath, { force: true }).catch(() => undefined) : undefined,
    fs.rm(file, { force: true }).catch(() => undefined),
  ]);
}

/** rebase 시작 시 전체 todo 항목에서 메시지 editor 호출 순서대로 큐를 만든다. */
function messagesForItems(items: RebaseItem[]): (string | null)[] {
  return items.filter((item) => MESSAGE_ACTIONS.has(item.action)).map(messageForItem);
}

/** 이번 호출에서 확인한 worktree 경로의 todo를 새로 읽어 남은 메시지 큐를 만든다. */
async function messagesForActiveTodo(
  repoRoot: string,
  items: RebaseItem[],
  options: RebaseMessageQueueOptions,
  gitDir: string
): Promise<(string | null)[]> {
  const todo = await readTodoCommitLines(gitDir);
  const progress = await readRebaseTodoProgress(repoRoot, gitDir).catch(() => undefined);
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

/** 이미 확인한 worktree의 git-rebase-todo에서 남은 commit action 줄만 새로 읽는다. */
async function readTodoCommitLines(gitDir: string): Promise<TodoCommitLine[]> {
  const todoPath = await findTodoPath(gitDir);
  if (!todoPath) {
    return [];
  }
  const raw = await fs.readFile(todoPath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).map(parseTodoCommitLine).filter((line): line is TodoCommitLine => Boolean(line));
}

/** 같은 조회에서 확인한 Git directory 아래에서 실제 todo 파일 경로를 찾는다. */
async function findTodoPath(gitDir: string): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const candidate = path.join(gitDir, dir, "git-rebase-todo");
    if (await fs.access(candidate).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  return undefined;
}

/** todo 한 줄에서 메시지 editor 대상이 될 수 있는 commit action 을 파싱한다. */
function parseTodoCommitLine(line: string): TodoCommitLine | undefined {
  const match = /^\s*(pick|reword|edit|squash|fixup|drop)\s+([0-9a-f]{4,64})\b/i.exec(line);
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

/** 이번 호출에서 해석한 상태 파일과 같은 worktree metadata 아래에 메시지 큐를 둔다. */
function stateFor(
  stateFile: string,
  editorScript: string,
  nodePath: string
): RebaseMessageQueueState {
  return {
    version: 1,
    queuePath: path.join(path.dirname(stateFile), path.basename(QUEUE_REL)),
    editorScript,
    nodePath,
  };
}

/** 메시지 큐 파일을 쓴다. */
async function writeQueue(file: string, queue: (string | null)[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(queue), "utf8");
}

/** 이미 해석한 상태 파일 경로에 새 큐의 실행 정보를 저장한다. */
async function writeState(file: string, state: RebaseMessageQueueState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state), "utf8");
}

/** 상태 내용은 캐시하지 않고 지정한 실제 파일에서 매번 읽어 새 큐나 삭제를 즉시 반영한다. */
async function readStateFile(file: string): Promise<RebaseMessageQueueState | undefined> {
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

/**
 * 현재 큐와 이번 호출에서 해석한 상태 파일로 editor 환경을 만든다.
 * - 사용자 메시지가 하나도 없는 큐는 Git 기본 메시지를 그대로 받아 helper 시작 비용을 줄인다.
 * - Git directory는 저장 상태나 큐 위치에서 재사용하지 않고 현재 worktree의 상태 파일에서 구한다.
 * @param repoRoot 이번 Git 작업의 저장소 루트
 * @param state 버전 1 형식의 저장된 helper 실행 정보
 * @param stateFile 이번 호출에서 새로 해석한 상태 파일의 절대 경로
 * @returns Start/Continue/Skip의 Git 프로세스에 전달할 환경 변수
 */
async function editorEnv(repoRoot: string, state: RebaseMessageQueueState, stateFile: string): Promise<Record<string, string>> {
  const nativeEditor = await hasOnlyDefaultMessages(state.queuePath);
  logInfo("rebase message editor selected", { repoRoot, editor: nativeEditor ? "native" : "queue" });
  return {
    ELECTRON_RUN_AS_NODE: "1",
    GIT_EDITOR: nativeEditor ? "true" : `"${state.nodePath}" "${state.editorScript}" msg`,
    GIT_SEQUENCE_EDITOR: "true",
    GSC_MSG_QUEUE: state.queuePath,
    GSC_REPO_ROOT: repoRoot,
    GSC_REBASE_GIT_DIR: path.dirname(path.dirname(stateFile)),
  };
}

/**
 * 실제 큐가 null 항목만 가진 배열인지 매번 확인해 중간 정지 뒤 새 메시지를 즉시 반영한다.
 * @param file 현재 상태가 가리키는 메시지 큐 파일
 * @returns 빈 배열을 포함해 전부 null이면 true. 파일/JSON/타입이 불명확하면 기존 helper를 유지한다.
 */
async function hasOnlyDefaultMessages(file: string): Promise<boolean> {
  try {
    const queue: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(queue) && queue.every(message => message === null);
  } catch {
    return false;
  }
}

/** private 경로만 Start 실행 범위에서 공유한다. 범위 밖 Continue/정리는 Git으로 매번 새로 해석한다. */
async function gitPath(repoRoot: string, rel: string): Promise<string> {
  return resolveGitStatePath(repoRoot, rel);
}
