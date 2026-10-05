import { spawn } from "node:child_process";
import { GitProcessRegistry } from "./gitProcessRegistry";
import { logInfo } from "../ui/outputLog";
import type { RunGhOptions } from "./ghCli";

/** Git 조회 기록과 분리해 GitHub HTTP 대기가 Git 유휴 정리를 막지 않게 한다. */
const reads = new GitProcessRegistry();
reads.setLogger((event, detail) => logInfo(event.replace(/^git /, "GitHub "), detail));
process.once("exit", () => reads.stopOnHostExit());

/** 기존 gh 오류 정규화가 stdout/stderr와 spawn 오류 코드를 그대로 처리할 수 있는 경계다. */
export class ManagedGhError extends Error {
  constructor(message: string, readonly code: unknown, readonly stdout: string, readonly stderr: string) {
    super(message);
  }
}

/**
 * 소유한 조회 CLI만 별도 프로세스 그룹에서 실행하고 자손 close 확인까지 기다린다.
 * @param options 취소 신호·요청 당시 환경·각 출력 스트림의 byte 상한
 * @returns 성공 stdout. 취소·버퍼 초과도 실제 종료 뒤 오류로 전달해 슬롯 회수를 안전하게 한다.
 */
export function runManagedGhRead(executable: string, args: readonly string[], cwd: string, options: RunGhOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new ManagedGhError("GitHub query cancelled.", "ABORTED", "", ""));
  return new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(executable, [...args], { cwd, env: options.env, detached: group, stdio: ["ignore", "pipe", "pipe"] });
    const id = reads.register(child, cwd, options.operation || "read", true, group);
    const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const maximum = options.maxBufferBytes ?? 32 * 1024 * 1024;
    let failure: (Error & { code?: unknown }) | undefined;
    /** 출력 상한을 지키며 초과한 조회만 종료하고, UTF-8 문자가 청크 경계에서 깨지지 않게 보관한다. */
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, maximum - sizes[stream]);
      if (remaining) buffers[stream].push(chunk.subarray(0, remaining));
      sizes[stream] += chunk.length;
      if (sizes[stream] > maximum && !failure) {
        failure = Object.assign(new Error(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        void reads.requestStop(id, "output-limit");
      }
    };
    const abort = () => {
      failure = Object.assign(new Error("GitHub query cancelled."), { code: "ABORTED" });
      void reads.requestStop(id, "consumer-cancelled");
    };
    child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", error => { failure ||= error; });
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      void reads.closed(id).then(() => {
        const stdout = Buffer.concat(buffers.stdout).toString("utf8");
        const stderr = Buffer.concat(buffers.stderr).toString("utf8");
        if (failure || code !== 0) reject(new ManagedGhError(failure?.message || `GitHub CLI exited with ${signal || code}.`, failure?.code ?? code, stdout, stderr));
        else resolve(stdout);
      }, reject);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
