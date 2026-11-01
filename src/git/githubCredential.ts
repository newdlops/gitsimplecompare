// gh의 인증 출처를 유지하며 토큰은 논리 조회 하나의 메모리 lease에만 보관한다.
import { createHmac, randomBytes } from "node:crypto";
import { resolveGhExecutable } from "./ghCli";
import { runManagedGhRead } from "./ghManagedRead";
import { SharedGitRead } from "./sharedGitRead";
import { GitHubApiError } from "./githubApiError";
import { snapshotGitHubEnvironment } from "./githubReadContext";

export interface GitHubCredentialLease {
  /** 실제 토큰의 activation-local HMAC. 캐시 경계 전용이며 로그에 출력하지 않는다. */
  readonly key: string;
  readonly elapsedMs: number;
  authorization(): string;
}
type TokenLookup = (root: string, env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<string>;

/** 전용 adapter만 원문 stdout을 소유한다. 실패 출력·cause는 상위 오류로 전달하지 않는다. */
async function lookupToken(root: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const executable = await resolveGhExecutable(env, root);
  signal.throwIfAborted();
  return runManagedGhRead(executable, ["auth", "token", "--hostname", "github.com"], root,
    { env, signal, maxBufferBytes: 64 * 1024, operation: "read-credential" });
}

/** 동시 진행 lookup만 공유하고 완료 토큰을 다음 논리 조회에 재사용하지 않는다. */
export class GitHubCredentialProvider {
  private readonly secret = randomBytes(32);
  private readonly pending = new Map<string, SharedGitRead<GitHubCredentialLease>>();
  private disposed = false;
  constructor(private readonly lookup: TokenLookup = lookupToken) {}

  /**
   * 고정 환경의 GH_TOKEN→GITHUB_TOKEN→gh 저장 인증 순서로 새 lease를 만든다.
   * @param root 명령 실행 위치, env 고정 환경, signal 소비자별 취소, timeoutMs 남은 첫 요청 예산
   * @returns 모든 페이지가 공유할 불변 lease. 다른 소비자의 취소는 조회를 중단하지 않는다.
   */
  async acquire(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 30_000): Promise<GitHubCredentialLease> {
    signal?.throwIfAborted();
    if (this.disposed) throw new DOMException("GitHub credentials disposed.", "AbortError");
    const started = Date.now();
    const captured = snapshotGitHubEnvironment(env);
    if (captured.GH_HOST && captured.GH_HOST.toLowerCase() !== "github.com") throw new GitHubApiError("auth", "read-credential");
    const token = captured.GH_TOKEN || captured.GITHUB_TOKEN;
    if (token) return this.lease(token, started);
    const key = createHmac("sha256", this.secret).update(JSON.stringify([root, Object.entries(captured).sort()])).digest("hex");
    let reader = this.pending.get(key);
    if (!reader) {
      const owned = new SharedGitRead<GitHubCredentialLease>(async ownedSignal => {
        const timeout = new AbortController();
        const abort = () => timeout.abort();
        ownedSignal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 30_000);
        try {
          if (ownedSignal.aborted) timeout.abort();
          const result = await this.lookup(root, captured, timeout.signal);
          timeout.signal.throwIfAborted();
          return this.lease(result.trim(), started);
        } catch {
          if (ownedSignal.aborted) throw new DOMException("GitHub credential lookup cancelled.", "AbortError");
          throw new GitHubApiError(timeout.signal.aborted ? "timeout" : "auth", "read-credential");
        } finally {
          clearTimeout(timer); ownedSignal.removeEventListener("abort", abort);
          if (this.pending.get(key) === owned) this.pending.delete(key);
        }
      }, value => value);
      reader = owned; this.pending.set(key, reader);
    }
    const consumer = new AbortController();
    const abort = () => consumer.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, Math.min(30_000, timeoutMs)));
    try {
      if (signal?.aborted) consumer.abort();
      return await reader.read({ signal: consumer.signal, maxCacheAgeMs: 0 });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("GitHub credential lookup cancelled.", "AbortError");
      if (consumer.signal.aborted) throw new GitHubApiError("timeout", "read-credential");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  /** 새 활성화가 이전 pending lookup과 토큰 참조를 물려받지 않도록 실제 종료까지 기다린다. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.pending.values()].map(reader => reader.dispose()));
    this.pending.clear();
  }

  /** 토큰 원문을 열거 가능한 프로퍼티에 두지 않고 헤더 생성 순간에만 반환한다. */
  private lease(token: string, started: number): GitHubCredentialLease {
    if (!token || /[\r\n\x00]/.test(token)) throw new GitHubApiError("auth", "read-credential");
    const key = createHmac("sha256", this.secret).update("github.com\0").update(token).digest("hex");
    return Object.freeze({ key, elapsedMs: Date.now() - started, authorization: () => `Bearer ${token}` });
  }
}
