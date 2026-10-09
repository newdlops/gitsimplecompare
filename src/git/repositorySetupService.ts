// 저장소를 여는 온보딩의 Git 작업. VS Code API나 설정 저장에 의존하지 않는다.
// - Clone/Init은 모든 Git 서비스와 같은 runGit을 사용하고 입력은 셸 없이 인자로 전달한다.
// - 기존 저장소를 초기화하거나 이미 존재하는 복제 대상의 내용을 덮어쓰지 않는다.
import path from "node:path";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { runGit, withGitConfigOverrides, type RunGitOptions } from "./gitExec";

/** 자체 실행기를 대체할 테스트 경계. 실제 실행 경로는 기본값 runGit 하나뿐이다. */
export type SetupGitRunner = (args: string[], cwd: string, options?: RunGitOptions) => Promise<string>;
/** 온보딩 완료 뒤 화면이 사용할 저장소 식별 정보. */
export interface RepositorySetupResult {
  root: string;
  branch: string;
  created: boolean;
}
/** 복제 시 선택한 인증과 취소 신호. 인증 정보는 영구 저장하거나 URL에 넣지 않는다. */
export interface RepositoryCloneOptions {
  signal?: AbortSignal;
  githubToken?: string;
}
export type RepositorySetupErrorCode = "invalid-source" | "invalid-name" | "invalid-folder" |
  "destination-exists" | "cancelled" | "git-failed";
/** UI가 입력·중복 경로·취소·실행 실패를 구분할 수 있는 비민감 진단 오류다. */
export class RepositorySetupError extends Error {
  constructor(public readonly code: RepositorySetupErrorCode, message: string) {
    super(message);
    this.name = "RepositorySetupError";
  }
}

/** 새 저장소의 경계가 호출 프로세스의 기존 index·worktree에 묶이지 않게 제거할 환경 이름. */
const REPOSITORY_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/**
 * 복제 입력을 Git 옵션이나 원격 helper 명령으로 해석하지 않도록 검증한다.
 * @param input 사용자가 입력한 URL, GitHub owner/name, SSH 주소 또는 명시적 로컬 경로
 * @returns 공백을 정리한 Git 원본 주소. GitHub owner/name은 HTTPS 주소로 확장한다.
 */
export function normalizeCloneSource(input: string): string {
  const value = input.trim();
  if (!value || value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new RepositorySetupError("invalid-source", "Enter a repository URL, SSH address, or local repository path.");
  }
  if (path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) return value;
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[^\s]+$/.test(value)) return value;
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)) return "https://github.com/" + value.replace(/\.git$/, "") + ".git";
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RepositorySetupError("invalid-source", "Enter a valid repository URL or SSH address."); }
  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol) ||
      (url.protocol !== "file:" && !url.hostname)) {
    throw new RepositorySetupError("invalid-source", "This repository URL protocol is not supported.");
  }
  if (url.password || (["http:", "https:"].includes(url.protocol) && url.username) || url.search || url.hash) {
    throw new RepositorySetupError("invalid-source", "Use a repository URL without embedded credentials, query parameters, or fragments.");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new RepositorySetupError("invalid-source", "The repository URL must include a repository path.");
  }
  return url.toString();
}

/**
 * 복제 대상 이름이 선택한 부모 폴더 밖으로 나가거나 옵션·특수 파일이 되지 않게 검증한다.
 * @param input 부모 폴더 안에 새로 만들 단일 디렉터리 이름
 * @returns 검증된 폴더 이름. 경로 구분자·예약 이름·제어 문자가 있으면 오류를 던진다.
 */
export function validateRepositoryFolderName(input: string): string {
  const name = input.trim();
  if (!name || name === "." || name === ".." || name.toLowerCase() === ".git" || name.startsWith("-") ||
      /[\\/\0-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new RepositorySetupError("invalid-name", "Choose a valid repository folder name without path separators.");
  }
  return name;
}

/**
 * URL·SSH·로컬 원본의 마지막 경로에서 안전한 복제 폴더 기본값을 만든다.
 * @param input 검증 전 또는 검증 후 저장소 주소
 * @returns .git 접미사를 제외한 이름. 안전한 이름을 얻지 못하면 repository를 반환한다.
 */
export function suggestedRepositoryFolderName(input: string): string {
  const normalized = normalizeCloneSource(input);
  let pathname = normalized;
  if (normalized.includes("://")) pathname = new URL(normalized).pathname;
  const candidate = pathname.replace(/\/+$/, "").split(/[\\/:]/).at(-1)?.replace(/\.git$/i, "") || "repository";
  try { return validateRepositoryFolderName(decodeURIComponent(candidate)); }
  catch { return "repository"; }
}

/**
 * 입력된 폴더의 실제 경로를 반환하고 파일·없는 폴더와 구분한다.
 * @param directory 사용자가 열기 또는 생성의 부모로 선택한 기존 디렉터리
 * @returns 파일 시스템에서 확인한 디렉터리 절대 경로
 */
async function existingDirectory(directory: string): Promise<string> {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new RepositorySetupError("invalid-folder", "Choose an existing local folder.");
  }
}

