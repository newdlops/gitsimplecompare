// 충돌 해결 화면에 필요한 operation/commit/rebase 문맥을 Git 상태에서 읽는다.
// - UI 문구를 만들지 않고 구조화된 사실만 반환해 webview와 일반 editor decoration이 재사용할 수 있다.
// - rebase의 전체 todo를 검사해 현재 Result가 이후 같은 파일 변경으로 다시 달라질 가능성을 표시한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MergeOperation } from "./conflictService";
import { runGit } from "./gitExec";

/** 충돌 문맥에서 표시할 commit/ref 식별 정보다. */
export interface ConflictCommitIdentity {
  ref: string;
  commit?: string;
  subject?: string;
}

/** 남은 rebase todo 중 현재 경로를 다시 변경하는 commit 정보다. */
export interface RebaseFuturePathChange extends ConflictCommitIdentity {
  action: string;
  index: number;
}

/** 현재 rebase todo 항목의 위치와 원본 commit 정보다. */
export interface RebaseConflictStep extends ConflictCommitIdentity {
  action?: string;
  index: number;
  total: number;
}

/** 현재 Result가 rebase 완료 시점까지 유지될 가능성을 나타낸다. */
export type RebaseFileOutcome =
  | "expected-final"
  | "changed-later"
  | "uncertain";

/** rebase 충돌에서 원래 branch와 현재/남은 todo를 설명하는 상세 문맥이다. */
export interface RebaseConflictContext {
  branch?: string;
  originalHead?: ConflictCommitIdentity;
  onto?: ConflictCommitIdentity;
  currentStep?: RebaseConflictStep;
  remainingSteps: number;
  pendingExecSteps: number;
  pendingComplexSteps: number;
  futurePathAnalysisComplete: boolean;
  futurePathChanges: RebaseFuturePathChange[];
  futurePathChangeCount: number;
  futurePathChangesOmitted: number;
  fileOutcome: RebaseFileOutcome;
}

/** merge/rebase/cherry-pick/revert 공통 operation 문맥이다. */
export interface ConflictOperationContext {
  operation: MergeOperation;
  branch?: string;
  operationTarget?: ConflictCommitIdentity;
  rebase?: RebaseConflictContext;
}

/** rebase 상태 파일에서 읽은 todo 한 줄의 구조화 결과다. */
interface RebaseTodoEntry {
  action: string;
  hash?: string;
  subject?: string;
  kind: "commit" | "exec" | "other";
}

/** rebase-merge/rebase-apply 디렉터리의 필요한 상태 스냅샷이다. */
interface RebaseStateSnapshot {
  backend: "rebase-merge" | "rebase-apply";
  hasDone: boolean;
  hasTodo: boolean;
  headName: string;
  originalHead: string;
  onto: string;
  stoppedSha: string;
  done: string;
  todo: string;
}

/** `git log --no-walk`에서 읽은 경로 변경 commit 정보다. */
interface PathTouchCommit {
  commit: string;
  subject?: string;
}

const COMMIT_ACTIONS = new Set([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
]);
const ACTION_ALIASES: Record<string, string> = {
  p: "pick",
  r: "reword",
  e: "edit",
  s: "squash",
  f: "fixup",
  d: "drop",
  x: "exec",
};
const MAX_VISIBLE_FUTURE_CHANGES = 6;
const MAX_HASHES_PER_QUERY = 64;
const LITERAL_PATH_ENV = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * 현재 Git operation과 충돌 파일을 바탕으로 해결 판단용 문맥을 읽는다.
 * - 일반 operation은 branch와 대상 commit을 제공하고, rebase는 todo 진행/향후 경로 영향까지 보강한다.
 * @param repoRoot 저장소 루트
 * @param operation 현재 감지된 Git operation
 * @param rel 충돌 파일의 저장소 상대 경로
 * @returns UI가 operation별 의미와 최종 반영 가능성을 설명할 구조화 문맥
 */
