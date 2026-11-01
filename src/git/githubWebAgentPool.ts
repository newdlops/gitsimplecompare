// HTML 응답/인증 판단은 공유하지 않고, 같은 정책·인증의 HTTPS Agent만 활성화 수명 안에서 빌려준다.
import { Agent } from "node:https";
import { createHmac, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { logInfo } from "../ui/outputLog";

interface Entry { agent: Agent; users: Map<Promise<void>, () => void>; timer?: ReturnType<typeof setTimeout>; }
interface Limits { maxEntries?: number; idleMs?: number; }
export interface GitHubWebAgentLease { agent: Agent; release(): void; }

/** origin은 github.com HTTPS로 고정한다. 모든 인증 key는 활성화별 HMAC이며 원문 header를 저장하지 않는다. */
export class GitHubWebAgentPool {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private readonly closing = new Set<Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly limits: Limits = {}) {}

  /**
   * 같은 정책/인증의 Agent를 빌리고 사용 완료 때 release로 반환한다.
   * @param headers 현재 요청의 인증 header, policy 고정 네트워크 정책, signal 대기 소비자의 취소
   * @returns 문맥별 요청 취소와 독립적인 socket pool lease. 바쁜 다른 계정은 상한 내에서 기다린다.
   */
  async acquire(headers: Record<string, string>, policy: string, signal: AbortSignal, cancel: () => void = () => {}): Promise<GitHubWebAgentLease> {
    const auth = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
      .filter(([key]) => key === "authorization" || key === "cookie").sort(([a], [b]) => a.localeCompare(b));
    const key = createHmac("sha256", this.secret).update(JSON.stringify(["https://github.com", policy, auth])).digest("hex");
    for (;;) {
      signal.throwIfAborted();
      if (this.disposed) throw new DOMException("GitHub HTML pool disposed.", "AbortError");
      let entry = this.entries.get(key);
      if (!entry && this.entries.size >= (this.limits.maxEntries ?? 8)) {
        const idle = [...this.entries].find(([, value]) => value.users.size === 0);
        if (idle) this.remove(idle[0], idle[1]);
        else { await this.wait(signal); continue; }
      }
      if (!entry) {
        entry = { agent: new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2, maxTotalSockets: 2 }), users: new Map() };
      }
      clearTimeout(entry.timer); this.entries.delete(key); this.entries.set(key, entry);
      let done!: () => void;
      const closed = new Promise<void>(resolve => { done = resolve; }); entry.users.set(closed, cancel);
      const owned = entry;
      let released = false;
      return { agent: entry.agent, release: () => {
        if (released) return;
        released = true; owned.users.delete(closed); done(); this.wake();
        if (!this.disposed && owned.users.size === 0 && this.entries.get(key) === owned) {
          owned.timer = setTimeout(() => this.remove(key, owned), this.limits.idleMs ?? 30_000); owned.timer.unref();
        }
      } };
    }
  }

  /** 모든 lease 요청의 실제 close와 idle socket 종료까지 기다린다. 이전 disposer는 새 pool을 건드리지 않는다. */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true; this.wake();
      const users = [...this.entries.values()].flatMap(entry => [...entry.users.keys()]);
      for (const entry of this.entries.values()) for (const cancel of entry.users.values()) cancel();
      for (const [key, entry] of this.entries) this.remove(key, entry);
      this.disposal = Promise.all([...this.closing, ...users]).then(() => undefined);
      logInfo("GitHub HTML connection pool disposed");
    }
    return this.disposal;
  }

  /** 상한 대기는 signal 취소/자원 반환/종료 중 하나로 풀리며 다른 소비자의 lease를 취소하지 않는다. */
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const wake = () => { this.waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
      this.waiters.add(wake); signal.addEventListener("abort", wake, { once: true }); if (signal.aborted) wake();
    });
  }

  /** 대기자는 다시 상한과 문맥을 검사하므로 여러 소비자를 깨워도 entry 상한을 넘지 않는다. */
  private wake(): void { for (const wake of [...this.waiters]) wake(); }

  /** idle 만료/LRU 제거와 전체 종료가 같은 실제 socket close 경로를 사용하게 한다. */
  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); clearTimeout(entry.timer);
    const sockets = new Set<Socket>([...Object.values(entry.agent.sockets), ...Object.values(entry.agent.freeSockets)].flatMap(values => values ?? []));
    const pending = Promise.all([...sockets].map(socket => socket.closed ? Promise.resolve()
      : new Promise<void>(resolve => { socket.once("close", () => resolve()); }))).then(() => undefined);
    this.closing.add(pending); pending.finally(() => this.closing.delete(pending));
    entry.agent.destroy(); this.wake();
  }
}

let pool = new GitHubWebAgentPool();

/** 검증된 직접 HTTPS 경로만 현재 활성화의 pool을 받는다. proxy/Host 관리 경로는 호출하지 않는다. */
export function gitHubWebAgentPool(): GitHubWebAgentPool { return pool; }

/** 네트워크 설정 변경과 새 활성화마다 pool을 교체하고 이전 소유 자원을 즉시 닫는다. */
export function beginGitHubWebAgentLifetime(): () => Promise<void> {
  const previous = pool; pool = new GitHubWebAgentPool();
  const owned = pool, closed = previous.dispose();
  return async () => { await Promise.all([closed, owned.dispose()]); };
}
