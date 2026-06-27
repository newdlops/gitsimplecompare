// GitHub CLI 실행을 담당하는 저수준 래퍼.
// - PR 목록/상세 서비스가 gh 실행 방식을 공유하고, 각 서비스는 데이터 해석에만 집중하게 한다.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

const GH_RETRY_DELAYS_MS = [250, 500, 900, 1400];
const GH_REQUIRED_MESSAGE =
  "GitHub CLI (gh) is required for pull request data. Install gh, or set GITHUB_CLI_PATH to the gh executable, then run gh auth login.";
const GH_AUTH_MESSAGE =
  "GitHub CLI is not authenticated. Run gh auth login and refresh pull requests again.";
const GH_PATH_CANDIDATES = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/opt/local/bin/gh",
  "/usr/bin/gh",
];

let ghExecutablePromise: Promise<string> | undefined;

/** gh 명령 실행 중 발생한 오류를 식별하기 위한 전용 에러 타입 */
export class GhCliError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
    public readonly stdout = "",
    public readonly code?: unknown
  ) {
    super(message);
    this.name = "GhCliError";
  }
}

/**
 * gh CLI 를 실행하고 stdout 문자열을 반환한다.
 * @param args gh 에 전달할 인자 목록
 * @param cwd  gh 를 실행할 저장소 루트
 * @returns gh stdout 전체
 */
export async function runGh(args: string[], cwd: string): Promise<string> {
  const executable = await resolveGhExecutable();
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGhOnce(executable, args, cwd);
    } catch (error) {
      if (!isTransientSpawnError(error) || attempt >= GH_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(GH_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** gh 명령 한 번을 실행한다. spawn 계열 재시도는 runGh 가 담당한다. */
function runGhOnce(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(createGhError(args, error, stdout, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * VS Code 프로세스 PATH 에 gh 가 없을 때도 사용할 실행 파일 경로를 찾는다.
 * - 사용자가 GITHUB_CLI_PATH 를 지정하면 가장 먼저 사용한다.
 * - macOS GUI 앱에서 빠지기 쉬운 login shell PATH 와 Homebrew 기본 경로를 보완한다.
 * @returns execFile 에 전달할 gh 실행 파일 경로. 찾지 못하면 기존 PATH 조회를 위해 "gh" 를 반환한다.
 */
async function resolveGhExecutable(): Promise<string> {
  ghExecutablePromise ||= discoverGhExecutable();
  return ghExecutablePromise;
}

/** gh 실행 파일 후보를 순서대로 확인해 첫 번째 실행 가능 경로를 반환한다. */
async function discoverGhExecutable(): Promise<string> {
  const configured = await executablePath(process.env.GITHUB_CLI_PATH);
  if (configured) {
    return configured;
  }
  const shellPath = await discoverGhFromShell();
  if (shellPath) {
    return shellPath;
  }
  for (const candidate of GH_PATH_CANDIDATES) {
    const found = await executablePath(candidate);
    if (found) {
      return found;
    }
  }
  return "gh";
}

/** login shell 의 PATH 에서 gh 위치를 찾는다. */
async function discoverGhFromShell(): Promise<string | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  const shells = Array.from(new Set([process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(isNonEmptyString)));
  for (const shell of shells) {
    const out = await execText(shell, ["-lc", "command -v gh"]).catch(() => "");
    const found = await executablePath(out.trim().split(/\r?\n/)[0]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** 파일이 실행 가능한 경로인지 확인한다. */
async function executablePath(path: string | undefined): Promise<string | undefined> {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    await access(trimmed, constants.X_OK);
    return trimmed;
  } catch {
    return undefined;
  }
}

/** 짧은 보조 명령을 실행하고 stdout 을 반환한다. */
function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** unknown 값을 비어 있지 않은 문자열로 좁힌다. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * execFile 오류를 사용자에게 노출 가능한 gh 전용 오류로 변환한다.
 * - ENOENT 는 VS Code 프로세스 PATH 에 gh 가 없는 상황이므로 설치/PATH 안내를 우선한다.
 * - 인증 실패는 gh stderr 가 장황하므로 auth login 안내로 줄인다.
 * @param args   실패한 gh 인자 목록
 * @param error  execFile 이 반환한 원본 오류
 * @param stdout gh 표준 출력
 * @param stderr gh 표준 오류
 * @returns 호출부가 그대로 표시해도 되는 GhCliError
 */
function createGhError(
  args: string[],
  error: Error & { code?: unknown },
  stdout: string,
  stderr: string
): GhCliError {
  const code = error.code;
  const detail = (stderr || error.message || "").trim();
  if (code === "ENOENT" || /spawn gh ENOENT/i.test(error.message)) {
    return new GhCliError(GH_REQUIRED_MESSAGE, args, stderr, stdout, code);
  }
  if (isAuthError(detail)) {
    return new GhCliError(GH_AUTH_MESSAGE, args, stderr, stdout, code);
  }
  return new GhCliError(`gh ${args.join(" ")} failed: ${detail || "unknown error"}`, args, stderr, stdout, code);
}

/**
 * gh CLI 가 인증되지 않아 GitHub API 호출을 거절한 오류인지 확인한다.
 * @param text gh stderr 또는 execFile 오류 메시지
 * @returns 인증 안내로 치환할 수 있으면 true
 */
function isAuthError(text: string): boolean {
  return /gh auth login|not logged in|not authenticated|authentication required|you must authenticate/i.test(text);
}

/** spawn/파일 디스크립터 계열의 일시적 gh 실행 오류인지 확인한다. */
function isTransientSpawnError(error: unknown): boolean {
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === "EBADF" || code === "EMFILE" || code === "ENFILE" || code === "EAGAIN" || /spawn (EBADF|EMFILE|ENFILE|EAGAIN)/i.test(message);
}

/** 재시도 사이에 잠시 대기한다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
