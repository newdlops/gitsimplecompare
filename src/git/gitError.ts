import type { ExecFileException } from "node:child_process";

/** Git 종료·실행 오류와 원본 출력을 보존해 조회 취소와 재시도를 구분한다. */
export class GitError extends Error {
  readonly code?: number | string;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;

  /** stderr/stdout은 호출자가 오류를 처리할 때만 사용하며 수명 로그에는 기록하지 않는다. */
  constructor(message: string, public readonly stderr: string, public readonly stdout = "", cause?: ExecFileException) {
    super(message, { cause });
    this.name = "GitError";
    this.code = cause?.code ?? undefined;
    this.signal = cause?.signal;
    this.killed = cause?.killed;
  }
}

/** 취소·조회 제한·버퍼 초과·종료 대기는 캐시 fallback이나 재조회로 다시 실행하지 않는다. */
export function isGitLifecycleError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return ["ABORT_ERR", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "GIT_READ_STOPPING"].includes(String(code));
}
