/** 비교 함수가 앞에 두는 상위 K개만 보관하는 최대 heap. 전체 입력 개수에 비례한 값 배열을 만들지 않는다. */
export class TopK<T> {
  private readonly heap: T[] = [];
  /** @param limit 보관할 최대 개수 @param compare Array.sort와 같은 순서 비교 함수(음수면 더 우선한다). */
  constructor(private readonly limit: number, private readonly compare: (a: T, b: T) => number) {}

  /** 새 후보가 현재 최하위보다 우선할 때만 교체한다. 시간은 O(log K), 보관 공간은 O(K)다. */
  add(value: T): void {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      let index = this.heap.push(value) - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.compare(this.heap[index], this.heap[parent]) <= 0) break;
        [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]]; index = parent;
      }
      return;
    }
    if (this.compare(value, this.heap[0]) >= 0) return;
    this.heap[0] = value;
    let index = 0;
    while (index * 2 + 1 < this.heap.length) {
      const left = index * 2 + 1, right = left + 1;
      const worst = right < this.heap.length && this.compare(this.heap[right], this.heap[left]) > 0 ? right : left;
      if (this.compare(this.heap[worst], this.heap[index]) <= 0) break;
      [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]]; index = worst;
    }
  }

  /** heap을 수정하지 않고 기존 전체 정렬과 같은 순서의 결과 사본을 반환한다. */
  values(): T[] { return [...this.heap].sort(this.compare); }
}
