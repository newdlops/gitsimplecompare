// git CLI 를 실제로 실행하는 저수준 래퍼 모듈.
// - 여러 git 서비스(GitService, GitLogService 등)가 공유하는 단일 실행 지점이다.
//   execFile 로 셸을 거치지 않아 인자 이스케이프 문제가 없다.
import { execFile, spawn, type ExecFileException } from "node:child_process";

/** git 명령 실행 중 발생한 오류를 식별하기 위한 전용 에러 타입 */
export class GitError extends Error {
  /** Git 종료 코드 또는 ENOENT/EAGAIN 같은 프로세스 실행 오류 코드다. */
  readonly code?: number | string;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;

  /** 원래 실행 오류와 출력 스트림을 보존해 호출부가 실패 원인을 구분하게 한다. */
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly stdout = "",
    cause?: ExecFileException
  ) {
    super(message, { cause });
    this.name = "GitError";
    this.code = cause?.code ?? undefined;
    this.signal = cause?.signal;
    this.killed = cause?.killed;
  }
}

export interface RunGitOptions {
  env?: Record<string, string>;
  retryOnLock?: boolean;
  beforeRetry?: () => Promise<void>;
  /** 호출 취소 시 실행 중인 git 프로세스도 종료할 신호다. */
  signal?: AbortSignal;
}

/** 성공한 Git 명령의 stdout/stderr를 손실 없이 함께 반환하는 결과다. */
export interface GitCommandOutput {
  /** Git 프로세스가 표준 출력에 기록한 전체 UTF-8 문자열 */
  stdout: string;
  /** Git 또는 hook이 표준 오류에 기록한 전체 UTF-8 문자열 */
  stderr: string;
}

/** Git stdin으로 전달할 수 있는 UTF-8 문자열 또는 원본 바이트 입력이다. */
export type GitInput = string | Uint8Array;

const LOCK_RETRY_DELAYS_MS = [250, 500, 900, 1400, 2000];
const MAX_GIT_BUFFER_BYTES = 128 * 1024 * 1024;

/**
 * 조회 전용 Git 출력을 작은 Buffer 조각으로 소비해 큰 blob 전체를 메모리에 쌓지 않는다.
 * - callback의 누적 상태를 중복 처리하지 않도록 자동 재시도하지 않는다.
 * - 취소/소비 오류 시 자식 프로세스를 종료하고 close 뒤에만 완료해 실행 슬롯을 정확히 반환한다.
 * @param onData 출력 조각을 동기적으로 소비하는 함수. Buffer를 보존할 때 필요한 부분만 복사한다.
 * @param options 조회 환경과 호출 수명에 연결된 취소 신호
 */
export function runGitStream(
  args: string[], cwd: string, onData: (chunk: Buffer) => void, options: RunGitOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : undefined });
    let stderr = Buffer.alloc(0), failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    /** 종료 요청 뒤에도 남는 프로세스는 강제 종료하고 close에서 리스너/타이머를 정리한다. */
    const stop = () => {
      child.kill();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => { failure = options.signal?.reason ?? new DOMException("Git read cancelled.", "AbortError"); stop(); };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try { onData(chunk); } catch (error) { failure = error; stop(); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr = Buffer.concat([stderr, chunk.subarray(0, 64 * 1024 - stderr.length)]);
    });
    child.on("error", error => { failure ??= new GitError(`git ${args[0]} failed: ${error.message}`, stderr.toString("utf8"), "", error as ExecFileException); });
    child.stdout.on("error", error => { failure ??= error; stop(); });
    child.stderr.on("error", error => { failure ??= error; stop(); });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitError(`git ${args[0]} failed (${code ?? signal})`, stderr.toString("utf8"), "",
        Object.assign(new Error("Git stream failed."), { code: code ?? undefined, signal: signal ?? undefined })));
      else resolve();
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

