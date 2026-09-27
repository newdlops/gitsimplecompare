// 대량 변경(수천~수만 파일) 상황에서 git 호출 방식을 고르는 순수 정책 모듈.
// - vscode API나 git 실행 함수에 의존하지 않아 GitService·상태 통계·테스트가 같은 기준을 공유한다.
// - 기준값을 한곳에 모아 두어, 새 대량 최적화(예: 다른 쓰기 명령)도 같은 판단 함수로 끼워 넣을 수 있다.

/**
 * 한 번에 stage 할 파일이 이 수 이상이면 blob 을 loose object 대신 pack 하나로 기록한다.
 * - loose object 는 파일마다 임시 파일 생성·쓰기·rename 이 필요해 수만 개면 수십 초가 걸릴 수 있다.
 * - 반대로 bulk-checkin 은 `git add` 호출마다 pack 을 하나 만들므로, 작은 stage 에까지 쓰면
 *   pack 수가 빠르게 늘어 `gc --auto` 의 전체 repack 을 앞당긴다. 그래서 대량일 때만 사용한다.
 */
export const BULK_CHECKIN_MIN_FILES = 1000;

/**
 * staged/unstaged 한 bucket 의 파일이 이 수를 넘으면 +/- 라인 통계를 계산하지 않는다.
 * - `git diff --numstat -M` 은 모든 blob 을 읽고 rename 탐지까지 하므로 수만 파일에서 수 초가 걸리고,
 *   미추적 파일은 파일을 직접 읽어야 해 같은 시간에 도는 stage/commit 과 디스크를 다툰다.
 */
export const LINE_STATS_MAX_FILES = 5000;

/**
 * 파일 하나가 이 크기를 넘으면 +/- 라인 통계와 AI 문맥 patch 에서 내용 diff 를 계산하지 않는다.
 * - 수백 MB 텍스트 파일의 줄 단위 diff 는 수 초~수십 초 CPU 와 큰 메모리를 쓰고,
 *   refresh 마다 다시 돌아 commit 과 경쟁한다. 미추적 파일 줄 수 계산 상한과 같은 값을 쓴다.
 */
export const LINE_STATS_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 작업트리 통계에서 pathspec 으로 제외할 대용량 파일 수 상한.
 * - 이보다 많으면 제외 목록이 명령줄 한도에 가까워지므로 작업트리 numstat 자체를 생략한다.
 */
export const MAX_LARGE_FILE_EXCLUDES = 64;

/** VS Code `diffEditor.maxFileSize` 기본값(MB). 이보다 큰 파일은 VS Code 도 diff 를 계산하지 않는다. */
export const DEFAULT_DIFF_MAX_FILE_SIZE_MB = 50;

/**
 * diff 미리보기로 읽을 수 있는 절대 상한(byte).
 * - gitExec 의 stdout 버퍼 상한(128MB)과 같다. 이보다 큰 내용은 설정과 무관하게 읽지 않는다.
 */
export const DIFF_PREVIEW_HARD_MAX_BYTES = 128 * 1024 * 1024;

/**
 * diff 미리보기용 내용이 크기 상한을 넘었음을 나타낸다.
 * - 호출부는 내용을 메모리에 올리지 않고 "너무 큼" 안내나 파일 직접 열기로 대체한다.
 */
export class FileTooLargeError extends Error {
  /**
   * @param path 저장소 상대 경로
   * @param limitBytes 적용한 상한(byte)
   * @param sizeBytes 알려진 실제 크기(byte). git 출력이 상한에서 잘린 경우처럼 모르면 undefined
   */
  constructor(
    readonly path: string,
    readonly limitBytes: number,
    readonly sizeBytes?: number
  ) {
    super(`${path} is larger than ${limitBytes} bytes.`);
    this.name = "FileTooLargeError";
  }
}

/** argv 대신 stdin pathspec 으로 넘기기 시작하는 경로 개수. */
export const PATHSPEC_STDIN_MIN_PATHS = 200;

/**
 * argv 대신 stdin pathspec 으로 넘기기 시작하는 경로 문자열 총 길이.
 * - Windows 명령줄 한도(32,767자)와 POSIX ARG_MAX 에 여유를 두고 훨씬 먼저 전환한다.
 */
export const PATHSPEC_STDIN_MIN_CHARS = 16 * 1024;

