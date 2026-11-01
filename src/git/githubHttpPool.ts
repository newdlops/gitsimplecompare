// 연결 문맥 수와 각 Agent의 socket 수를 제한하고 소비자 취소가 다른 요청을 파괴하지 않게 한다.
import { Agent } from "node:https";
interface Entry { agent: Agent; active: number; timer?: NodeJS.Timeout; retired?: boolean; }
export interface GitHubAgentLease { agent: Agent; release(): void; }

/** 최대 네 문맥을 보유하며 모두 사용 중이면 취소 가능한 대기열에서 기존 문맥 반환을 기다린다. */
export class GitHubHttpPool {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Set<() => void>();
  private disposed = false;
  constructor(private readonly idleMs = 60_000) {}

  /** origin·네트워크 세대·실제 인증으로 만든 불투명 key의 Agent를 독립 참조로 빌린다. */
  async acquire(key: string, signal?: AbortSignal): Promise<GitHubAgentLease> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.disposed) throw new DOMException("GitHub pool disposed.", "AbortError");
      let entry = this.entries.get(key);
      if (entry?.retired) throw new DOMException("GitHub pool context retired.", "AbortError");
      if (!entry && this.entries.size >= 4) {
        const idle = [...this.entries].find(([, value]) => !value.active);
        if (idle) this.remove(idle[0], idle[1]);
      }
      if (!entry && this.entries.size < 4) {
        entry = { agent: new Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8, maxFreeSockets: 4 }), active: 0 };
        this.entries.set(key, entry);
      }
      if (entry) {
        clearTimeout(entry.timer); entry.timer = undefined; entry.active++;
        const owned = entry; let released = false;
        return { agent: owned.agent, release: () => {
          if (released) return; released = true; owned.active--;
          if (!owned.active) {
            if (this.disposed || owned.retired) this.remove(key, owned);
            else { owned.timer = setTimeout(() => this.remove(key, owned), this.idleMs); owned.timer.unref(); }
          }
          for (const wake of [...this.waiters]) wake();
        } };
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => { this.waiters.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiters.delete(done); signal?.removeEventListener("abort", abort); reject(new DOMException("GitHub pool wait cancelled.", "AbortError")); };
        this.waiters.add(done); signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }

  /** 이전 계정의 idle socket을 닫고 사용 중인 문맥은 마지막 요청 반환 때 제거한다. */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { entry.retired = true; if (!entry.active) this.remove(key, entry); }
  }

  /** 소유 수명 종료는 진행 socket도 닫는다. 각 요청의 close가 전송/큐의 실제 종료를 확인한다. */
  dispose(): void {
    this.disposed = true;
    for (const [key, entry] of this.entries) this.remove(key, entry);
    for (const wake of [...this.waiters]) wake();
  }

  /** 동일 항목만 제거해 이전 idle timer가 새 문맥을 정리하지 못하게 한다. */
  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    clearTimeout(entry.timer); entry.agent.destroy(); this.entries.delete(key);
  }
}