/**
 * 기존 Git command-scope 설정을 보존하면서 새 `-c key=value` 상당 override를 환경에 덧붙인다.
 * - `GIT_CONFIG_COUNT/KEY_n/VALUE_n`은 hook을 포함한 자식 Git 프로세스에도 상속되므로,
 *   임시 index/private GIT_DIR처럼 모든 중첩 Git 호출에 같은 안전 설정이 필요한 흐름에서 사용한다.
 * - process 환경이나 호출자가 이미 주입한 command-scope 항목 뒤에 추가해 기존 설정을 덮어 없애지 않는다.
 * @param env runGit에 전달할 기존 환경 변수
 * @param overrides 가장 높은 command scope에 순서대로 추가할 Git 설정 key/value
 * @returns 기존 환경과 Git 설정 override가 합쳐진 새 객체
 */
export function withGitConfigOverrides<T extends Record<string, string>>(
  env: T,
  overrides: Readonly<Record<string, string>>
): T & Record<string, string> {
  const inheritedCount = gitConfigCount(env.GIT_CONFIG_COUNT);
  const result: Record<string, string> = { ...env };
  let index = inheritedCount;
  for (const [key, value] of Object.entries(overrides)) {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index}`] = value;
    index++;
  }
  result.GIT_CONFIG_COUNT = String(index);
  return result as T & Record<string, string>;
}

/**
 * git 명령을 실행하고 표준 출력을 문자열로 반환한다.
 * - 대용량 출력(git show / git log 전체)도 받을 수 있도록 버퍼 한도를 넉넉히 둔다.
 * - 실패 시 GitError 로 감싸 던진다(호출부가 종류를 구분할 수 있게).
 * - env 를 주면 기존 환경에 덮어써 실행한다(예: GIT_EDITOR=true 로 에디터 우회).
 * @param args git 인자 배열
 * @param cwd  실행 디렉터리(저장소 경로)
 * @param options 추가 env 또는 lock 재시도 옵션
 */
export async function runGit(
  args: string[],
  cwd: string,
  options?: Record<string, string> | RunGitOptions
): Promise<string> {
  return (await runGitDetailed(args, cwd, options)).stdout;
}

/**
 * 파일명을 pathspec 패턴이나 magic으로 확장하지 않고 Git 명령을 실행한다.
 * @param args 하위 명령과 경로를 포함하는 인자 배열
 * @param cwd Git 명령의 작업 디렉터리
 * @param options 실행 환경, 취소 신호, lock 재시도 정책
 * @returns 경로를 문자 그대로 처리한 명령의 표준 출력
 */
export function runGitLiteralPaths(
  args: string[],
  cwd: string,
  options?: Record<string, string> | RunGitOptions
): Promise<string> {
  return runGit(["--literal-pathspecs", ...args], cwd, options);
}

/**
 * git 명령을 실행하고 성공한 경우에도 stdout과 stderr를 모두 반환한다.
 * - 일반 조회는 stdout만 필요한 `runGit`을 사용하고, 성공 로그까지 보존해야 하는 hook/외부 도구 실행은
 *   이 함수를 사용해 stderr 진행 출력도 OUTPUT 채널에 남긴다.
 * - 실패 시에는 `runGit`과 동일한 GitError와 lock 재시도 정책을 사용한다.
 * @param args git 인자 배열
 * @param cwd 실행 디렉터리(저장소 경로)
 * @param options 추가 env 또는 lock 재시도 옵션
 * @returns 성공한 프로세스의 stdout/stderr 전체 문자열
 */
export async function runGitDetailed(
  args: string[],
  cwd: string,
  options?: Record<string, string> | RunGitOptions
): Promise<GitCommandOutput> {
  const normalized = normalizeOptions(options);
  return withGitRetry(args, normalized, () =>
    runGitDetailedOnce(args, cwd, normalized.env, normalized.signal)
  );
}

/**
 * stdout/stderr를 모두 보존하는 git 프로세스를 한 번 실행한다.
 * - 재시도 여부는 공개 `runGitDetailed`이 결정하며 이 함수는 단일 프로세스의 결과만 변환한다.
 * @param args git 인자 배열
 * @param cwd 실행 디렉터리
 * @param env 기존 process.env에 덮어쓸 선택 환경
 * @returns 성공 시 두 출력 스트림, 실패 시 두 스트림을 담은 GitError
 */
function runGitDetailedOnce(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
  input?: GitInput
): Promise<GitCommandOutput> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitError(`git ${args.join(" ")} cancelled`, ""));
      return;
    }
    const child = execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : undefined,
      },
      (error, stdout, stderr) => {
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(
            new GitError(
              `git ${args.join(" ")} 실패: ${error.message}`,
              stderr,
              stdout,
              error
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    /** AbortSignal과 child process를 연결해 supersede된 read가 남지 않게 한다. */
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
}

/**
 * 표준 입력이 필요한 git 명령을 실행하고 표준 출력을 문자열로 반환한다.
 * - `cat-file --batch-check` 처럼 여러 객체를 한 프로세스에서 확인해야 할 때 사용한다.
 * - runGit 과 같은 lock 재시도 정책을 공유해 호출부가 git 실행 방식을 신경 쓰지 않게 한다.
 * @param args git 인자 배열
 * @param cwd 실행 디렉터리(저장소 경로)
 * @param input git 프로세스의 stdin 으로 전달할 문자열 또는 원본 바이트
 * @param options 추가 env 또는 lock 재시도 옵션
 */
export async function runGitWithInput(
  args: string[],
  cwd: string,
  input: GitInput,
  options?: Record<string, string> | RunGitOptions
): Promise<string> {
  const normalized = normalizeOptions(options);
  return (await withGitRetry(args, normalized, () =>
    runGitDetailedOnce(args, cwd, normalized.env, normalized.signal, input)
  )).stdout;
}

/**
 * git 표준 출력을 UTF-8 변환 없이 원본 Buffer로 반환한다.
 * - `git diff --binary`처럼 text hunk에도 임의 바이트가 포함될 수 있는 출력은 문자열로 읽으면
 *   잘못된 UTF-8이 U+FFFD로 치환되므로 snapshot이나 재적용 경로에서 반드시 이 함수를 사용한다.
 * - 실패 stderr/stdout만 진단 문자열로 변환하며 성공 출력은 한 바이트도 재인코딩하지 않는다.
 * @param args git 인자 배열
 * @param cwd 실행 디렉터리(저장소 경로)
 * @param options 추가 env 또는 lock 재시도 옵션
 * @returns git stdout 원본 바이트
 */
export async function runGitBuffer(
  args: string[],
  cwd: string,
  options?: Record<string, string> | RunGitOptions
): Promise<Buffer> {
  const normalized = normalizeOptions(options);
  return withGitRetry(args, normalized, () =>
    runGitBufferOnce(args, cwd, normalized.env, normalized.signal)
  );
}

/**
 * 모든 출력 형식에 같은 오류 분류·취소·재시도 전 검증을 적용한다.
 * @param args 부작용 위험을 판단할 Git 명령 인자
 * @param options 실행 취소 및 재시도 정책
 * @param execute 실제 Git 프로세스를 한 번 실행하는 함수
 * @returns 성공한 실행 결과. 취소나 재시도 불가 오류는 호출부로 전달한다.
 */
async function withGitRetry<T>(args: string[], options: RunGitOptions, execute: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await execute();
    } catch (error) {
      if (
        options.signal?.aborted ||
        options.retryOnLock === false ||
        !isRetryableGitError(error, args) ||
        attempt >= LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(LOCK_RETRY_DELAYS_MS[attempt], options.signal);
      await options.beforeRetry?.();
    }
  }
}

/**
 * stdout encoding을 지정하지 않고 git 명령을 한 번 실행한다.
 * - Buffer 출력이 필요한 공개 함수도 문자열 실행과 같은 GitError/retry 판정을 공유하도록
 *   실패 출력만 UTF-8 진단 텍스트로 바꾼다.
 * @param args git 인자 배열
 * @param cwd 실행 디렉터리
 * @param env 기존 process.env에 덮어쓸 선택 환경
 * @returns 성공 stdout 원본 Buffer
 */
function runGitBufferOnce(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  signal?: AbortSignal
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitError(`git ${args.join(" ")} cancelled`, ""));
      return;
    }
    const child = execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        windowsHide: true,
        encoding: null,
        env: env ? { ...process.env, ...env } : undefined,
      },
      (error, stdout, stderr) => {
        signal?.removeEventListener("abort", abort);
        if (error) {
          const stderrText = stderr.toString("utf8");
          const stdoutText = stdout.toString("utf8");
          reject(
            new GitError(
              `git ${args.join(" ")} 실패: ${error.message}`,
              stderrText,
              stdoutText,
              error
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
    /** Buffer 실행도 호출 취소 시 자식 Git을 종료하고 이후 재시도를 막는다. */
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** 세 번째 인자가 env shortcut 인지 options 객체인지 판별해 정규화한다. */
function normalizeOptions(
  options?: Record<string, string> | RunGitOptions
): RunGitOptions {
  if (!options) {
    return {};
  }
  if (
    "env" in options ||
    "retryOnLock" in options ||
    "beforeRetry" in options ||
    "signal" in options
  ) {
    return options as RunGitOptions;
  }
  return { env: options as Record<string, string> };
}

/**
 * 호출 환경 또는 현재 process에 이미 설정된 Git command-scope 항목 개수를 안전하게 읽는다.
 * @param explicit 호출자가 env에 직접 넣은 GIT_CONFIG_COUNT. 없으면 process 환경 값을 사용한다.
 * @returns 새 override를 덧붙일 첫 index
 * @throws 음수·소수·비숫자처럼 Git이 해석할 수 없는 count면 조기에 오류
 */
function gitConfigCount(explicit: string | undefined): number {
  const raw = explicit ?? process.env.GIT_CONFIG_COUNT;
  if (raw === undefined || raw === "") {
    return 0;
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid GIT_CONFIG_COUNT: ${raw}`);
  }
  return count;
}