export async function readConflictOperationContext(
  repoRoot: string,
  operation: MergeOperation,
  rel: string
): Promise<ConflictOperationContext> {
  const targetRef = operationTargetRef(operation);
  const [branch, operationTarget] = await Promise.all([
    readCurrentBranch(repoRoot),
    targetRef ? describeCommit(repoRoot, targetRef) : Promise.resolve(undefined),
  ]);
  if (operation !== "rebase") {
    return { operation, branch, operationTarget };
  }
  const rebase = await readRebaseConflictContext(repoRoot, rel);
  return {
    operation,
    branch: rebase?.branch || branch,
    operationTarget,
    rebase,
  };
}

/**
 * 지정 ref에서 현재 경로 내용을 마지막으로 바꾼 commit을 찾는다.
 * - HEAD가 단지 누적 결과의 tip일 뿐인 rebase Current 쪽에서 실제 파일 출처를 별도로 보여주기 위해 사용한다.
 * @param repoRoot 저장소 루트
 * @param ref 파일 이력을 거슬러 올라갈 commit/ref
 * @param rel 저장소 상대 경로
 * @returns 마지막 변경 commit 또는 경로/참조를 해석할 수 없으면 undefined
 */
export async function describeFileSource(
  repoRoot: string,
  ref: string,
  rel: string
): Promise<ConflictCommitIdentity | undefined> {
  const output = await runGit(
    ["log", "-1", "-M", "--format=%H%x1f%s", ref, "--", rel],
    repoRoot,
    LITERAL_PATH_ENV
  ).catch(() => "");
  const line = output.split(/\r?\n/).find((entry) => entry.trim());
  if (!line) {
    return undefined;
  }
  const separator = line.indexOf("\x1f");
  const commit = (separator >= 0 ? line.slice(0, separator) : line).trim();
  const subject = separator >= 0 ? line.slice(separator + 1).trim() : "";
  return commit
    ? { ref, commit, subject: subject || undefined }
    : undefined;
}

/**
 * 진행 중인 rebase의 branch/기준점/todo와 이후 동일 경로 변경을 읽는다.
 * @param repoRoot 저장소 루트
 * @param rel 현재 충돌 경로
 * @returns rebase 상태 디렉터리를 찾았으면 상세 문맥, 아니면 undefined
 */