/**
 * 인증 헤더를 GitHub HTTPS 주소에만 주입하고 기존 command-scope Git 환경도 보존한다.
 * @param source 검증된 Git 원본
 * @param options 현재 복제의 일시적 OAuth token 및 취소 신호
 * @returns 전용 프로세스 환경과 취소 정책. URL·인자 배열에는 인증 정보를 추가하지 않는다.
 */
function cloneExecutionOptions(source: string, options: RepositoryCloneOptions): RunGitOptions {
  let env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  if (options.githubToken && source.startsWith("https://") && new URL(source).hostname === "github.com") {
    const encoded = Buffer.from("x-access-token:" + options.githubToken).toString("base64");
    env = withGitConfigOverrides(env, { "http.https://github.com/.extraheader": "Authorization: Basic " + encoded });
  }
  return { env, clearEnv: REPOSITORY_ENV, retryOnLock: false, signal: options.signal };
}

/**
 * Git 오류의 진단에 일시적 인증이 포함되어도 로그나 사용자 알림에 전달되지 않게 가린다.
 * @param error 실제 실행기의 실패 원문
 * @param token 현재 복제의 인증 값. 없으면 일반 오류 메시지만 정리한다.
 * @returns 민감하지 않은 최대 2,000자의 진단 문자열
 */
function safeGitDiagnostic(error: unknown, token?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) {
    for (const secret of [token, Buffer.from("x-access-token:" + token).toString("base64"), encodeURIComponent(token)]) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  return message.replace(/(authorization:\s*(?:basic|bearer|token)\s+)\S+/gi, "$1[REDACTED]").slice(0, 2000);
}

/**
 * 취소가 요청된 작업은 입력이나 Git 상태를 변경하기 전에 일관된 취소 오류로 종료한다.
 * @param signal 현재 사용자 작업의 취소 신호
 * @returns 신호가 취소되지 않았으면 반환하고, 취소되었으면 cancelled 오류를 던진다.
 */
function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RepositorySetupError("cancelled", "Repository setup was cancelled.");
}

/**
 * 저장소 복제·초기화·열기를 Git 서비스 경계에서 제공한다.
 * @param execute 테스트용 실행기. production에서는 공통 runGit을 그대로 사용한다.
 */
export class RepositorySetupService {
  constructor(private readonly execute: SetupGitRunner = runGit) {}

