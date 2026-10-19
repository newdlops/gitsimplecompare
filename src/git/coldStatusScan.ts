import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { GitError, runGit, withGitConfigOverrides, type RunGitOptions } from "./gitExec";
import { resolveGitReadTimeout } from "./gitProcessRunner";
import { parseWorkingTreeV2, type ParsedWorkingTree } from "./workingTreeStatusFormat";
import { PriorityReadQueue } from "../utils/priorityReadQueue";

export const COLD_STATUS_MIN_ENTRIES = 5000;
const queue = new PriorityReadQueue(4);
const MAX_BATCH_BYTES = 16000, TARGET_BATCHES = 16;
type Logger = (event: string, fields: Record<string, unknown>) => void;
interface Scope { path: string; directory: boolean; weight: number }
interface DirectoryFence { file: string; identity: string }

/**
 * 첫 탐색과 후속 캐시 준비가 합계 네 개를 넘지 않게 실제 Git 실행 슬롯을 공유한다.
 * @param args 조회 전용 Git 인자 @param root 저장소 루트
 * @param options 소유 index와 취소 신호. 실제 실행·close는 공통 실행기가 관리한다.
 * @param priority 사용자 조회는 0, 선택적인 캐시 준비는 더 큰 값을 사용한다.
 * @returns 실제 프로세스 close 뒤의 stdout
 */
export function runColdStatusRead(args: string[], root: string, options: RunGitOptions & { signal: AbortSignal }, priority = 0): Promise<string> {
  return queue.run(() => runGit(args, root, options), options.signal, () => priority);
}

/**
 * 큰 저장소의 캐시 없는 첫 조회를 추적 파일 상태와 범위별 미추적 열거로 나눈다.
 * - Git이 ignore·nested repository·파일명 규칙을 판단하며 모든 파일을 반환한다.
 * - 원본 index는 읽기만 하고 확장 소유 index도 이 경로에서는 쓰지 않는다.
 * - 범위 구성 중 디렉터리 항목이 바뀌면 결과를 폐기해 기존 단일 Git 조회로 복구한다.
 * @param root 실제 작업트리 루트 @param env 등록된 전용 index를 지정한 환경
 * @param signal 사용자 조회의 취소 신호 @param log OUTPUT 상태 전환 함수
 * @returns 완전한 porcelain 의미. 안전한 범위 구성이 불가능하면 undefined
 */
