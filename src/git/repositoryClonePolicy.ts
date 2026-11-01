// 선택형 blobless clone의 보수적인 Git/native 접근 preflight를 담당한다. 앱 OAuth를 받지 않는다.
import path from "node:path";
import type { RunGitOptions } from "./gitExec";
import type { SetupGitRunner } from "./repositorySetupService";

export type RepositoryCloneMode = "full" | "blobless";
export interface RepositoryClonePolicy {
  mode: RepositoryCloneMode;
  reason: "default" | "protocol" | "git-version" | "native-access" | "native-access-unavailable" | "probe-timeout";
  probeMs: number;
}

/**
 * Git 2.46+와 5초 안에 native 자격 증명으로 접근할 수 있는 HTTP(S)에만 전체-history 필터를 허용한다.
 * @param source 검증된 원본, probeDirectory 이번 clone이 소유한 빈 디렉터리, requested 시작 때 고정한 선택
 * @param execute 공통 Git 경계, clearEnv 외부 저장소 metadata 제거 목록, signal 사용자 취소
 * @returns 실제 clone에 적용할 모드와 비민감 fallback 사유. default/local/SSH에는 probe를 추가하지 않는다.
 */
export async function selectRepositoryClonePolicy(source: string, probeDirectory: string, requested: RepositoryCloneMode,
  execute: SetupGitRunner, clearEnv: readonly string[], signal?: AbortSignal): Promise<RepositoryClonePolicy> {
  if (requested === "full") return { mode: "full", reason: "default", probeMs: 0 };
  if (!/^https?:\/\//i.test(source)) return { mode: "full", reason: "protocol", probeMs: 0 };
  if (path.dirname(probeDirectory).includes(path.delimiter)) return { mode: "full", reason: "native-access-unavailable", probeMs: 0 };
  signal?.throwIfAborted();
  const started = Date.now(), deadline = started + 5_000, controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5_000);
  if (signal?.aborted) abort();
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  // 빈 destination에서 부모 저장소의 local config를 읽지 않아 이후 hydration에도 없는 인증을 오인하지 않는다.
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "", SSH_ASKPASS: "",
    GIT_CEILING_DIRECTORIES: path.dirname(probeDirectory) });
  /** 각 native 조회가 동일 환경과 남은 전체 마감만 사용하도록 옵션을 만든다. */
  const options = (): RunGitOptions => ({ env, inheritEnv: false, clearEnv, signal: controller.signal,
    retryOnLock: false, githubProactiveAuth: false, readTimeoutMs: Math.max(1, deadline - Date.now()) });
  /** 측정한 probe 시간과 민감하지 않은 모드/사유만 호출자에게 반환한다. */
  const policy = (mode: RepositoryCloneMode, reason: RepositoryClonePolicy["reason"]): RepositoryClonePolicy => ({ mode, reason, probeMs: Date.now() - started });
  try {
    const version = await execute(["version"], probeDirectory, options());
    controller.signal.throwIfAborted();
    if (!supportsBloblessClone(version)) return policy("full", "git-version");
    await execute(["ls-remote", "--exit-code", "--heads", "--", source], probeDirectory, options());
    controller.signal.throwIfAborted();
    return policy("blobless", "native-access");
  } catch {
    signal?.throwIfAborted();
    return policy("full", controller.signal.aborted || Date.now() >= deadline ? "probe-timeout" : "native-access-unavailable");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
}

/** vendor 접미사가 있는 공식 Git version 출력에서 보수적인 2.46 floor를 확인한다. */
function supportsBloblessClone(output: string): boolean {
  const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/m.exec(output);
  return !!match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 46);
}