async function readRebaseConflictContext(
  repoRoot: string,
  rel: string
): Promise<RebaseConflictContext | undefined> {
  const state = await readRebaseState(repoRoot);
  if (!state) {
    return undefined;
  }
  const doneEntries = parseTodo(state.done);
  const done = doneEntries.filter((entry) => entry.kind === "commit");
  const todo = parseTodo(state.todo);
  const doneSteps = doneEntries.filter(countsAsSequenceStep);
  const todoSteps = todo.filter(countsAsSequenceStep);
  let sequenceIndex = doneSteps.length;
  const remainingCommits = todo.flatMap((entry) => {
    if (countsAsSequenceStep(entry)) sequenceIndex++;
    return entry.kind === "commit" && entry.action !== "drop" && entry.hash
      ? [{ entry, sequenceIndex }]
      : [];
  });
  const pendingExecSteps = todo.filter((entry) => entry.kind === "exec").length;
  const pendingComplexSteps = todo.filter((entry) =>
    (entry.kind === "other" && entry.action !== "label") ||
    (entry.kind === "commit" && (entry.action === "edit" || !entry.hash))
  ).length;
  const currentHash = await resolveCommit(repoRoot, "REBASE_HEAD") || state.stoppedSha;
  const lastDone = doneEntries[doneEntries.length - 1];
  const currentCommit = findTodoCommit(done, currentHash) || done[done.length - 1];
  const current = lastDone?.kind === "commit" ? currentCommit : lastDone || currentCommit;
  const currentInstructionUncertain = Boolean(
    current && (current.kind !== "commit" || current.action === "edit" || !current.hash)
  );
  const total = doneSteps.length + todoSteps.length;
  const todoStateComplete = state.backend === "rebase-merge" && state.hasDone && state.hasTodo;
  const [touches, originalPathKnown] = await Promise.all([
    todoStateComplete
      ? commitsTouchingPath(repoRoot, rel, remainingCommits.map(({ entry }) => entry.hash!))
      : Promise.resolve(undefined),
    currentHash ? originalCommitUsesPath(repoRoot, currentHash, rel) : Promise.resolve(false),
  ]);
  const future = touches
    ? remainingCommits.flatMap(({ entry, sequenceIndex }) => {
        const touched = findTouch(touches, entry.hash!);
        return touched
          ? [{
              action: entry.action,
              index: sequenceIndex,
              ref: entry.hash!,
              commit: touched.commit,
              subject: touched.subject || entry.subject,
            }]
          : [];
      })
    : [];
  const futurePathChangeCount = future.length;
  const futurePathAnalysisComplete = Boolean(touches && todoStateComplete && originalPathKnown);
  const fileOutcome: RebaseFileOutcome = !futurePathAnalysisComplete ||
      currentInstructionUncertain || pendingExecSteps > 0 || pendingComplexSteps > 0
    ? "uncertain"
    : futurePathChangeCount > 0
      ? "changed-later"
      : "expected-final";
  const [originalHead, onto, currentIdentity] = await Promise.all([
    state.originalHead
      ? describeCommit(repoRoot, state.originalHead, "original branch tip")
      : Promise.resolve(undefined),
    state.onto
      ? describeCommit(repoRoot, state.onto, "onto")
      : Promise.resolve(undefined),
    currentHash
      ? describeCommit(repoRoot, currentHash, "REBASE_HEAD")
      : Promise.resolve(undefined),
  ]);
  return {
    branch: normalizeBranchName(state.headName),
    originalHead,
    onto,
    currentStep: current
      ? {
          action: current.action,
          index: Math.max(1, doneSteps.length),
          total: Math.max(total, doneSteps.length),
          ref: current.kind === "commit" ? "REBASE_HEAD" : current.action,
          commit: current.kind === "commit" ? currentHash || current.hash : undefined,
          subject: current.kind === "commit"
            ? current.subject || currentIdentity?.subject
            : current.subject,
        }
      : undefined,
    remainingSteps: remainingCommits.length,
    pendingExecSteps,
    pendingComplexSteps,
    futurePathAnalysisComplete,
    futurePathChanges: future.slice(0, MAX_VISIBLE_FUTURE_CHANGES),
    futurePathChangeCount,
    futurePathChangesOmitted: Math.max(
      0,
      futurePathChangeCount - MAX_VISIBLE_FUTURE_CHANGES
    ),
    fileOutcome,
  };
}

/**
 * linked worktree에서도 유효한 rebase 상태 디렉터리를 찾고 필요한 파일을 읽는다.
 * @param repoRoot 저장소 루트
 * @returns 첫 번째로 존재하는 rebase backend 상태 또는 undefined
 */
async function readRebaseState(
  repoRoot: string
): Promise<RebaseStateSnapshot | undefined> {
  for (const backend of ["rebase-merge", "rebase-apply"]) {
    const raw = await runGit(
      ["rev-parse", "--git-path", backend],
      repoRoot
    ).catch(() => "");
    if (!raw.trim()) {
      continue;
    }
    const directory = path.resolve(repoRoot, raw.trim());
    const exists = await fs.stat(directory).then((value) => value.isDirectory()).catch(() => false);
    if (!exists) {
      continue;
    }
    const [headName, originalHead, onto, stoppedSha, done, todo, hasDone, hasTodo] = await Promise.all([
      readStateFile(directory, "head-name"),
      readStateFile(directory, "orig-head"),
      readStateFile(directory, "onto"),
      readStateFile(directory, "stopped-sha"),
      readStateFile(directory, "done", false),
      readStateFile(directory, "git-rebase-todo", false),
      stateFileExists(directory, "done"),
      stateFileExists(directory, "git-rebase-todo"),
    ]);
    return {
      backend: backend as RebaseStateSnapshot["backend"],
      hasDone,
      hasTodo,
      headName,
      originalHead,
      onto,
      stoppedSha,
      done,
      todo,
    };
  }
  return undefined;
}

