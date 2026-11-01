// gh와 같은 ssh -G 해석으로 SSH 별칭을 풀되 연결·인증은 시작하지 않는다.
import { runManagedGhRead } from "./ghManagedRead";
import { logInfo } from "../ui/outputLog";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** selector가 고정한 환경·취소 경계를 SSH 설정 평가에도 전달한다. */
interface SshHostOptions { env?: NodeJS.ProcessEnv; signal?: AbortSignal; }

/**
 * OpenSSH가 실제 적용하는 Include/Host/Match/HostName을 오프라인으로 평가한다.
 * @param hostname 원격 URL의 hostname, cwd 저장소 루트, options 고정 환경과 사용자 취소
 * @param execute 소유 CLI의 출력 상한·프로세스 그룹·실제 close를 보장하는 외부 실행 경계
 * @returns 검증한 hostname. 평가 실패/3초 초과는 undefined로 gh와 같은 원래 host 경로를 보존한다.
 */
export async function resolveSshRemoteHost(hostname: string, cwd: string, options: SshHostOptions = {},
  execute: typeof runManagedGhRead = runManagedGhRead): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  if (!/^[a-z0-9_][a-z0-9_.-]*$/i.test(hostname)) return undefined;
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false;
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 3_000);
  if (options.signal?.aborted) abort();
  try {
    const env = { ...(options.env ?? process.env) }, executable = await sshExecutable(env);
    options.signal?.throwIfAborted();
    if (!executable || controller.signal.aborted) return undefined;
    const output = await execute(executable, ["-G", hostname], cwd, { env,
      signal: controller.signal, operation: "ssh-host-resolve", maxBufferBytes: 1_048_576 });
    options.signal?.throwIfAborted();
    const resolved = /^hostname[ \t]+([^\r\n\s]+)[ \t]*$/im.exec(output)?.[1];
    if (!resolved || !/^[a-z0-9_][a-z0-9_.-]*$/i.test(resolved)) return undefined;
    const host = resolved.toLowerCase();
    return host === "ssh.github.com" ? "github.com" : host;
  } catch {
    options.signal?.throwIfAborted();
    logInfo("SSH remote host resolution skipped", { reason: timedOut ? "timeout" : "unavailable" });
    return undefined;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort(); }
}

/**
 * PATH의 절대 디렉터리에서만 SSH를 찾아 저장소가 제공하는 상대 실행 파일을 시작하지 않는다.
 * @param env 요청 때 고정한 환경. 원본이나 전역 PATH는 변경하지 않는다.
 * @returns 실행 가능한 일반 SSH 파일의 절대 경로. 안전한 후보가 없으면 undefined
 */
async function sshExecutable(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "ssh.exe" : "ssh");
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* 다음 절대 PATH 후보만 확인한다. */ }
  }
  return undefined;
}
