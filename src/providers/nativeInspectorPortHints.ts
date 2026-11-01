// 성공 포트만 extension lifetime 안에서 기억한다. URL/인증/영구 설정은 보관하지 않는다.
interface Hint { profile: string; port: number; }

/** PID·profile·configured port set마다 최대 16개의 일시적 포트 힌트를 보관하는 LRU다. */
export class NativeInspectorPortHints {
  private readonly hints = new Map<string, Hint>();

  /** 다음 발견에서도 HTTP 목록과 실제 PID를 다시 확인할 후보 포트만 반환한다. */
  get(pid: number, profile: string, ports: readonly number[]): number | undefined {
    const key = hintKey(pid, profile, ports), hint = this.hints.get(key);
    if (!hint) return undefined;
    if (!ports.includes(hint.port)) { this.hints.delete(key); return undefined; }
    this.hints.delete(key); this.hints.set(key, hint); return hint.port;
  }

  /** 실제 PID 검증을 통과한 구성 내 포트만 저장하고 오래된 힌트부터 16개로 줄인다. */
  remember(pid: number, profile: string, ports: readonly number[], port: number): void {
    if (!ports.includes(port)) return;
    const key = hintKey(pid, profile, ports); this.hints.delete(key); this.hints.set(key, { profile, port });
    while (this.hints.size > 16) this.hints.delete(this.hints.keys().next().value!);
  }

  /** 취소·다른 PID·닫힌 포트가 확인된 정확한 탐색 조건의 힌트만 버린다. */
  forget(pid: number, profile: string, ports: readonly number[]): void { this.hints.delete(hintKey(pid, profile, ports)); }

  /** 연결 폐기 때 해당 profile만 제거하며 인자가 없으면 소유 수명의 모든 힌트를 제거한다. */
  clear(profile?: string): void {
    for (const [key, hint] of this.hints) if (profile === undefined || hint.profile === profile) this.hints.delete(key);
  }
}

/** 포트 순서·중복은 별도 설정 세대를 만들지 않고 집합이 바뀔 때만 다른 key를 만든다. */
function hintKey(pid: number, profile: string, ports: readonly number[]): string {
  return JSON.stringify([pid, profile, [...new Set(ports)].sort((left, right) => left - right)]);
}
