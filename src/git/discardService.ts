// 선택 변경 버리기의 분류·충돌 복원·미추적 삭제를 UI와 분리한다. HEAD/ref를 이동하거나 Git 작업을 abort하지 않는다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { runGitWithPaths } from "./pathspecExec";
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { logInfo } from "../ui/outputLog";

/** 확인창이 승인한 파일 분류와 충돌 작업 기준이다. 다른 호출·저장소의 계획은 재사용하지 않는다. */
export interface DiscardPlan {
  readonly repoRoot: string;
  readonly paths: readonly string[];
  readonly untracked: readonly string[];
  readonly conflicted: readonly string[];
  readonly conflictEntries: string;
  readonly operation?: GitOperationIdentity;
}
interface Selection { untracked: string[]; conflicted: string[]; conflictEntries: string; scoped: boolean; }

/** 확인 이후 추적/충돌 구분이 바뀌었을 때 어떤 파일도 먼저 삭제하지 않고 재확인을 요구한다. */
export class DiscardSelectionChangedError extends Error {
  /** UI에서 번역 가능한 고정 의미를 유지하면서 OUTPUT에도 원인을 남긴다. */
  constructor() { super("The selected files changed before discard. Review the changes and discard again."); this.name = "DiscardSelectionChangedError"; }
}

/**
 * 선택 경로의 충돌/미추적 상태를 읽어 확인창용 계획을 만든다.
 * @param repoRoot 대상 저장소 @param paths 버릴 상대 파일 경로. 중복은 합치며 외부 경로는 거부한다.
 * @returns 불변 계획. 충돌이 있으면 현재 HEAD와 native 작업 세대도 고정한다.
 */
export async function prepareDiscard(repoRoot: string, paths: readonly string[]): Promise<DiscardPlan> {
  const selected = normalizePaths(repoRoot, paths);
  const state = await readSelection(repoRoot, selected);
  const operation = state.conflicted.length ? Object.freeze(await captureGitOperation(repoRoot)) : undefined;
  return Object.freeze({ repoRoot: path.resolve(repoRoot), paths: Object.freeze(selected),
    untracked: Object.freeze(state.untracked), conflicted: Object.freeze(state.conflicted), conflictEntries: state.conflictEntries, operation });
}

/**
 * 일반 파일은 index에서, 승인한 충돌 파일은 고정한 HEAD에서 index/작업트리 모두 복원한다.
 * @param repoRoot 대상 저장소 @param paths 버릴 경로 @param confirmed 확인창 전에 읽은 계획. 없으면 즉시 새 계획을 만든다.
 * @returns 모든 시작한 쓰기/삭제가 끝난 뒤 완료한다. index·작업 세대 변경은 쓰기 전에 거부한다.
 */
export async function discardSelectedChanges(repoRoot: string, paths: readonly string[], confirmed?: DiscardPlan): Promise<void> {
  const started = Date.now(), selected = normalizePaths(repoRoot, paths);
  if (!selected.length) return;
  const plan = confirmed ?? await prepareDiscard(repoRoot, selected);
  if (plan.repoRoot !== path.resolve(repoRoot) || JSON.stringify(plan.paths) !== JSON.stringify(selected)) throw new DiscardSelectionChangedError();
  if (confirmed || plan.operation) assertSameSelection(plan, await readSelection(repoRoot, selected));
  if (plan.operation) await assertGitOperation(repoRoot, plan.operation);
  const conflicts = new Set(plan.conflicted), untracked = new Set(plan.untracked);
  const tracked = selected.filter(file => !conflicts.has(file) && !untracked.has(file));
  // 충돌 복원만 index를 HEAD로 확정한다. 일반 경로에 staged 변경이 있어도 index 내용은 덮지 않는다.
  if (plan.operation && plan.conflicted.length) {
    await restoreConflicts(repoRoot, plan);
  }
  await runGitWithPaths(["--literal-pathspecs", "checkout"], tracked, repoRoot, { beforeRetry: async () => {
    if ((await readSelection(repoRoot, tracked)).conflicted.length) throw new DiscardSelectionChangedError();
    if (plan.operation) await assertGitOperation(repoRoot, plan.operation);
  } });
  if (plan.untracked.length) {
    // 앞선 Native 쓰기를 기다리는 동안 새로 stage된 파일을 오래된 미추적 목록으로 삭제하지 않는다.
    if (tracked.length || plan.conflicted.length) {
      const current = await readSelection(repoRoot, plan.untracked);
      if (current.conflicted.length || JSON.stringify(current.untracked) !== JSON.stringify(plan.untracked)) throw new DiscardSelectionChangedError();
    }
    await removeUntracked(repoRoot, plan.untracked);
  }
  logInfo("discard completed", { repoRoot, selected: selected.length, tracked: tracked.length,
    conflicted: plan.conflicted.length, untracked: plan.untracked.length, elapsedMs: Date.now() - started });
}

/**
 * stage 1~3과 미추적 파일만 읽는다. 작은 선택은 pathspec으로 제한하고 bulk도 조회 한 번으로 끝낸다.
 * - -t의 고정 tag를 사용해 index처럼 생긴 미추적 이름, tab/개행 경로를 구분한다.
 * @param repoRoot 저장소 @param selected 정규화한 파일 경로 @returns 선택한 파일의 분류와 전체 conflict tuple
 */
