// Git CLI를 실제 실행하는 단일 진입점. 소유 실행·바이트 수집은 공통 runner에 위임한다.
import { GitError } from "./gitError";
import { executeGitProcess } from "./gitProcessRunner";
export { GitError } from "./gitError";

/** 조회·쓰기 호출이 함께 사용하는 실행 옵션. 시간 제한은 검증된 조회에만 적용한다. */
export interface RunGitOptions {
  executable?: string;
  env?: Record<string, string>;
  retryOnLock?: boolean;
  beforeRetry?: () => Promise<void>;
  signal?: AbortSignal;
  /** stdout/stderr의 최대 바이트 수. 기본 128MiB다. */
  maxBuffer?: number;
  /** 조회 제한 시간(ms). 0이면 제한을 해제한다. */
  readTimeoutMs?: number;
  /** 내부 소유 registry에 등록된 private 상태 index에만 optional-lock 쓰기를 허용한다. */
  allowPrivateIndexWrites?: boolean;
}

/** 성공한 명령의 두 출력 스트림을 손실 없이 제공한다. */
export interface GitCommandOutput { stdout: string; stderr: string }
export type GitInput = string | Uint8Array;
export type GitExecutableResolver = (cwd: string) => string | undefined;
const LOCK_RETRY_DELAYS_MS = [250, 500, 900, 1400, 2000];
let executableResolver: GitExecutableResolver | undefined;

/** VS Code 의존성 없이 저장소별 실행 파일을 주입하고 자신의 등록만 해제한다. */
export function setGitExecutableResolver(resolver: GitExecutableResolver): () => void {
  executableResolver = resolver;
  return () => { if (executableResolver === resolver) executableResolver = undefined; };
}

/** 호출 override, 저장소 설정, PATH 순으로 셸 해석 없는 실행 파일을 결정한다. */
export function resolveGitExecutable(cwd: string, override?: string): string {
  return (override ?? executableResolver?.(cwd))?.trim() || "git";
}

/**
 * 조회 출력을 작은 Buffer 조각으로 소비하며 메모리에 전체 blob을 쌓지 않는다.
 * @param onData 동기 소비 함수. 오류/취소 뒤에는 다시 호출하지 않는다.
 * @param options 실행 환경·취소 신호·조회 제한 시간
 * @returns 실제 close 확인 뒤 완료. 소비가 부분 진행될 수 있으므로 자동 재시도하지 않는다.
 */
export async function runGitStream(args: string[], cwd: string, onData: (chunk: Buffer) => void, options: RunGitOptions = {}): Promise<void> {
  await executeGitProcess(resolveGitExecutable(cwd, options.executable), args, cwd, options, undefined, onData);
}

/**
 * 기존 command-scope Git 설정을 보존하며 새 override를 환경 뒤에 추가한다.
 * @param env 호출 환경. process.env나 입력 객체를 변경하지 않는다.
 * @param overrides 자식 Git에도 상속할 Git 설정 key/value
 * @returns 기존 설정 개수 뒤로 추가된 새 환경 객체
 */
