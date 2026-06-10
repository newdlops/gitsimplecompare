// git CLI 를 실제로 실행하는 저수준 래퍼 모듈.
// - 여러 git 서비스(GitService, GitLogService 등)가 공유하는 단일 실행 지점이다.
//   execFile 로 셸을 거치지 않아 인자 이스케이프 문제가 없다.
import { execFile } from "node:child_process";

/** git 명령 실행 중 발생한 오류를 식별하기 위한 전용 에러 타입 */
export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * git 명령을 실행하고 표준 출력을 문자열로 반환한다.
 * - 대용량 출력(git show / git log 전체)도 받을 수 있도록 버퍼 한도를 넉넉히 둔다.
 * - 실패 시 GitError 로 감싸 던진다(호출부가 종류를 구분할 수 있게).
 * - env 를 주면 기존 환경에 덮어써 실행한다(예: GIT_EDITOR=true 로 에디터 우회).
 * @param args git 인자 배열
 * @param cwd  실행 디렉터리(저장소 경로)
 * @param env  추가/덮어쓸 환경변수(선택)
 */
export function runGit(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 128 * 1024 * 1024, // 128MB
        windowsHide: true,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitError(`git ${args.join(" ")} 실패: ${error.message}`, stderr)
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}
