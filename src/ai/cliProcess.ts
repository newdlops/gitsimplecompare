// AI CLI 실행 전에 VS Code extension host 의 제한된 PATH 를 보강하는 공통 모듈.
// - macOS Finder/VS Code 에서 로그인 셸 PATH 가 빠지는 경우 Claude/Codex CLI 탐색 실패를 막는다.
import { spawn } from "child_process";
import { constants } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

/** AI CLI spawn 에 넘길 실행 파일과 환경 변수 묶음. */
export interface AiCliLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
  resolvedCommand?: string;
}

const LOGIN_SHELL_PATH_TIMEOUT_MS = 3000;
const MAX_SHELL_PATH_CHARS = 30000;
let loginShellPathPromise: Promise<string> | undefined;

/**
 * AI CLI 실행 파일을 찾기 쉬운 환경으로 보정한다.
 * @param command 사용자가 설정한 실행 파일 이름 또는 경로
 * @returns spawn 에 넘길 command/env. 단순 파일명은 보강 PATH 에서 절대 경로로 해석될 수 있다.
 */
export async function prepareAiCliLaunch(command: string): Promise<AiCliLaunch> {
  const env = await aiCliEnvironment();
  const expandedCommand = expandHome(command);
  if (!isBareExecutableName(expandedCommand)) {
    return { command: expandedCommand, env };
  }
  const resolvedCommand = await findExecutable(expandedCommand, env[pathEnvKey(env)] || "");
  return {
    command: resolvedCommand || expandedCommand,
    env,
    resolvedCommand,
  };
}

/**
 * VS Code 프로세스 환경에 로그인 셸 PATH 와 흔한 CLI 설치 경로를 합친다.
 * @returns AI CLI 실행용 환경 변수
 */
async function aiCliEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
  const key = pathEnvKey(env);
  const mergedPath = mergePathValues([
    env[key] || "",
    await loginShellPath(),
    ...commonCliPaths(),
  ]);
  return { ...env, [key]: mergedPath };
}

/**
 * 로그인 셸이 보는 PATH 를 한 번만 읽어 캐시한다.
 * @returns 셸에서 출력한 PATH. 실패하면 빈 문자열
 */
function loginShellPath(): Promise<string> {
  if (process.platform === "win32") {
    return Promise.resolve("");
  }
  if (!loginShellPathPromise) {
    loginShellPathPromise = readLoginShellPath();
  }
  return loginShellPathPromise;
}

/**
 * 사용자의 기본 셸을 짧게 실행해 로그인 셸 PATH 를 얻는다.
 * @returns 셸 PATH. timeout/실패 시 빈 문자열
 */
function readLoginShellPath(): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const child = spawn(shell, ["-lc", "printf %s \"$PATH\""], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    const timeout = setTimeout(() => finish(""), LOGIN_SHELL_PATH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-MAX_SHELL_PATH_CHARS);
    });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? stdout.trim() : ""));

    /**
     * 셸 PATH 조회를 한 번만 완료 처리한다.
     * @param value resolve 할 PATH 문자열
     */
    function finish(value: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) {
        child.kill();
      }
      resolve(value);
    }
  });
}

/**
 * Homebrew, npm, pnpm, cargo 등 CLI 가 자주 설치되는 보조 경로를 만든다.
 * @returns PATH 에 추가할 후보 디렉터리 목록
 */
function commonCliPaths(): string[] {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".yarn", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm"),
  ];
}

/**
 * 여러 PATH 문자열/디렉터리를 중복 없이 순서대로 합친다.
 * @param values PATH 문자열 또는 단일 디렉터리 목록
 * @returns 현재 플랫폼 구분자로 합친 PATH
 */
function mergePathValues(values: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    for (const rawPart of value.split(path.delimiter)) {
      const part = rawPart.trim();
      if (!part || seen.has(part)) {
        continue;
      }
      seen.add(part);
      parts.push(part);
    }
  }
  return parts.join(path.delimiter);
}

/**
 * PATH 에서 실행 가능한 파일의 절대 경로를 찾는다.
 * @param command 찾을 실행 파일 이름
 * @param pathValue 검색할 PATH 문자열
 * @returns 실행 가능하면 절대 경로, 아니면 undefined
 */
async function findExecutable(
  command: string,
  pathValue: string
): Promise<string | undefined> {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const candidate of executableCandidates(path.join(dir, command))) {
      if (await canExecute(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Windows PATHEXT 를 고려해 실행 파일 후보를 만든다.
 * @param candidate PATH 와 command 를 합친 기본 후보
 * @returns 실제 파일 검사 후보 목록
 */
function executableCandidates(candidate: string): string[] {
  if (process.platform !== "win32" || path.extname(candidate)) {
    return [candidate];
  }
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return [candidate, ...extensions.map((extension) => `${candidate}${extension.toLowerCase()}`)];
}

/**
 * 파일이 현재 플랫폼에서 실행 가능한지 확인한다.
 * @param candidate 검사할 파일 경로
 * @returns 실행 가능하면 true
 */
async function canExecute(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 환경 변수 객체에서 현재 플랫폼의 PATH key 를 찾는다.
 * @param env PATH 를 찾을 환경 변수
 * @returns PATH 또는 Windows 의 기존 Path key
 */
function pathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

/**
 * 셸 해석 없이 PATH 검색 가능한 단순 실행 파일 이름인지 판단한다.
 * @param command 사용자가 설정한 command
 * @returns 경로나 공백 없이 파일명만 있으면 true
 */
function isBareExecutableName(command: string): boolean {
  return !/[\\/]/.test(command) && !/\s/.test(command);
}

/**
 * 사용자가 command 에 ~/ 경로를 넣은 경우 spawn 가능 경로로 확장한다.
 * @param command 설정 원본 command
 * @returns 홈 디렉터리를 반영한 command
 */
function expandHome(command: string): string {
  if (command === "~") {
    return os.homedir();
  }
  if (command.startsWith("~/") || command.startsWith("~\\")) {
    return path.join(os.homedir(), command.slice(2));
  }
  return command;
}