  /**
   * 기존 디렉터리에서 실제 저장소 루트를 찾는다. 하위 폴더를 선택해도 정확한 루트를 연다.
   * @param directory 사용자가 선택한 기존 로컬 디렉터리
   * @param signal 조회를 취소할 선택적 신호
   * @returns 저장소이면 실제 루트, 저장소 밖이면 undefined
   */
  async findRepository(directory: string, signal?: AbortSignal): Promise<string | undefined> {
    assertNotCancelled(signal);
    const cwd = await existingDirectory(directory);
    try {
      const root = (await this.execute(["rev-parse", "--show-toplevel"], cwd,
        { clearEnv: REPOSITORY_ENV, signal, retryOnLock: false })).trim();
      assertNotCancelled(signal);
      return root || undefined;
    } catch (error) {
      assertNotCancelled(signal);
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/i.test(message)) return undefined;
      throw new RepositorySetupError("git-failed", safeGitDiagnostic(error));
    }
  }

  /**
   * 새 폴더에만 저장소를 복제한다. 이미 존재하는 폴더나 파일은 비어 있어도 건드리지 않는다.
   * @param source URL·SSH 주소·명시적 로컬 원본
   * @param parentDirectory 대상 폴더의 기존 부모 디렉터리
   * @param folderName 새로 만들 단일 폴더 이름
   * @param options 현재 작업의 취소 및 GitHub 인증
   * @returns 검증된 저장소 루트·브랜치와 created=true
   */
  async clone(source: string, parentDirectory: string, folderName: string,
    options: RepositoryCloneOptions = {}): Promise<RepositorySetupResult> {
    assertNotCancelled(options.signal);
    const url = normalizeCloneSource(source);
    const name = validateRepositoryFolderName(folderName);
    const parent = await existingDirectory(parentDirectory);
    const destination = path.join(parent, name);
    try { await mkdir(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RepositorySetupError("destination-exists", "The destination already exists. Choose a different folder name.");
      }
      throw new RepositorySetupError("invalid-folder", "The repository folder could not be created.");
    }
    const owned = await lstat(destination);
    try {
      assertNotCancelled(options.signal);
      await this.execute(["clone", "--progress", "--", url, destination], parent, cloneExecutionOptions(url, options));
      assertNotCancelled(options.signal);
      const root = await realpath(destination);
      return { root, branch: await this.currentBranch(root, options.signal), created: true };
    } catch (error) {
      // 비어 있는 소유 디렉터리만 지운다. Git이나 사용자가 남긴 파일을 재귀 삭제하지 않는다.
      await this.removeEmptyOwnedDirectory(destination, owned);
      assertNotCancelled(options.signal);
      throw new RepositorySetupError("git-failed", safeGitDiagnostic(error, options.githubToken));
    }
  }

  /**
   * 선택한 기존 폴더를 초기화하되 이미 저장소 안에 있으면 그 저장소를 그대로 반환한다.
   * @param directory 초기화할 기존 디렉터리
   * @param initialBranch 새 저장소의 첫 브랜치 이름
   * @param signal 초기화 작업의 취소 신호
   * @returns 새 저장소이면 created=true, 기존 저장소이면 created=false
   */
  async initialize(directory: string, initialBranch = "main", signal?: AbortSignal): Promise<RepositorySetupResult> {
    assertNotCancelled(signal);
    const cwd = await existingDirectory(directory);
    const existing = await this.findRepository(cwd, signal);
    if (existing) return { root: existing, branch: await this.currentBranch(existing, signal), created: false };
    if (!initialBranch || initialBranch.startsWith("-") || /[\0\r\n]/.test(initialBranch)) {
      throw new RepositorySetupError("invalid-name", "Choose a valid initial branch name.");
    }
    try {
      await this.execute(["check-ref-format", "--branch", initialBranch], cwd, { clearEnv: REPOSITORY_ENV, signal });
      assertNotCancelled(signal);
      await this.execute(["init", "--initial-branch=" + initialBranch, "--", "."], cwd,
        { clearEnv: REPOSITORY_ENV, retryOnLock: false, signal });
      assertNotCancelled(signal);
      return { root: cwd, branch: await this.currentBranch(cwd, signal), created: true };
    } catch (error) {
      assertNotCancelled(signal);
      throw new RepositorySetupError("git-failed", safeGitDiagnostic(error));
    }
  }

  /**
   * 새 저장소·unborn HEAD의 브랜치도 로그 조회 없이 같은 방식으로 읽는다.
   * @param root 실제 저장소 루트
   * @param signal 복제·초기화가 완료된 뒤 메타데이터 조회 중에도 취소할 신호
   * @returns 이름이 있는 HEAD의 브랜치, detached HEAD이면 HEAD. 취소는 성공으로 바꾸지 않는다.
   */
  private async currentBranch(root: string, signal?: AbortSignal): Promise<string> {
    try {
      const branch = await this.execute(["symbolic-ref", "--quiet", "--short", "HEAD"], root,
        { clearEnv: REPOSITORY_ENV, signal });
      assertNotCancelled(signal);
      return branch.trim() || "HEAD";
    } catch {
      assertNotCancelled(signal);
      return "HEAD";
    }
  }

  /**
   * 실패·취소 뒤에도 같은 inode의 비어 있는 디렉터리만 정리한다.
   * @param directory 이번 clone이 직접 만든 디렉터리
   * @param owned 생성 직후 기록한 디렉터리 식별 정보
   * @returns 남은 파일이나 경로 교체가 있으면 삭제 없이 끝낸다.
   */
  private async removeEmptyOwnedDirectory(directory: string, owned: { dev: number; ino: number }): Promise<void> {
    try {
      const current = await lstat(directory);
      if (current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) await rmdir(directory);
    } catch {
      // Git의 자체 cleanup이나 남은 데이터가 있으면 그 상태를 보존한다.
    }
  }
}
