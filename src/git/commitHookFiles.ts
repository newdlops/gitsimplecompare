// commit hook 파일의 존재/권한과 exclusive 생성을 담당하는 저수준 파일 시스템 모듈.
// - Git 설정/작업트리 정책을 알지 않으며, 상위 CommitHookService가 사용할 안전한 primitive만 제공한다.
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  stat,
} from "node:fs/promises";

/** hook 후보 pathname에서 읽은 파일 종류와 identity 정보. */
export interface HookFileState {
  /** 조회한 절대 경로 */
  path: string;
  /** 일반 파일 또는 심볼릭 링크가 존재하는지 여부 */
  exists: boolean;
  /** 현재 프로세스가 실행할 수 있는지 여부 */
  executable: boolean;
  /** pathname 자체가 심볼릭 링크인지 여부 */
  symbolicLink: boolean;
  /** 마지막 수정 시각(epoch milliseconds) */
  modifiedAt: number;
  /** inode identity를 구성하는 device 번호 */
  dev: number;
  /** inode identity를 구성하는 inode 번호 */
  ino: number;
}

/** 해석된 hooksPath의 파일 시스템 종류. */
export type HookDirectoryState = "ready" | "missing" | "notDirectory";

/**
 * hook 후보의 존재, 실행 권한, symlink 여부와 inode identity를 읽는다.
 * - ENOENT/ENOTDIR은 정상적인 미설치 상태로 바꾸고 그 밖의 권한/I/O 오류는 상위로 전달한다.
 * @param filePath 조회할 hook 후보 절대 경로
 * @returns 파일이 없으면 exists=false, 있으면 안전한 후속 mutation에 필요한 상태
 */
export async function readHookFileState(
  filePath: string
): Promise<HookFileState> {
  try {
    const entry = await lstat(filePath);
    const executable =
      process.platform === "win32" || (await hasExecutePermission(filePath));
    return {
      path: filePath,
      exists: entry.isFile() || entry.isSymbolicLink(),
      executable,
      symbolicLink: entry.isSymbolicLink(),
      modifiedAt: entry.mtimeMs,
      dev: entry.dev,
      ino: entry.ino,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return missingHookFileState(filePath);
    }
    throw error;
  }
}

/**
 * 해석된 hook 경로가 디렉터리인지, 아직 없는지, 일반 파일인지 구분한다.
 * - `/dev/null` 같은 비활성화용 hooksPath를 notDirectory로 표시해 생성을 차단할 수 있게 한다.
 * @param directory Git이 해석한 hook 디렉터리 절대 경로
 * @returns 존재하는 디렉터리, 미존재 경로, 디렉터리가 아닌 경로 상태
 */
export async function readHookDirectoryState(
  directory: string
): Promise<HookDirectoryState> {
  try {
    const entry = await stat(directory);
    return entry.isDirectory() ? "ready" : "notDirectory";
  } catch (error) {
    if (isMissingFileError(error)) {
      return "missing";
    }
    throw error;
  }
}

/**
 * 새 hook을 exclusive file descriptor로 만들고 내용/권한을 같은 inode에 적용한다.
 * - 생성 뒤 pathname을 다시 열지 않아 외부 atomic replace가 다른 파일 chmod로 이어지지 않는다.
 * @param filePath 생성할 표준 hook 절대 경로
 * @param content 기록할 shell hook 템플릿
 */
export async function createHookFile(
  filePath: string,
  content: string
): Promise<void> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      noFollow,
    0o755
  );
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    if (process.platform !== "win32") {
      await handle.chmod(0o755);
    }
  } finally {
    await handle.close();
  }
}

/**
 * hook 디렉터리가 실제로 존재하고 읽을 수 있는지 가볍게 확인한다.
 * @param directory inspect 결과의 관리 디렉터리
 * @returns 읽을 수 있으면 true, 단순 미존재이면 false
 */
export async function commitHooksDirectoryExists(
  directory: string
): Promise<boolean> {
  return readdir(directory).then(
    () => true,
    (error) => {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  );
}

/**
 * 미설치 hook을 예외 없이 표현하는 기본 상태를 만든다.
 * @param filePath 존재하지 않는 후보 절대 경로
 * @returns 모든 capability와 identity가 비어 있는 상태
 */
function missingHookFileState(filePath: string): HookFileState {
  return {
    path: filePath,
    exists: false,
    executable: false,
    symbolicLink: false,
    modifiedAt: 0,
    dev: 0,
    ino: 0,
  };
}

/**
 * Unix 실행 권한을 현재 프로세스 기준으로 검사한다.
 * @param filePath 검사할 일반 파일 또는 심볼릭 링크 경로
 * @returns 실행 가능한 경로이면 true, access가 거부되면 false
 */
async function hasExecutePermission(filePath: string): Promise<boolean> {
  return access(filePath, fsConstants.X_OK).then(
    () => true,
    () => false
  );
}

/**
 * Node 파일 API 오류가 단순 미존재 상태인지 판별한다.
 * @param error lstat/stat/readdir에서 발생한 알 수 없는 오류
 * @returns ENOENT 또는 ENOTDIR이면 true
 */
function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