export function withGitConfigOverrides<T extends Record<string, string>>(env: T, overrides: Readonly<Record<string, string>>): T & Record<string, string> {
  const result: Record<string, string> = { ...env };
  let index = gitConfigCount(env.GIT_CONFIG_COUNT);
  for (const [key, value] of Object.entries(overrides)) {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index}`] = value;
    index++;
  }
  result.GIT_CONFIG_COUNT = String(index);
  return result as T & Record<string, string>;
}

/** Git stdout을 UTF-8 문자열로 반환한다. env shortcut과 기존 lock 재시도 계약을 유지한다. */
export async function runGit(args: string[], cwd: string, options?: Record<string, string> | RunGitOptions): Promise<string> {
  return (await runGitDetailed(args, cwd, options)).stdout;
}

/** 경로 magic·wildcard를 해석하지 않게 하여 파일명을 문자 그대로 Git에 전달한다. */
export function runGitLiteralPaths(args: string[], cwd: string, options?: Record<string, string> | RunGitOptions): Promise<string> {
  return runGit(["--literal-pathspecs", ...args], cwd, options);
}

/**
 * 성공한 경우에도 stderr를 보존해 fsmonitor/hook 진단을 호출자가 관찰하게 한다.
 * @param options 추가 환경 또는 실행·취소·재시도 정책
 * @returns close 확인 뒤 두 UTF-8 출력 또는 원본 출력을 가진 GitError
 */
export async function runGitDetailed(args: string[], cwd: string, options?: Record<string, string> | RunGitOptions): Promise<GitCommandOutput> {
  const normalized = normalizeOptions(options);
  const executable = resolveGitExecutable(cwd, normalized.executable);
  return withGitRetry(args, normalized, () => runGitDetailedOnce(args, cwd, normalized, undefined, executable));
}

/** 원본 바이트를 공개 문자열 계약으로 바꾸며 단일 실행의 수명은 runner가 소유한다. */
async function runGitDetailedOnce(args: string[], cwd: string, options: RunGitOptions, input?: GitInput, executable = "git"): Promise<GitCommandOutput> {
  const output = await executeGitProcess(executable, args, cwd, options, input);
  return { stdout: output.stdout.toString("utf8"), stderr: output.stderr.toString("utf8") };
}

/** cat-file --batch 등 표준 입력을 끝까지 전달해야 하는 호출에서 동일한 수명·재시도 정책을 사용한다. */
export async function runGitWithInput(args: string[], cwd: string, input: GitInput, options?: Record<string, string> | RunGitOptions): Promise<string> {
  const normalized = normalizeOptions(options);
  const executable = resolveGitExecutable(cwd, normalized.executable);
  return (await withGitRetry(args, normalized, () => runGitDetailedOnce(args, cwd, normalized, input, executable))).stdout;
}

/** UTF-8 변환 없이 stdout 원본 바이트를 반환해 binary diff와 blob을 보존한다. */
export async function runGitBuffer(args: string[], cwd: string, options?: Record<string, string> | RunGitOptions): Promise<Buffer> {
  const normalized = normalizeOptions(options);
  const executable = resolveGitExecutable(cwd, normalized.executable);
  return withGitRetry(args, normalized, () => executeGitProcess(executable, args, cwd, normalized).then(output => output.stdout));
}

/**
 * 일시적인 자원·안전한 lock 실패만 재시도한다. 취소·시간 초과·부분 mutation은 재실행하지 않는다.
 * @param args 하위 명령과 전역 옵션을 포함한 실제 인자
 * @param options 취소 신호, beforeRetry, retryOnLock
 * @param run 단일 실제 Git 실행
 * @returns 성공 결과 또는 마지막 오류
 */
async function withGitRetry<T>(args: string[], options: RunGitOptions, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (error) {
      if (options.signal?.aborted || options.retryOnLock === false || !isRetryableGitError(error, args) || attempt >= LOCK_RETRY_DELAYS_MS.length) throw error;
      await sleep(LOCK_RETRY_DELAYS_MS[attempt], options.signal);
      await options.beforeRetry?.();
    }
  }
}

/** 옵션 키가 없는 기존 env shortcut도 그대로 지원한다. */
function normalizeOptions(options?: Record<string, string> | RunGitOptions): RunGitOptions {
  if (!options) return {};
  return ["env", "executable", "retryOnLock", "beforeRetry", "signal", "maxBuffer", "readTimeoutMs", "allowPrivateIndexWrites"].some(key => key in options)
    ? options as RunGitOptions : { env: options as Record<string, string> };
}

/** command-scope count를 검증해 잘못된 환경을 조기에 구분한다. */
function gitConfigCount(explicit: string | undefined): number {
  const raw = explicit ?? process.env.GIT_CONFIG_COUNT;
  if (raw === undefined || raw === "") return 0;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid GIT_CONFIG_COUNT: ${raw}`);
  return count;
}

/** 파일명/커밋 메시지가 아닌 stderr의 실제 lock 경합만 재시도 대상으로 판정한다. */
function isGitLockError(error: GitError): boolean {
  return /^(?:fatal|error): [^\r\n]*unable to create [^\r\n]*\.lock['"]?: File exists\.?\s*$/im.test(error.stderr);
}

/** EBADF·FD 고갈·spawn 자원 부족 또는 안전한 lock 경합을 구분한다. */
function isRetryableGitError(error: unknown, args: string[]): boolean {
  if (error instanceof GitError) return (isGitLockError(error) && isSafeLockRetry(args)) || isTransientSpawnError(error);
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  return isTransientSpawnError({ code });
}

/** 이미 hook/원격/ref를 일부 변경한 명령을 통째로 다시 실행하지 않는다. */
function isSafeLockRetry(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(value)) { index++; continue; }
    if (value.startsWith("-")) continue;
    return !["commit", "push", "pull", "merge", "rebase", "cherry-pick", "revert", "stash"].includes(value);
  }
  return false;
}

/** 실제 프로세스 시작 자원 오류만 허용하며 SIGKILL·취소·시간 제한은 재시도하지 않는다. */
function isTransientSpawnError(error: { code?: unknown }): boolean {
  return ["EBADF", "EMFILE", "ENFILE", "EAGAIN"].includes(String(error.code));
}

/** lock 대기 중 취소도 즉시 처리하고 timer/listener를 함께 해제한다. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    /** 취소된 호출을 새 Git 프로세스로 재실행하지 않는다. */
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new GitError("Git command cancelled during retry.", "")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
