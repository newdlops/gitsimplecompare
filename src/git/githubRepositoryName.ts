// 같은 원격·서버·인증 문맥에서 저장소 이름을 재사용하며 소비자 취소를 독립적으로 처리한다.
import { runGit } from "./gitExec";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { gitHubReadContext, snapshotGitHubEnvironment } from "./githubReadContext";
import { SharedGitRead } from "./sharedGitRead";

interface CachedName { key: string; name?: string; readers: Map<GhExecute, SharedGitRead<string>>; }
const cache = new Map<string, CachedName>();
const active = new Set<SharedGitRead<string>>();

/**
 * 원격 설정과 gh 문맥이 같으면 성공한 owner/name만 재사용한다.
 * @param options 소비자별 취소 신호·요청 환경·관찰용 작업 이름
 * @returns owner/name. 진행 조회는 같은 실행 함수끼리 공유해 wrapper가 가진 취소 신호를 격리한다.
 */
export async function readGitHubRepositoryName(repoRoot: string, runner: GhExecute, options: GhRunnerOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const env = snapshotGitHubEnvironment(options.env);
  const gitEnv = Object.fromEntries(Object.entries(env).filter((item): item is [string, string] => typeof item[1] === "string"));
  const remote = await runGit(["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], repoRoot,
    { signal: options.signal, env: gitEnv }).catch(() => { options.signal?.throwIfAborted(); return undefined; });
  options.signal?.throwIfAborted();
  const key = JSON.stringify([remote, gitHubReadContext(repoRoot, env, ["repo", "view"])]);
  let entry = remote === undefined ? undefined : cache.get(repoRoot);
  if (!entry || entry.key !== key) {
    entry = { key, readers: new Map() };
    if (remote !== undefined) {
      cache.delete(repoRoot); cache.set(repoRoot, entry);
      // 진행 소비자는 보호하고 성공 캐시만 LRU 상한으로 정리한다.
      for (const [root, item] of cache) if (cache.size > 128 && !item.readers.size) cache.delete(root);
    }
  }
  if (entry.name) return entry.name;
  let reader = entry.readers.get(runner);
  if (!reader) {
    const owned = entry;
    reader = new SharedGitRead<string>(async signal => {
      try {
        const out = await runner(["repo", "view", "--json", "nameWithOwner"], repoRoot, { ...options, env, signal });
        signal.throwIfAborted();
        const name = (JSON.parse(out) as { nameWithOwner?: string }).nameWithOwner || "";
        if (typeof name !== "string") throw new Error("GitHub repository name is invalid.");
        if (name && cache.get(repoRoot) === owned) owned.name = name;
        return name;
      } finally {
        if (owned.readers.get(runner) === reader) owned.readers.delete(runner);
        active.delete(reader!);
      }
    }, value => value);
    entry.readers.set(runner, reader); active.add(reader);
  }
  return reader.read({ signal: options.signal, maxCacheAgeMs: 0 });
}

/** 인증 변경·확장 종료 때 캐시를 비우고 소유한 진행 조회를 취소한다. 늦은 완료는 재삽입하지 않는다. */
export function clearGitHubRepositoryNameCache(): void {
  cache.clear();
  for (const reader of active) void reader.dispose().catch(() => undefined);
}
