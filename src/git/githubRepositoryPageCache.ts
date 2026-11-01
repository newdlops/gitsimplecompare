// OAuth 저장소 목록의 완전한 표현만 제한된 메모리에 보존한다. 재인가 없이 UI에 반환하지 않는다.
import { createHmac, randomBytes } from "node:crypto";
import type { GitHubRepositoryPage } from "./githubRepositoryCatalog";

export interface RepositoryPageCacheOptions {
  now?: () => number; idleTtlMs?: number; maxPages?: number; maxBytes?: number; maxPageBytes?: number;
}
interface Entry { identity: string; page: GitHubRepositoryPage; etag: string; at: number; bytes: number; }

/** token은 process-local HMAC key로만 구분하고 URL/표현별 LRU·idle 상한을 적용한다. */
export class GitHubRepositoryPageCache {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** 기본 한계는 32페이지·4MiB·항목 1MiB·idle 2분이며 테스트에서만 작은 한계를 주입한다. */
  constructor(private readonly options: RepositoryPageCacheOptions = {}) {}

  /** 현재 OAuth 값의 비가역 identity를 만든다. 이 값은 오류/로그로 전달하지 않는다. */
  identity(token: string): string { return createHmac("sha256", this.secret).update(token).digest("hex"); }

  /** 재인가 요청의 후보를 읽고 idle 시각을 갱신한다. 이것만으로 private 목록을 표시하지 않는다. */
  get(key: string): Entry | undefined {
    this.sweep(); const entry = this.entries.get(key);
    if (entry) { entry.at = this.now(); this.entries.delete(key); this.entries.set(key, entry); }
    this.scheduleExpiry(); return entry;
  }

  /** 완전한 page·ETag만 복사해 저장한다. ETag 누락/oversize는 이전 후보도 폐기한다. */
  put(key: string, identity: string, page: GitHubRepositoryPage, etag: string | null): void {
    this.remove(key); this.sweep();
    if (!etag || etag.length > 16_384 || /[\r\n\0]/.test(etag)) { this.scheduleExpiry(); return; }
    const payloadBytes = Buffer.byteLength(JSON.stringify(page));
    const bytes = payloadBytes + Buffer.byteLength(key) + Buffer.byteLength(etag);
    if (bytes > (this.options.maxPageBytes ?? 1024 * 1024) || bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) { this.scheduleExpiry(); return; }
    this.entries.set(key, { identity, page: cloneRepositoryPage(page), etag, at: this.now(), bytes }); this.bytes += bytes;
    while (this.entries.size > (this.options.maxPages ?? 32) || this.bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) this.remove(this.entries.keys().next().value!);
    this.scheduleExpiry();
  }

  /** 권한 실패가 난 OAuth의 모든 페이지 후보를 함께 무효화한다. */
  invalidate(identity: string): void {
    for (const [key, entry] of this.entries) if (entry.identity === identity) this.remove(key);
    this.scheduleExpiry();
  }

  /** dispose 때 private 목록과 HMAC 자원을 함께 해제한다. */
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.entries.clear(); this.bytes = 0; this.secret.fill(0); }

  /** 민감한 항목 없이 보관 페이지/bytes 수명만 관찰한다. */
  metrics() { return { pages: this.entries.size, bytes: this.bytes }; }

  /** 요청 및 소유 timer가 idle 상한을 지난 private 표현을 즉시 해제한다. */
  private sweep(): void {
    for (const [key, entry] of this.entries) if (this.now() - entry.at >= (this.options.idleTtlMs ?? 120_000)) this.remove(key);
  }
  /** 다음 만료 한 건만 예약하며 extension 종료나 idle process를 붙잡지 않는다. */
  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.entries.size) return;
    const next = Math.min(...[...this.entries.values()].map(entry => entry.at)) + (this.options.idleTtlMs ?? 120_000);
    this.timer = setTimeout(() => { this.sweep(); this.scheduleExpiry(); }, Math.max(0, next - this.now()));
    this.timer.unref();
  }
  /** LRU와 용량 집계를 같은 위치에서 제거한다. */
  private remove(key: string): void { const entry = this.entries.get(key); if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; } }
  /** 테스트용 clock 또는 실제 epoch를 반환한다. */
  private now(): number { return this.options.now?.() ?? Date.now(); }
}

/** 소비자와 캐시가 저장소 객체/배열의 변경을 공유하지 않도록 복사한다. */
export function cloneRepositoryPage(page: GitHubRepositoryPage): GitHubRepositoryPage {
  return { repositories: page.repositories.map(repository => ({ ...repository })), ...(page.nextPage ? { nextPage: page.nextPage } : {}) };
}
