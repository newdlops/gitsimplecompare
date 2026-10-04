import { spawn, type ExecFileException } from "node:child_process";
import { GitError } from "./gitError";
import { beginGitExecution } from "./gitExecutionDiagnostics";
import { gitCommandPolicy } from "./gitCommandPolicy";
import { gitProcesses } from "./gitProcessRegistry";
import type { RunGitOptions, GitInput } from "./gitExec";

/** 설정 계층이 Git 조회 제한 시간만 주입하는 순수 실행 정책 경계다. */
export type GitReadTimeoutResolver = (cwd: string) => number;
let timeoutResolver: GitReadTimeoutResolver | undefined;

/** 저장소별 설정 연결을 해제할 때 더 최근 등록을 유지한다. */
export function setGitReadTimeoutResolver(resolver: GitReadTimeoutResolver): () => void {
  timeoutResolver = resolver;
  return () => { if (timeoutResolver === resolver) timeoutResolver = undefined; };
}

/** 원본 바이트 출력은 Buffer로 유지하고 텍스트 변환은 공개 실행기가 맡는다. */
export interface GitProcessOutput { stdout: Buffer; stderr: Buffer }

/**
 * 문자열·Buffer·stdin·stream이 공유하는 소유권 기반 Git 실행기.
 * @param executable Git 실행 파일. 셸을 사용하지 않는다.
 * @param args 실제 인자 배열. 조회 판정 외에 로그로 출력하지 않는다.
 * @param cwd 저장소/호출의 작업 디렉터리
 * @param options 환경·취소·버퍼·조회 제한 정책
 * @param input stdin으로 끝까지 보낼 선택 입력
 * @param onData 존재하면 stdout을 모으지 않고 스트림으로 소비한다.
 * @returns close 확인 뒤 성공 출력 또는 GitError
 */
export function executeGitProcess(executable: string, args: string[], cwd: string, options: RunGitOptions,
  input?: GitInput, onData?: (chunk: Buffer) => void): Promise<GitProcessOutput> {
  return new Promise((resolve, reject) => {
    const policy = gitCommandPolicy(args);
    if (options.signal?.aborted) { reject(executionError("ABORT_ERR", "Git command cancelled.")); return; }
    if (policy.readOnly && gitProcesses.hasBlockedRead(cwd)) {
      reject(executionError("GIT_READ_STOPPING", "A previous Git read is still stopping. See Git Simple Compare Output.")); return;
    }
    const timeout = options.readTimeoutMs ?? timeoutResolver?.(cwd) ?? 30_000;
    const group = policy.readOnly && process.platform !== "win32";
    const timing = beginGitExecution(args, cwd, executable);
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: group, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : undefined });
    timing?.spawnReturned();
    const id = gitProcesses.register(child, cwd, policy.command, policy.readOnly, group, policy.monitor);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outSize = 0, errSize = 0, failure: unknown, closed = false;
    const limit = options.maxBuffer ?? 128 * 1024 * 1024;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    /** 실패·취소를 한 번만 기록한다. 쓰기는 호출자가 명시한 취소 때만 기존처럼 TERM한다. */
    const stop = (error: unknown, reason: string) => {
      failure ??= error;
      if (policy.readOnly) void gitProcesses.requestStop(id, reason);
      else if (!closed) child.kill("SIGTERM");
    };
    /** 소비자 취소를 실제 실행 수명에 연결하고 추가 재시도를 차단한다. */
    const abort = () => stop(executionError("ABORT_ERR", "Git command cancelled."), "consumer-released");
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (onData) { try { onData(chunk); } catch (error) { stop(error, "stream-consumer-failed"); } return; }
      outSize += chunk.length;
      if (outSize > limit) { stop(executionError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "Git stdout exceeded maxBuffer."), "max-buffer"); return; }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      const errorLimit = onData ? 64 * 1024 : limit;
      if (errSize <= errorLimit) stderr.push(chunk);
      else if (!onData) stop(executionError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "Git stderr exceeded maxBuffer."), "max-buffer");
    });
    child.stdout!.on("error", error => stop(error, "stdout-error"));
    child.stderr!.on("error", error => stop(error, "stderr-error"));
    child.once("error", error => { failure ??= new GitError(`git ${policy.command} failed: ${error.message}`, "", "", error as ExecFileException); });
    child.once("close", async (code, signal) => {
      closed = true;
      clearTimeout(deadline); options.signal?.removeEventListener("abort", abort);
      await gitProcesses.closed(id);
      timing?.finish(failure || code !== 0 ? "error" : "success", failure instanceof GitError ? failure.code : code ?? undefined);
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      if (failure instanceof GitError) reject(new GitError(failure.message, err.toString("utf8"), out.toString("utf8"), failure.cause as ExecFileException));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new GitError(`git ${policy.command} failed (${code ?? signal}): ${err.toString("utf8").trim() || out.toString("utf8").trim()}`, err.toString("utf8"), out.toString("utf8"),
        Object.assign(new Error("Git process failed."), { code: code ?? undefined, signal: signal ?? undefined, killed: !!signal })));
      else resolve({ stdout: out, stderr: err });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (policy.readOnly && Number.isFinite(timeout) && timeout > 0) {
      deadline = setTimeout(() => stop(executionError("ETIMEDOUT", "Git read exceeded its time limit. See Git Simple Compare Output."), "read-timeout"), timeout);
      deadline.unref();
    }
    if (input !== undefined && child.stdin) { child.stdin.on("error", () => undefined); child.stdin.end(input); }
  });
}

/** 자동 재시도 가능한 자원 오류와 취소·시간 초과를 구분할 GitError를 만든다. */
function executionError(code: string, message: string): GitError {
  return new GitError(message, "", "", Object.assign(new Error(message), { code, killed: true }));
}
