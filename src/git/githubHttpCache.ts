// REST의 완전한 body/ETag와 GitHub rate-limit cooldown만 bounded 메모리에 보관한다.
interface Body { value: string; etag: string; bytes: number; }
export class GitHubHttpCache {
  private readonly bodies = new Map<string, Body>();
  private readonly cooldowns = new Map<string, number>();
  private bytes = 0;

  /** 같은 origin·인증·Accept·URI의 완전한 200 응답만 반환한다. */
  get(key: string): Body | undefined {
    const body = this.bodies.get(key);
    if (body) { this.bodies.delete(key); this.bodies.set(key, body); }
    return body;
  }

  /** 단일 4MiB, 전체 16MiB/128개 상한으로 body와 ETag를 함께 저장한다. */
  put(key: string, value: string, etag?: string): void {
    this.remove(key);
    const bytes = Buffer.byteLength(value);
    if (!etag || bytes > 4 * 1024 * 1024) return;
    this.bodies.set(key, { value, etag, bytes }); this.bytes += bytes;
    while (this.bodies.size > 128 || this.bytes > 16 * 1024 * 1024) this.remove(this.bodies.keys().next().value!);
  }

  /** 인증 취소 때 해당 문맥의 conditional body를 제거한다. key는 로그에 노출하지 않는다. */
  invalidate(context: string): void { for (const key of this.bodies.keys()) if (key.startsWith(context + "\0")) this.remove(key); }

  /** primary는 credential 문맥, secondary는 host의 다음 요청을 정해진 시각까지 제한한다. */
  cooldown(key: string, until: number): void {
    if (!Number.isFinite(until) || until <= Date.now()) return;
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, until));
    while (this.cooldowns.size > 128) this.cooldowns.delete(this.cooldowns.keys().next().value!);
  }

  /** 만료된 제한은 즉시 삭제하며 현재 유효한 제한 시각만 반환한다. */
  retryAt(...keys: string[]): number | undefined {
    let at = 0;
    for (const key of keys) {
      const value = this.cooldowns.get(key) ?? 0;
      if (value <= Date.now()) this.cooldowns.delete(key); else at = Math.max(at, value);
    }
    return at || undefined;
  }

  /** 활성화 종료 때 응답 body와 제한 상태를 함께 버린다. */
  clear(): void { this.bodies.clear(); this.cooldowns.clear(); this.bytes = 0; }
  /** byte 사용량과 항목 수가 어긋나지 않게 함께 제거한다. */
  private remove(key: string): void { const old = this.bodies.get(key); if (old) { this.bytes -= old.bytes; this.bodies.delete(key); } }
}