async function readSelection(repoRoot: string, selected: readonly string[]): Promise<Selection> {
  if (!selected.length) return { untracked: [], conflicted: [], conflictEntries: "", scoped: true };
  const scoped = selected.length <= 100 && selected.reduce((sum,file) => sum + Buffer.byteLength(file) + 1, 0) <= 8 * 1024;
  const raw = await runGit(["-c", "core.fsmonitor=false", "--literal-pathspecs", "ls-files", "--unmerged", "--others", "--exclude-standard", "-t", "-z",
    ...(scoped ? ["--", ...selected] : [])], repoRoot);
  if (raw && !raw.endsWith("\0")) throw new Error("Incomplete index data while preparing discard.");
  const wanted = new Set(selected), untracked = new Set<string>(), conflicted = new Set<string>(), entries: string[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf("\0", offset), row = raw.slice(offset, end); offset = end + 1;
    if (row.startsWith("? ")) { const file = row.slice(2); if (wanted.has(file)) untracked.add(file); continue; }
    const match = /^[A-Z] ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("Invalid unmerged index data while preparing discard.");
    if (wanted.has(match[4])) { conflicted.add(match[4]); entries.push(row); }
  }
  return { untracked: selected.filter(file => untracked.has(file)), conflicted: selected.filter(file => conflicted.has(file)), conflictEntries: entries.sort().join("\0"), scoped };
}

/** 확인한 파일의 추적 여부·충돌 blob이 달라지면 기존 계획 전체를 실행하지 않는다. */
function assertSameSelection(plan: DiscardPlan, current: Selection): void {
  if (JSON.stringify(plan.untracked) !== JSON.stringify(current.untracked) ||
      JSON.stringify(plan.conflicted) !== JSON.stringify(current.conflicted) || plan.conflictEntries !== current.conflictEntries) throw new DiscardSelectionChangedError();
}

/** 저장소 밖 또는 metadata 자체를 대상으로 하는 입력을 거부하고 literal Git 경로로 정규화한다. */
function normalizePaths(repoRoot: string, paths: readonly string[]): string[] {
  const root = path.resolve(repoRoot), result = new Set<string>();
  for (const file of paths) {
    const relative = path.relative(root, path.resolve(root, file));
    if (!file || file.includes("\0") || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        relative.split(path.sep)[0].toLowerCase() === ".git") throw new Error("Invalid discard path: files must be inside the selected repository.");
    result.add(relative.split(path.sep).join("/"));
  }
  return [...result];
}

/**
 * HEAD에 없는 modify/delete 충돌은 rm으로 해소하고, 나머지는 같은 OID의 내용으로 복원한다.
 * @param repoRoot 저장소 @param plan 사용자가 승인하고 재검증한 충돌 계획
 * @returns Native restore가 absent-HEAD unmerged 경로를 거부하는 경우에도 삭제 의미를 정확히 적용한다.
 */
async function restoreConflicts(repoRoot: string, plan: DiscardPlan): Promise<void> {
  const selected = new Set(plan.conflicted), scoped = plan.conflicted.length <= 100 && plan.conflicted.join("\0").length <= 8192;
  const output = await runGit(["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", plan.operation!.head,
    ...(scoped ? ["--", ...plan.conflicted] : [])], repoRoot);
  const present = new Set(output.split("\0").filter(file => selected.has(file)));
  const restoring = plan.conflicted.filter(file => present.has(file)), deleting = plan.conflicted.filter(file => !present.has(file));
  /** 재시도하는 부분 집합만 원래 stage tuple과 대조해 앞서 정상 처리한 경로를 변경으로 오인하지 않는다. */
  const guard = (files: readonly string[]) => async () => {
    const wanted = new Set(files), current = await readSelection(repoRoot, files);
    const entries = plan.conflictEntries.split("\0").filter(row => wanted.has(row.slice(row.indexOf("\t") + 1))).sort().join("\0");
    if (current.untracked.length || JSON.stringify(current.conflicted) !== JSON.stringify(files) || current.conflictEntries !== entries) throw new DiscardSelectionChangedError();
    await assertGitOperation(repoRoot, plan.operation!);
  };
  if (restoring.length) {
    await guard(restoring)();
    await runGitWithPaths(["--literal-pathspecs", "restore", `--source=${plan.operation!.head}`, "--staged", "--worktree"], restoring, repoRoot, { beforeRetry: guard(restoring) });
  }
  if (deleting.length) {
    await guard(deleting)();
    await runGitWithPaths(["--literal-pathspecs", "rm", "-f"], deleting, repoRoot, { beforeRetry: guard(deleting) });
  }
}

/**
 * 선택 미추적 파일만 최대 8개씩 삭제하고 오류 뒤에는 새 삭제를 시작하지 않는다.
 * @param repoRoot 저장소 @param files 확인한 미추적 파일 @returns 모든 시작한 IO를 회수한 뒤 첫 오류를 전파한다.
 */
async function removeUntracked(repoRoot: string, files: readonly string[]): Promise<void> {
  const root = await fs.realpath(repoRoot);
  let next = 0, failure: unknown;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length && failure === undefined) {
      const file = path.resolve(repoRoot, files[next++]);
      try {
        const parent = await fs.realpath(path.dirname(file)), relative = path.relative(root, parent);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Untracked path moved outside the selected repository.");
        await fs.unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      } catch (error) { failure ??= error; }
    }
  });
  await Promise.allSettled(workers);
  if (failure !== undefined) throw failure;
}
