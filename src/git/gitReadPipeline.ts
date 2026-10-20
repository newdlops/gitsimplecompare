// 기존 소유 실행기를 연결하는 읽기 전용 transport. 실제 spawn·환경·deadline·process-group 정리는 공통 실행기가 맡는다.
import { PassThrough } from "node:stream";
import { GitError } from "./gitError";
import { gitCommandPolicy } from "./gitCommandPolicy";
import { executeGitProcess, resolveGitReadTimeout } from "./gitProcessRunner";
import type { RunGitOptions } from "./gitExec";

/** 내부 pipe의 readable/writable 양쪽에 각각 적용되는 기본 high-water mark다. */
const PIPE_HIGH_WATER_MARK = 64 * 1024;

/**
 * 두 조회를 한 소유 범위에서 실행하고 byte pipe의 backpressure로 Node 메모리를 제한한다.
 * - producer 성공/close가 확인된 후에만 EOF를 전달해 부분 출력 뒤 실패를 성공으로 바꾸지 않는다.
 * - consumer 종료/취소/출력 파서 오류는 producer도 회수한다. 쓰기 명령은 시작 전에 거부한다.
 * - 역압으로 서로 기다리는 시간을 중복 제한하지 않도록 기존 두 조회의 합산 deadline을 적용한다.
 * @param executable 두 조회에 고정할 Git 실행 파일 @param sourceArgs 원본 byte 조회
 * @param targetArgs stdin을 끝까지 소비하는 metadata 조회 @param cwd 저장소 루트
 * @param onData target 출력의 동기 소비자 @param options 공통 환경·취소·시간 제한
 * @returns 두 자식과 그 소유 후손의 close가 끝난 뒤 성공하거나 원래의 유효한 오류를 던진다.
 */
export async function executeGitReadPipeline(executable: string, sourceArgs: string[], targetArgs: string[], cwd: string,
  onData: (chunk: Buffer) => void, options: RunGitOptions): Promise<void> {
  if (!gitCommandPolicy(sourceArgs).readOnly || !gitCommandPolicy(targetArgs).readOnly) {
    throw new Error("Git read pipelines only accept read-only commands.");
  }
  const controller = new AbortController(), bridge = new PassThrough({ highWaterMark: PIPE_HIGH_WATER_MARK });
  // 한 자식의 spawn 이전에도 반대쪽이 실패할 수 있으므로 transport error에 항상 소비자가 있다.
  bridge.on("error", () => undefined);
  const abort = () => { controller.abort(); bridge.destroy(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const readTimeoutMs = resolveGitReadTimeout(cwd, options.readTimeoutMs);
  const owned = { ...options, readTimeoutMs: readTimeoutMs * 2, signal: controller.signal };
  /** 첫 실패 때 형제 조회도 중단하되 caller는 아래 settlement에서 실제 양쪽 close를 기다린다. */
  const watch = <T>(pending: Promise<T>): Promise<T> => pending.catch(error => { abort(); throw error; });
  try {
    const target = watch(executeGitProcess(executable, targetArgs, cwd, owned, bridge, onData, undefined, true));
    const source = watch(executeGitProcess(executable, sourceArgs, cwd, owned, undefined, undefined, bridge, true).then(() => {
      if (!bridge.destroyed) bridge.end();
    }));
    const [sourceResult, targetResult] = await Promise.allSettled([source, target]);
    const sourceError = sourceResult.status === "rejected" ? sourceResult.reason : undefined;
    const targetError = targetResult.status === "rejected" ? targetResult.reason : undefined;
    // 파이프가 끊기며 생긴 부수 오류보다 실제 Git 실패/파서 오류/timeout을 우선 보존한다.
    if (sourceError && !secondaryPipeError(sourceError)) throw sourceError;
    if (targetError && !secondaryPipeError(targetError)) throw targetError;
    if (targetError) throw targetError;
    if (sourceError) throw sourceError;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    bridge.destroy();
  }
}

/** 형제 종료의 결과로 생긴 취소·닫힌 pipe 오류는 원래 실패의 진단을 덮어쓰지 않는다. */
function secondaryPipeError(error: unknown): boolean {
  return error instanceof GitError && ["ABORT_ERR", "GIT_READ_STOPPING", "GIT_PIPE_CLOSED", "GIT_INPUT_CLOSED", "EPIPE"].includes(String(error.code));
}