/**
 * stage 대상 파일 수에 맞는 `git add` 전역 설정 인자를 만든다.
 * - `core.bigFileThreshold=1` 이면 1바이트를 넘는 일반 파일이 bulk-checkin 경로로 가서
 *   loose object 수만 개 대신 pack 하나에 스트리밍 기록된다(git 1.8 부터 있는 대용량 파일 경로).
 * - clean/smudge 필터·CRLF 변환 대상 파일은 git 이 스스로 일반 경로로 처리하므로 결과 트리는 같다.
 * - 이 설정은 `GIT_CONFIG_PARAMETERS` 로 자식 프로세스에도 상속되므로, hook 을 실행하는
 *   `git commit` 등에는 절대 붙이지 말고 `git add` 프로세스에만 사용해야 한다
 *   (diff 는 이 크기를 넘는 파일을 binary 로 취급하기 때문).
 * @param expectedFileCount 호출부가 아는 stage 대상 파일 수. 모르면 undefined
 * @returns 대량이면 `-c core.bigFileThreshold=1`, 아니면 빈 배열
 */
export function bulkCheckinConfigArgs(
  expectedFileCount: number | undefined
): string[] {
  return (expectedFileCount ?? 0) >= BULK_CHECKIN_MIN_FILES
    ? ["-c", "core.bigFileThreshold=1"]
    : [];
}

/**
 * 경로 목록을 argv 대신 stdin(`--pathspec-from-file=-`)으로 넘겨야 하는지 판단한다.
 * - 경로 수가 많거나 총 길이가 길면 OS 명령줄 한도(E2BIG, Windows 32K)에 걸릴 수 있다.
 * @param paths git 에 넘길 저장소 상대 경로 목록
 * @returns stdin pathspec 을 써야 하면 true
 */
export function shouldPassPathspecsViaStdin(paths: readonly string[]): boolean {
  if (paths.length >= PATHSPEC_STDIN_MIN_PATHS) {
    return true;
  }
  let chars = 0;
  for (const value of paths) {
    chars += value.length + 1;
    if (chars >= PATHSPEC_STDIN_MIN_CHARS) {
      return true;
    }
  }
  return false;
}

/**
 * bucket 하나의 파일 수로 +/- 라인 통계를 계산할지 판단한다.
 * @param fileCount staged 또는 unstaged 목록 길이
 * @returns 통계를 계산해도 되는 크기면 true
 */
export function shouldComputeLineStats(fileCount: number): boolean {
  return fileCount <= LINE_STATS_MAX_FILES;
}

/**
 * blob 끼리 비교하는 diff(`--cached`, ref..ref)에서 대용량 파일을 binary 로 취급하게 하는 설정 인자.
 * - git 은 `core.bigFileThreshold` 를 넘는 blob 을 크기만 보고 binary 로 판정해 내용을 읽지 않는다.
 * - 작업트리와 비교하는 diff 에 쓸 때는 먼저 largeFileExcludePathspecs 로 상한을 넘는 작업트리
 *   파일을 빼야 한다. 그대로 두면 작업트리 쪽 해시를 계산할 때 임계값을 넘는 파일이 pack 압축
 *   경로로 가서 오히려 몇 배 느려진다. 제외 뒤에는 index 쪽 대용량 blob(삭제·축소된 파일)만 크기로 판정된다.
 * @returns `-c core.bigFileThreshold=<LINE_STATS_MAX_FILE_BYTES>`
 */
export function blobDiffSizeLimitArgs(): string[] {
  return ["-c", `core.bigFileThreshold=${LINE_STATS_MAX_FILE_BYTES}`];
}

/**
 * 작업트리 diff 에서 대용량 파일을 빼는 pathspec 인자를 만든다.
 * - `:(exclude,literal)` 로 대괄호·`*` 가 든 이름도 정확히 그 파일만 제외한다.
 * @param largePaths 제외할 저장소 상대 경로(크기 상한 초과 파일)
 * @returns 제외할 파일이 없으면 빈 배열, 있으면 `-- . :(exclude,literal)<path>...`
 */
export function largeFileExcludePathspecs(largePaths: readonly string[]): string[] {
  return largePaths.length
    ? ["--", ".", ...largePaths.map((value) => `:(exclude,literal)${value}`)]
    : [];
}

/**
 * VS Code `diffEditor.maxFileSize` 설정값(MB)으로 diff 미리보기 크기 상한(byte)을 계산한다.
 * - 0 이하(무제한)나 잘못된 값이어도 gitExec 버퍼 상한을 넘지 않는다.
 * @param maxFileSizeMb 설정값(MB). 모르면 undefined
 * @returns 미리보기로 읽을 최대 byte 수
 */
export function diffPreviewLimitBytes(maxFileSizeMb: number | undefined): number {
  const mb =
    typeof maxFileSizeMb === "number" && Number.isFinite(maxFileSizeMb)
      ? maxFileSizeMb
      : DEFAULT_DIFF_MAX_FILE_SIZE_MB;
  return mb > 0
    ? Math.min(Math.floor(mb * 1024 * 1024), DIFF_PREVIEW_HARD_MAX_BYTES)
    : DIFF_PREVIEW_HARD_MAX_BYTES;
}