/** git index/ref lock 이 다른 git 프로세스에 의해 잡힌 상황인지 확인한다. */
function isGitLockError(error: GitError): boolean {
  // 명령 인자/훅 stdout에는 사용자 파일명·커밋 메시지가 포함되므로 판정에 쓰지 않는다.
  // 값 불일치나 ref 경로 충돌은 재시도로 해결되지 않으므로 실제 lock 파일 경합만 허용한다.
  return /^(?:fatal|error): [^\r\n]*unable to create [^\r\n]*\.lock['"]?: File exists\.?\s*$/im.test(error.stderr);
}

/** git 실행 자체가 일시적 자원 오류나 lock 으로 실패했는지 확인한다. */
function isRetryableGitError(error: unknown, args: string[]): boolean {
  if (error instanceof GitError) {
    return (isGitLockError(error) && isSafeLockRetry(args)) || isTransientSpawnError(error);
  }
  const code =
    typeof error === "object" && error
      ? (error as { code?: unknown }).code
      : undefined;
  return isTransientSpawnError({ code });
}

/**
 * hook/원격/여러 ref를 이미 변경했을 수 있는 명령은 lock 오류여도 통째로 재실행하지 않는다.
 * @param args 전역 Git 옵션을 포함한 실행 인자
 * @returns 부분 변경이나 훅 중복 실행 위험이 작은 단일 작업이면 true
 */
function isSafeLockRetry(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(value)) {
      index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    return !["commit", "push", "pull", "merge", "rebase", "cherry-pick", "revert", "stash"].includes(value);
  }
  return false;
}

/** spawn/파일 디스크립터 계열의 일시적 실행 오류인지 확인한다. */
function isTransientSpawnError(error: { code?: unknown }): boolean {
  return (
    error.code === "EBADF" ||
    error.code === "EMFILE" ||
    error.code === "ENFILE" ||
    error.code === "EAGAIN"
  );
}

/** lock 대기 중 취소도 즉시 전달해 취소된 명령이 재실행되지 않게 한다. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    /** 취소 시 타이머와 리스너를 정리하고 GitError로 실패를 전달한다. */
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new GitError("Git command cancelled during retry.", ""));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
