// Git 설정 원본을 한 번 조회한 뒤 파일 버전으로 remote 문맥을 확인해 warm 조회의 Git spawn을 없앤다.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./gitExec";
import { gitHubReadContext, gitRepositoryContextFiles } from "./githubReadContext";
import { SharedGitRead } from "./sharedGitRead";
import { logInfo } from "../ui/outputLog";

interface RemoteContext { key: string; }
interface Probe { key: string; files: readonly string[]; read: SharedGitRead<RemoteContext>; }
const cache = new Map<string, Probe>();
const active = new Set<SharedGitRead<RemoteContext>>();
let lifetime = 0;

/**
 * 모든 설정 origin/include와 인증·환경·HEAD 경계를 확인해 저장소 이름 캐시용 문맥을 반환한다.
 * @param root 실행 루트, env 요청 시 복사한 환경, signal 현재 소비자만 취소할 신호
 * @returns remote 값과 설정 파일 버전의 불투명 키. 관찰 불가/실행 실패는 캐시를 생략한다.
 */
export async function readGitHubRemoteContext(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const epoch = lifetime;
  for (;;) {
    const previous = cache.get(root);
    const files = previous?.files ?? [];
    const context = await gitHubReadContext(root, env, ["repo"], files);
    signal?.throwIfAborted();
    if (epoch !== lifetime) throw new DOMException("Repository context cancelled.", "AbortError");
    // 다른 소비자가 첫 origin 목록을 준비했으면 그 목록으로 다시 검증하고 중복 Git을 피한다.
    if (cache.get(root) !== previous || (previous && previous.files !== files)) continue;
    let entry = previous;
    if (!entry || entry.key !== context) {
      const owned: Probe = { key: context, files, read: undefined! };
      owned.read = new SharedGitRead(async ownedSignal => {
        const started = Date.now();
        const gitEnv = Object.fromEntries(Object.entries(env).filter((item): item is [string, string] => typeof item[1] === "string"));
        try {
          const output = await runGit(["config", "--null", "--show-origin", "--list"], root, { env: gitEnv, signal: ownedSignal });
          ownedSignal.throwIfAborted();
          const parsed = configSources(output, root, env);
          const observedFiles = [...new Set([...await gitRepositoryContextFiles(root, env), ...parsed.files])].sort();
          const finalContext = await gitHubReadContext(root, env, ["repo"], observedFiles);
          ownedSignal.throwIfAborted();
          const stable = parsed.cacheable && context === await gitHubReadContext(root, env, ["repo"], files)
            && await filesPredate(observedFiles, started);
          if (cache.get(root) === owned) {
            if (stable) { owned.files = observedFiles; owned.key = finalContext; }
            else cache.delete(root);
          }
          return { key: createHash("sha256").update(JSON.stringify([finalContext, parsed.remote, stable ? "stable" : Math.random()])).digest("hex") };
        } catch (error) {
          if (cache.get(root) === owned) cache.delete(root);
          throw error;
        } finally { active.delete(owned.read); }
      }, value => ({ ...value }));
      entry = owned; cache.delete(root); cache.set(root, entry); active.add(entry.read);
      for (const [key, item] of cache) if (cache.size > 128 && !item.read.hasConsumers()) cache.delete(key);
    } else {
      cache.delete(root); cache.set(root, entry);
      logInfo("GitHub repository config cache hit", { repoRoot: root });
    }
    return (await entry.read.read({ signal, maxCacheAgeMs: Number.POSITIVE_INFINITY })).key;
  }
}

/** 인증 초기화·확장 종료 때 진행 probe까지 정리하고 이전 수명의 늦은 등록을 막는다. */
export function clearGitHubRemoteContextCache(): void {
  lifetime++; cache.clear();
  for (const reader of active) void reader.dispose().catch(() => undefined);
}

/**
 * NUL로 분리된 Git config origin/값에서 실제 원본과 아직 비활성인 include 경로도 수집한다.
 * @returns remote 값과 관찰할 경로. 해석할 수 없는 경로 보간은 완료 캐시를 생략한다.
 */
function configSources(output: string, root: string, env: NodeJS.ProcessEnv): { files: string[]; remote: string[]; cacheable: boolean } {
  const parts = output.split("\0");
  const files: string[] = [], remote: string[] = [];
  let cacheable = true;
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const origin = parts[index];
    const record = parts[index + 1];
    const split = record.indexOf("\n");
    const key = split < 0 ? record : record.slice(0, split);
    const value = split < 0 ? "" : record.slice(split + 1);
    const source = origin.startsWith("file:") ? path.resolve(root, origin.slice(5)) : undefined;
    if (source) files.push(source);
    if (/^remote\..*\.(url|gh-resolved)$/i.test(key)) remote.push(record);
    if (/^include(?:if\..+)?\.path$/i.test(key)) {
      if (!source || value.includes("%(") || /^~[^/\\]/.test(value)) { cacheable = false; continue; }
      const expanded = /^~[/\\]/.test(value) ? path.join(env.HOME || env.USERPROFILE || "", value.slice(2)) : value;
      files.push(path.resolve(path.dirname(source), expanded));
    }
  }
  return { files, remote, cacheable };
}

/** 새로 발견한 include가 probe 도중 변경되지 않았음을 확인하며 실패·미래 시각은 캐시를 생략한다. */
async function filesPredate(files: readonly string[], started: number): Promise<boolean> {
  const stable = await Promise.all(files.map(async file => {
    if (process.platform === "win32" && /^NUL$/i.test(file)) return true;
    try {
      const value = await stat(file);
      return value.isCharacterDevice() || value.isDirectory() || Math.max(value.mtimeMs, value.ctimeMs) < started;
    } catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || ""); }
  }));
  return stable.every(Boolean);
}
