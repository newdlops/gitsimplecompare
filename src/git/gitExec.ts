// git CLI 를 실제로 실행하는 저수준 래퍼 모듈.
// - 여러 git 서비스(GitService, GitLogService 등)가 공유하는 단일 실행 지점이다.
//   execFile 로 셸을 거치지 않아 인자 이스케이프 문제가 없다.
import { execFile } from "node:child_process";

/** git 명령 실행 중 발생한 오류를 식별하기 위한 전용 에러 타입 */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly stdout = ""
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  env?: Record<string, string>;
  retryOnLock?: boolean;
  beforeRetry?: () => Promise<void>;
}

/** Git stdin으로 전달할 수 있는 UTF-8 문자열 또는 원본 바이트 입력이다. */
export type GitInput = string | Uint8Array;

const LOCK_RETRY_DELAYS_MS = [250, 500, 900, 1400, 2000];
const MAX_GIT_BUFFER_BYTES = 128 * 1024 * 1024;

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
  const normalized = normalizeOptions(options);
  const retryOnLock = normalized.retryOnLock !== false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGitOnce(args, cwd, normalized.env);
    } catch (error) {
      if (
        !retryOnLock ||
        !isRetryableGitError(error) ||
        attempt >= LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(LOCK_RETRY_DELAYS_MS[attempt]);
      await normalized.beforeRetry?.();
    }
  }
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
  const retryOnLock = normalized.retryOnLock !== false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGitOnce(args, cwd, normalized.env, input);
    } catch (error) {
      if (
        !retryOnLock ||
        !isRetryableGitError(error) ||
        attempt >= LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(LOCK_RETRY_DELAYS_MS[attempt]);
      await normalized.beforeRetry?.();
    }
  }
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
  const retryOnLock = normalized.retryOnLock !== false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGitBufferOnce(args, cwd, normalized.env);
    } catch (error) {
      if (
        !retryOnLock ||
        !isRetryableGitError(error) ||
        attempt >= LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(LOCK_RETRY_DELAYS_MS[attempt]);
      await normalized.beforeRetry?.();
    }
  }
}

/** git 명령 한 번을 실행한다. lock 재시도 루프는 runGit 이 담당한다. */
function runGitOnce(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  input?: GitInput
): Promise<string> {
  return new Promise((resolve, reject) => {
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
        if (error) {
          reject(
            new GitError(`git ${args.join(" ")} 실패: ${error.message}`, stderr, stdout)
          );
          return;
        }
        resolve(stdout);
      }
    );
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
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
  env?: Record<string, string>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
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
        if (error) {
          const stderrText = stderr.toString("utf8");
          const stdoutText = stdout.toString("utf8");
          reject(
            new GitError(
              `git ${args.join(" ")} 실패: ${error.message}`,
              stderrText,
              stdoutText
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
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
    "beforeRetry" in options
  ) {
    return options as RunGitOptions;
  }
  return { env: options as Record<string, string> };
}

/** git index/ref lock 이 다른 git 프로세스에 의해 잡힌 상황인지 확인한다. */
function isGitLockError(error: GitError): boolean {
  const text = `${error.message}\n${error.stderr}\n${error.stdout}`;
  return (
    /index\.lock/.test(text) ||
    /cannot lock ref/i.test(text) ||
    /unable to create .*\.lock/i.test(text) ||
    /another git process seems to be running/i.test(text)
  );
}

/** git 실행 자체가 일시적 자원 오류나 lock 으로 실패했는지 확인한다. */
function isRetryableGitError(error: unknown): boolean {
  if (error instanceof GitError) {
    return isGitLockError(error) || isTransientSpawnError(error);
  }
  const code =
    typeof error === "object" && error
      ? (error as { code?: unknown }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return isTransientSpawnError({ code, message });
}

/** spawn/파일 디스크립터 계열의 일시적 실행 오류인지 확인한다. */
function isTransientSpawnError(error: { code?: unknown; message: string }): boolean {
  return (
    error.code === "EBADF" ||
    error.code === "EMFILE" ||
    error.code === "ENFILE" ||
    error.code === "EAGAIN" ||
    /spawn (EBADF|EMFILE|ENFILE|EAGAIN)/i.test(error.message)
  );
}

/** lock 이 풀릴 시간을 주기 위한 Promise 기반 sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
