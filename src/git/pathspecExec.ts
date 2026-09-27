// 많은 경로를 받는 git 쓰기 명령(add/reset/checkout)을 OS 명령줄 한도와 무관하게 실행하는 모듈.
// - 폴더 선택·다중 선택으로 수천~수만 경로가 한 번에 넘어와도 E2BIG/Windows 32K 한도에 걸리지 않게 한다.
// - GitService 등 쓰기 서비스가 공유하는 실행 경계이며, 어떤 경로 전달 방식을 쓸지는 largeChangeSet 정책이 정한다.
import { GitError, runGit, runGitWithInput, type RunGitOptions } from "./gitExec";
import { shouldPassPathspecsViaStdin } from "./largeChangeSet";

/** stdin pathspec 을 모르는 구버전 git 에서 argv 로 나눠 실행할 때 한 번에 넘길 최대 경로 수. */
const ARGV_CHUNK_MAX_PATHS = 100;
/** stdin pathspec 을 모르는 구버전 git 에서 argv 로 나눠 실행할 때 한 번에 넘길 최대 문자 수. */
const ARGV_CHUNK_MAX_CHARS = 8 * 1024;

/**
 * 경로 목록을 대상으로 git 명령을 실행한다.
 * - 경로가 적으면 기존과 같은 `-- <paths>` argv 로 넘긴다.
 * - 경로가 많으면 `--pathspec-from-file=- --pathspec-file-nul` 로 stdin 에 NUL 구분 목록을 넘겨
 *   명령줄 길이 한도를 피한다(git 2.25+ 의 add/reset/checkout/restore/rm 이 지원).
 * - stdin pathspec 을 모르는 git 이면 argv 한도 안에서 나눠 여러 번 실행한다. 따라서 경로마다
 *   독립적으로 적용되는 명령(add, reset, checkout 등)에만 사용해야 한다.
 * - `--literal-pathspecs` 전역 옵션은 stdin 으로 읽은 pathspec 에도 그대로 적용된다.
 * @param commandArgs `--` 앞까지의 전체 인자(전역 옵션 + 하위 명령 + 옵션). 예: `["--literal-pathspecs", "add"]`
 * @param paths 저장소 상대 경로 목록. 비어 있으면 아무 것도 실행하지 않는다
 * @param cwd git 을 실행할 저장소 루트
 * @param options env·lock 재시도 등 runGit 옵션
 */
export async function runGitWithPaths(
  commandArgs: readonly string[],
  paths: readonly string[],
  cwd: string,
  options?: RunGitOptions
): Promise<void> {
  if (!paths.length) {
    return;
  }
  if (!shouldPassPathspecsViaStdin(paths)) {
    await runGit([...commandArgs, "--", ...paths], cwd, options);
    return;
  }
  try {
    await runGitWithInput(
      [...commandArgs, "--pathspec-from-file=-", "--pathspec-file-nul"],
      cwd,
      `${paths.join("\0")}\0`,
      options
    );
  } catch (error) {
    if (!isUnsupportedPathspecFileError(error)) {
      throw error;
    }
    for (const chunk of argvChunks(paths)) {
      await runGit([...commandArgs, "--", ...chunk], cwd, options);
    }
  }
}

/**
 * git 이 `--pathspec-from-file`/`--pathspec-file-nul` 옵션 자체를 모르는 경우인지 판별한다.
 * - 오류 message 에는 실행 인자 전체가 들어가므로 stderr 의 parse-options 문구만 본다.
 *   그래야 hook 실패·lock 등 다른 오류를 구버전 git 으로 오인해 재실행하지 않는다.
 * @param error runGitWithInput 이 던진 오류
 * @returns 구버전 git 의 unknown option 오류면 true
 */
export function isUnsupportedPathspecFileError(error: unknown): boolean {
  return (
    error instanceof GitError &&
    /unknown option\W+pathspec-(?:from-file|file-nul)/i.test(error.stderr)
  );
}

/**
 * 경로 목록을 argv 한도 안의 조각으로 나눈다(구버전 git fallback 전용).
 * @param paths 전체 경로 목록
 * @returns 각 조각이 개수·문자 수 상한을 넘지 않는 경로 배열 목록(입력 순서 유지)
 */
export function argvChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const value of paths) {
    const size = value.length + 1;
    if (
      current.length > 0 &&
      (current.length >= ARGV_CHUNK_MAX_PATHS || chars + size > ARGV_CHUNK_MAX_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(value);
    chars += size;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}