/**
 * rebase 상태 파일을 읽고 식별자 파일만 앞뒤 공백을 제거한다.
 * @param directory rebase backend 디렉터리
 * @param name 상태 파일 이름
 * @param trim true면 단일 식별자, false면 todo 원문으로 취급한다
 */
async function readStateFile(
  directory: string,
  name: string,
  trim = true
): Promise<string> {
  const raw = await fs.readFile(path.join(directory, name), "utf8").catch(() => "");
  return trim ? raw.trim() : raw;
}

/** rebase backend 상태 파일이 실제로 존재하는지 확인해 빈 todo와 미지원 backend를 구분한다. */
async function stateFileExists(directory: string, name: string): Promise<boolean> {
  return fs.stat(path.join(directory, name)).then((value) => value.isFile()).catch(() => false);
}

/**
 * done/git-rebase-todo 원문을 commit/exec/기타 항목으로 파싱한다.
 * @param raw rebase 상태 파일 원문
 * @returns 주석과 빈 줄을 제외한 todo 항목
 */
function parseTodo(raw: string): RebaseTodoEntry[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [rawAction = "", ...args] = line.split(/\s+/);
      const action = ACTION_ALIASES[rawAction.toLowerCase()] || rawAction.toLowerCase();
      const commitAction = COMMIT_ACTIONS.has(action);
      const optionOffset = action === "fixup" && ["-C", "-c"].includes(args[0]) ? 1 : 0;
      const hash = args[optionOffset];
      const subject = args.slice(optionOffset + 1);
      return {
        action,
        hash: commitAction && looksLikeHash(hash) ? hash : undefined,
        subject: commitAction ? subject.join(" ").trim() || undefined : undefined,
        kind: commitAction ? "commit" : action === "exec" ? "exec" : "other",
      };
    });
}

/** label처럼 상태만 이름 붙이는 줄을 제외하고 실제 sequencer 진행 단계인지 판별한다. */
function countsAsSequenceStep(entry: RebaseTodoEntry): boolean {
  return entry.action !== "label";
}

/**
 * 현재 REBASE_HEAD와 일치하는 done 항목을 찾는다.
 * @param entries 이미 처리 대상으로 꺼낸 todo commit들
 * @param hash 현재 원본 commit 전체/축약 해시
 */
function findTodoCommit(
  entries: RebaseTodoEntry[],
  hash: string | undefined
): RebaseTodoEntry | undefined {
  if (!hash) {
    return undefined;
  }
  return entries.find((entry) => hashMatches(entry.hash, hash));
}

/**
 * 남은 commit 목록에서 현재 경로를 변경하는 commit만 한정된 Git 호출로 찾는다.
 * @param repoRoot 저장소 루트
 * @param rel 검사할 현재 경로
 * @param hashes todo 순서의 commit 해시 목록
 * @returns 경로를 변경하는 commit들, 조회 실패 시 불확실성을 나타내는 undefined
 */
async function commitsTouchingPath(
  repoRoot: string,
  rel: string,
  hashes: string[]
): Promise<PathTouchCommit[] | undefined> {
  const result: PathTouchCommit[] = [];
  for (let start = 0; start < hashes.length; start += MAX_HASHES_PER_QUERY) {
    const chunk = hashes.slice(start, start + MAX_HASHES_PER_QUERY);
    const raw = await runGit(
      [
        "log",
        "--no-walk=unsorted",
        "-M",
        "--format=%x1e%H%x1f%s%x00",
        "-z",
        ...chunk,
        "--",
        rel,
      ],
      repoRoot,
      LITERAL_PATH_ENV
    ).catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    result.push(...parsePathTouchCommits(raw));
  }
  return result;
}

