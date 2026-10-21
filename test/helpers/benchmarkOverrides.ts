// 벤치마크의 외부 경계만 교체한다. 호출 인자·결과·stack을 수집하는 테스트 mock은 사용하지 않는다.
export class BenchmarkOverrides {
  private readonly restores: Array<() => void> = [];

  /**
   * 함수 자체만 교체해 생산 코드와 같은 this·반환값·예외 동작을 유지한다.
   * @param target 소유한 fixture 또는 측정 동안만 바꿀 API 객체
   * @param key 교체할 함수 이름 @param replacement 호출 기록을 감싸지 않는 실제 대체 함수
   * @returns 전달한 함수 그대로. 호출 인자나 결과를 이 scope에 보관하지 않는다.
   */
  method<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): T[K] {
    const own = Object.getOwnPropertyDescriptor(target, key);
    if (own && !("value" in own)) throw new TypeError("Benchmark overrides require a data method.");
    if (typeof target[key] !== "function" || typeof replacement !== "function") throw new TypeError("Benchmark overrides require functions.");
    Object.defineProperty(target, key, own ? { ...own, value: replacement }
      : { value: replacement, configurable: true, enumerable: false, writable: true });
    this.restores.push(() => {
      if (own) Object.defineProperty(target, key, own);
      else Reflect.deleteProperty(target, key);
    });
    return replacement;
  }

  /** 중첩 교체를 역순으로 복원하고 대상 객체를 붙잡던 정리 함수까지 즉시 비운다. 중복 호출도 안전하다. */
  restoreAll(): void {
    while (this.restores.length) this.restores.pop()!();
  }
}

/** 한 benchmark bundle 안에서만 공유하며 각 시나리오 finally에서 완전히 해제한다. */
export const benchmarkOverrides = new BenchmarkOverrides();
