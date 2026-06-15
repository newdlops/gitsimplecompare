// GitHub CLI 실행을 담당하는 저수준 래퍼.
// - PR 목록/상세 서비스가 gh 실행 방식을 공유하고, 각 서비스는 데이터 해석에만 집중하게 한다.
import { execFile } from "node:child_process";

const GH_RETRY_DELAYS_MS = [250, 500, 900, 1400];

/**
 * gh CLI 를 실행하고 stdout 문자열을 반환한다.
 * @param args gh 에 전달할 인자 목록
 * @param cwd  gh 를 실행할 저장소 루트
 * @returns gh stdout 전체
 */
export async function runGh(args: string[], cwd: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGhOnce(args, cwd);
    } catch (error) {
      if (!isTransientSpawnError(error) || attempt >= GH_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(GH_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** gh 명령 한 번을 실행한다. spawn 계열 재시도는 runGh 가 담당한다. */
function runGhOnce(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`) as Error & { code?: unknown };
        wrapped.code = (error as Error & { code?: unknown }).code;
        reject(wrapped);
        return;
      }
      resolve(stdout);
    });
  });
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