/**
 * 현재 충돌 경로가 원본 replay commit 또는 그 부모에도 존재하는지 확인한다.
 * - onto-side rename으로 Git이 원본 경로를 새 경로에 매핑한 경우 future path 분석을 단정하지 않는다.
 */
async function originalCommitUsesPath(
  repoRoot: string,
  commit: string,
  rel: string
): Promise<boolean> {
  for (const ref of [commit, `${commit}^`]) {
    const output = await runGit(
      ["ls-tree", "-z", "--name-only", ref, "--", rel],
      repoRoot,
      LITERAL_PATH_ENV
    ).catch(() => "");
    if (output.split("\0").includes(rel)) return true;
  }
  return false;
}

/**
 * NUL/record separator가 포함된 `git log` 출력을 commit 정보로 변환한다.
 * @param raw `--format=%x1e%H%x1f%s%x00 -z` 출력
 */
function parsePathTouchCommits(raw: string): PathTouchCommit[] {
  return raw.split("\x1e").flatMap((record) => {
    const clean = record.replace(/^[\0\r\n]+|[\0\r\n]+$/g, "");
    if (!clean) {
      return [];
    }
    const separator = clean.indexOf("\x1f");
    const commit = (separator >= 0 ? clean.slice(0, separator) : clean).trim();
    const subject = separator >= 0 ? clean.slice(separator + 1).trim() : "";
    return commit ? [{ commit, subject: subject || undefined }] : [];
  });
}

/** todo 축약 해시에 대응하는 실제 path 변경 commit을 찾는다. */
function findTouch(
  touches: PathTouchCommit[],
  hash: string
): PathTouchCommit | undefined {
  return touches.find((touch) => hashMatches(touch.commit, hash));
}

/** 두 전체/축약 commit 해시가 같은 객체를 가리키는지 확인한다. */
function hashMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && (left.startsWith(right) || right.startsWith(left)));
}

/** rebase todo의 두 번째 토큰이 commit 해시 형태인지 검사한다. */
function looksLikeHash(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{4,64}$/i.test(value));
}

/** operation별로 사용자가 이해해야 할 대상 commit ref를 반환한다. */
function operationTargetRef(operation: MergeOperation): string | undefined {
  if (operation === "merge") return "MERGE_HEAD";
  if (operation === "rebase") return "REBASE_HEAD";
  if (operation === "cherry-pick") return "CHERRY_PICK_HEAD";
  if (operation === "revert") return "REVERT_HEAD";
  return undefined;
}

/**
 * ref/hash를 전체 commit과 제목으로 설명한다.
 * @param repoRoot 저장소 루트
 * @param ref 해석할 ref 또는 hash
 * @param label UI에 보존할 의미 있는 ref 라벨
 */
async function describeCommit(
  repoRoot: string,
  ref: string,
  label = ref
): Promise<ConflictCommitIdentity | undefined> {
  const commit = await resolveCommit(repoRoot, ref);
  if (!commit) {
    return undefined;
  }
  const subject = (
    await runGit(["show", "-s", "--format=%s", commit], repoRoot).catch(() => "")
  ).trim();
  return { ref: label, commit, subject: subject || undefined };
}

/** ref/hash를 전체 commit hash로 정규화한다. */
async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  const output = await runGit(
    ["rev-parse", "--verify", `${ref}^{commit}`],
    repoRoot
  ).catch(() => "");
  return output.split(/\r?\n/).find(Boolean)?.trim() || undefined;
}

/** 현재 checkout branch를 읽고 rebase detached HEAD에서는 빈 값으로 둔다. */
async function readCurrentBranch(repoRoot: string): Promise<string | undefined> {
  const output = await runGit(["branch", "--show-current"], repoRoot).catch(() => "");
  return output.trim() || undefined;
}

/** rebase head-name의 refs/heads 접두사를 사용자용 branch 이름에서 제거한다. */
function normalizeBranchName(value: string): string | undefined {
  const branch = value.trim().replace(/^refs\/heads\//, "");
  return branch || undefined;
}