export async function readColdStatus(root: string, env: Record<string, string>, signal: AbortSignal, log: Logger): Promise<ParsedWorkingTree | undefined> {
  signal.throwIfAborted();
  const started = Date.now(), controller = new AbortController();
  const emit: Logger = (event, fields) => { try { log(event, fields); } catch { /* 관찰 실패는 Git 결과를 바꾸지 않는다. */ } };
  const timeout = resolveGitReadTimeout(root);
  const options = { env: withGitConfigOverrides(env, { "core.untrackedCache": "false", "core.fsmonitor": "false" }), signal: controller.signal };
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const pending: Promise<string>[] = [];
  let failure: { error: unknown } | undefined;
  let timeoutError: GitError | undefined;
  const timer = Number.isFinite(timeout) && timeout > 0 ? setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutError = new GitError("Git read exceeded its time limit. See Git Simple Compare Output.", "", "",
      Object.assign(new Error("Git status scan timed out."), { code: "ETIMEDOUT", killed: true }));
    emit("private status cold scan timed out", { repoRoot: root, elapsedMs: Date.now() - started, timeoutMs: timeout });
    controller.abort(timeoutError);
  }, timeout) : undefined;
  timer?.unref();
  /** 첫 Git 실패를 보존하고 peer 조회와 대기 중 실행을 함께 중단한다. */
  const execute = (args: string[]) => {
    const promise = runColdStatusRead(args, root, options).catch(error => {
      failure ??= { error }; controller.abort(); throw error;
    });
    pending.push(promise); void promise.catch(() => undefined); return promise;
  };
  try {
    const tracked = execute(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=no"]);
    const files = await execute(["ls-files", "--cached", "-z"]);
    const plan = await awaitStatusRead(planScopes(root, files, controller.signal), controller.signal);
    if (!plan) return undefined;
    const batches = scopeBatches(plan.scopes);
    const outputs = await Promise.all(batches.map(batch => execute([
      "--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...batch,
    ])));
    const parsed = parseWorkingTreeV2(await tracked);
    controller.signal.throwIfAborted();
    const valid = await awaitStatusRead(Promise.all(plan.fences.map(async fence => directoryIdentity(fence.file).then(value => value === fence.identity, () => false))), controller.signal);
    controller.signal.throwIfAborted();
    if (valid.some(value => !value)) {
      emit("private status cold scan discarded", { repoRoot: root, reason: "directory-changed-during-read" }); return undefined;
    }
    const untracked = [...new Set(outputs.flatMap(output => output.split("\0").filter(Boolean)))];
    untracked.sort((one, two) => Buffer.compare(Buffer.from(one), Buffer.from(two)));
    parsed.entries.push(...untracked.map(file => ({ xy: "??", path: file })));
    emit("private status cold scan completed", { repoRoot: root, scopes: plan.scopes.length, batches: batches.length,
      untracked: untracked.length, elapsedMs: Date.now() - started });
    return parsed;
  } catch (error) {
    if (timeoutError) throw timeoutError;
    if (signal.aborted || failure) throw failure?.error ?? error;
    emit("private status cold scan bypassed", { repoRoot: root, reason: error instanceof Error ? error.name : "scope-unavailable" });
    return undefined;
  } finally {
    clearTimeout(timer); controller.abort(); await Promise.allSettled(pending);
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * 추적 파일이 몰린 디렉터리만 분할해 한 큰 src 폴더가 모든 슬롯을 붙잡지 않게 한다.
 * @param tracked NUL로 구분한 실제 index 경로. ignore 해석은 이후 Git 조회에 위임한다.
 * @returns 서로 겹치지 않는 전체 범위와 범위를 구성한 디렉터리의 변경 검증 정보
 */
async function planScopes(root: string, tracked: string, signal: AbortSignal): Promise<{ scopes: Scope[]; fences: DirectoryFence[] } | undefined> {
  const counts = new Map<string, number>(), fences: DirectoryFence[] = [];
  for (const file of tracked.split("\0")) {
    for (let offset = file.indexOf("/"); offset >= 0; offset = file.indexOf("/", offset + 1)) {
      const prefix = file.slice(0, offset); counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  /** 범위의 parent를 실제로 읽고 byte 경로 손실이나 동시 항목 변경을 거부한다. */
  const children = async (relative: string) => {
    signal.throwIfAborted();
    const file = path.join(root, relative), before = await directoryIdentity(file);
    signal.throwIfAborted();
    const entries = await readdir(file, { withFileTypes: true });
    signal.throwIfAborted();
    if (before !== await directoryIdentity(file) || entries.some(entry => entry.name.includes("\ufffd"))) return undefined;
    signal.throwIfAborted();
    fences.push({ file, identity: before });
    return entries;
  };
  const top = await children("");
  if (!top) return undefined;
  let scopes: Scope[] = top.filter(entry => entry.name !== ".git").map(entry => ({ path: entry.name, directory: entry.isDirectory(), weight: counts.get(entry.name) || 1 }));
  for (let attempt = 0; attempt < 24; attempt++) {
    signal.throwIfAborted();
    const biggest = scopes.filter(scope => scope.directory && scope.weight > 500).sort((one, two) => two.weight - one.weight)[0];
    if (!biggest || (scopes.length >= TARGET_BATCHES && biggest.weight < 6000) || scopes.length > 4096) break;
    const entries = await children(biggest.path);
    if (!entries) return undefined;
    // nested Git 경계는 Git 자신이 한 범위로 처리해야 내부 파일이 잘못 노출되지 않는다.
    if (entries.some(entry => entry.name === ".git")) { biggest.directory = false; continue; }
    scopes = scopes.filter(scope => scope !== biggest).concat(entries.map(entry => {
      const file = `${biggest.path}/${entry.name}`;
      return { path: file, directory: entry.isDirectory(), weight: counts.get(file) || 1 };
    }));
  }
  return { scopes, fences };
}

/** UTF-8 인자 길이 상한을 지키면서 추적 파일 수 기준으로 열여섯 묶음에 작업을 분산한다. */
function scopeBatches(scopes: Scope[]): string[][] {
  const buckets = Array.from({ length: TARGET_BATCHES }, () => ({ paths: [] as string[], weight: 0 }));
  for (const scope of scopes.sort((one, two) => two.weight - one.weight)) {
    const bucket = buckets.reduce((one, two) => one.weight <= two.weight ? one : two);
    bucket.paths.push(scope.path); bucket.weight += scope.weight;
  }
  const batches: string[][] = [];
  for (const bucket of buckets) {
    let batch: string[] = [], bytes = 0;
    for (const file of bucket.paths) {
      const length = Buffer.byteLength(file) + 1;
      if (batch.length && bytes + length > MAX_BATCH_BYTES) { batches.push(batch); batch = []; bytes = 0; }
      batch.push(file); bytes += length;
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

/** 디렉터리 교체·이름 추가/삭제를 나노초 mtime/ctime으로 비교하고 파일 내용 변경과 구분한다. */
async function directoryIdentity(file: string): Promise<string> {
  const info = await lstat(file, { bigint: true });
  if (!info.isDirectory()) throw new Error("Status scope is no longer a directory.");
  return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** 읽기 전용 파일 시스템 호출이 늦어져도 취소 후 결과를 기다리거나 다음 탐색으로 진행하지 않는다. */
export function awaitStatusRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
