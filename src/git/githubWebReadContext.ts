// 한 suggested-changeset 조회의 URL/인증 공유, 동시 실행, 마감과 HTTPS 자원을 소유한다.
import { createHmac, randomBytes } from "node:crypto";
import { GitHubWebTransport, safeWebUrl } from "./githubWebTransport";
import { gitHubHttpCapability, type GitHubNetworkPolicy } from "./githubHttpPolicy";
import { PriorityReadQueue } from "../utils/priorityReadQueue";
import type { GitHubWebHtmlRead } from "./githubWebHtml";
import { logInfo } from "../ui/outputLog";

interface Transport {
  read(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<GitHubWebHtmlRead>;
  dispose(): Promise<void>;
  metrics?(): Record<string, number>;
}
interface Options {
  signal?: AbortSignal; deadline?: number; policy?: GitHubNetworkPolicy; env?: NodeJS.ProcessEnv; transport?: Transport;
}

/** 다음 조회와 인증 판단을 공유하지 않는 30초 수명의 보조 HTML context다. */
export class GitHubWebReadContext {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly queue = new PriorityReadQueue(2);
  private readonly secret = randomBytes(32);
  private readonly memo = new Map<string, Promise<GitHubWebHtmlRead>>();
  private readonly pending = new Set<Promise<GitHubWebHtmlRead>>();
  private readonly transport: Transport;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly started = Date.now();
  private readonly parent?: AbortSignal;
  private disposal?: Promise<void>;
  private requests = 0;
  private shared = 0;
  private active = 0;
  private maximumActive = 0;
  private readonly abort = () => this.controller.abort();

  /** @param options 부모 취소·고정 마감·Host 네트워크 정책과 테스트용 HTTPS 경계 */
  constructor(options: Options = {}) {
    const capability = options.policy && gitHubHttpCapability("github.com", options.env ?? process.env, options.policy);
    this.transport = options.transport ?? new GitHubWebTransport({ ownedAgent: capability?.supported === true,
      agentPolicy: JSON.stringify(options.policy) });
    this.parent = options.signal;
    this.parent?.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(this.abort, Math.max(0, Math.min(options.deadline ?? this.started + 30_000, this.started + 30_000) - this.started));
    if (this.parent?.aborted) this.abort();
  }

  /**
   * hash 없는 URL·실제 header 값의 HMAC key로 성공/실패 Promise를 한 context 안에서 공유한다.
   * @param source GitHub URL, headers 현재 인증과 Accept, requireFullHtml 최상위 GitHub HTML 확인 여부
   * @returns 검증된 HTML. 취소/마감은 빈 성공으로 바꾸지 않는다.
   */
  async read(source: string, headers: Record<string, string>, requireFullHtml = false): Promise<GitHubWebHtmlRead> {
    if (this.signal.aborted) return { ok: false, reason: "request cancelled" };
    let url: string;
    try { url = safeWebUrl(source).toString(); } catch { return { ok: false, reason: "unsafe web URL" }; }
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)));
    const key = createHmac("sha256", this.secret).update(JSON.stringify([url, normalized])).digest("hex");
    let execution = this.memo.get(key);
    if (execution) this.shared++;
    else {
      execution = this.queue.run(async () => {
        if (this.signal.aborted) return { ok: false as const, reason: "request cancelled" };
        this.requests++; this.maximumActive = Math.max(this.maximumActive, ++this.active);
        try { return await this.transport.read(url, normalized, this.signal); } finally { this.active--; }
      }, this.signal).catch(() => ({ ok: false as const, reason: this.signal.aborted ? "request cancelled" : "web html connection failed" }));
      this.memo.set(key, execution); this.pending.add(execution);
      execution.finally(() => this.pending.delete(execution!));
    }
    const result = await execution;
    if (!result.ok) return result;
    if (requireFullHtml ? !/<html\b/i.test(result.html) || !/github/i.test(result.html) : !/<[^>]+>/.test(result.html)) {
      return { ok: false, reason: requireFullHtml ? "response was not GitHub HTML" : "response was not HTML fragment" };
    }
    return result;
  }

  /** 요청 수·공유 수·동시 실행·시간·byte만 반환한다. 인증 identity와 내용은 반환하지 않는다. */
  metrics() { return { requests: this.requests, shared: this.shared, maximumActive: this.maximumActive,
    elapsedMs: Date.now() - this.started, ...this.transport.metrics?.() }; }

  /** 무효화/종료 후 새 예약을 막고 모든 실제 close와 Agent 해제까지 기다린다. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.abort(); clearTimeout(this.timer); this.parent?.removeEventListener("abort", this.abort);
      await Promise.allSettled([...this.pending]); await this.transport.dispose();
      logInfo("GitHub HTML context closed", this.metrics());
      this.memo.clear(); this.secret.fill(0);
    })();
  }
}
