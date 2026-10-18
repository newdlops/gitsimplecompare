// native 충돌 문서 조회를 제한하고 숨겨진 같은 저장소의 요청을 작은 표시 묶음으로 읽는다.
// - 세션 수명/게시 검증은 호출자가 유지하며 공통 조회는 마지막 소비자가 사라질 때만 취소한다.
import type { ConflictDocument, ConflictService } from "../git/conflictService";
import { logInfo } from "../ui/outputLog";

interface Entry {
  service: ConflictService;
  rel: string;
  previous?: ConflictDocument;
  signal: AbortSignal;
  priority(): number;
  beforeRead(): boolean;
  resolve(document: ConflictDocument | undefined): void;
  reject(error: unknown): void;
  abort(): void;
  settled: boolean;
  group?: Group;
}
interface Group { entries: Entry[]; controller: AbortController }
const BACKGROUND_BATCH_SIZE = 16;
// 이전 문서 본문 합계가 약 8MiB(UTF-16)를 넘으면 묶음을 나눠 큰 Result의 동시 보존을 제한한다.
const BACKGROUND_CHARACTER_BUDGET = 4 * 1024 * 1024;

/** 숨겨진 묶음은 하나씩 읽어 새 사용자 요청에 여유를 남기고 총 조회는 두 개로 제한한다. */
export class ConflictDocumentReadQueue {
  private readonly pending: Entry[] = [];
  private active = 0;
  private backgroundBatchActive = false;
  private scheduled = false;

  /**
   * 표시 요청을 등록하고 실제 읽기 직전에 세션·dirty 상태를 다시 확인한다.
   * @param service 저장소의 읽기 서비스 @param rel 충돌 상대 경로 @param previous 이전 설명
   * @param signal 해당 탭의 취소 신호. 다른 탭의 공통 조회를 단독으로 취소하지 않는다.
   * @param priority 시작 시 다시 평가할 우선순위. 0 이하는 단독 사용자/표시 요청이다.
   * @param beforeRead 시작 시 읽어도 되면 true, 이미 dirty/폐기된 문서면 false 또는 예외
   * @returns 이 문서의 최신 조회 값. 호출자가 읽기를 미뤘으면 undefined
   */
  read(
    service: ConflictService, rel: string, previous: ConflictDocument | undefined,
    signal: AbortSignal, priority: () => number, beforeRead: () => boolean = () => true
  ): Promise<ConflictDocument | undefined> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry: Entry = { service, rel, previous, signal, priority, beforeRead, resolve, reject,
        settled: false, abort: () => this.cancel(entry) };
      this.pending.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      this.schedule();
    });
  }

  /**
   * 소비자 하나의 대기/결과만 취소하고 실행 묶음의 마지막 소비자일 때 공통 Git도 중단한다.
   * @param entry 닫힘·새 갱신으로 취소한 파일 요청
   */
  private cancel(entry: Entry): void {
    if (entry.settled) return;
    const group = entry.group;
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
    this.finish(entry, undefined, { error: entry.signal.reason });
    if (group && group.entries.every(target => target.settled)) group.controller.abort();
    this.schedule();
  }

  /** 같은 이벤트의 요청을 모은 뒤 현재 우선순위로 다음 표시 묶음을 선택한다. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pending.sort((a, b) => a.priority() - b.priority());
      while (this.active < 2 && this.pending.length) {
        // 긴 숨겨진 묶음 둘이 두 슬롯을 모두 점유해 새 파일 열기가 끝까지 기다리지 않게 한다.
        if (this.backgroundBatchActive && this.pending[0].priority() > 0
          && typeof this.pending[0].service.getConflictDocuments === "function") break;
        const first = this.pending.shift()!;
        const batch = [first];
        let characters = documentCharacters(first.previous);
        if (first.priority() > 0 && typeof first.service.getConflictDocuments === "function") {
          for (let index = 0; index < this.pending.length && batch.length < BACKGROUND_BATCH_SIZE;) {
            const candidate = this.pending[index];
            const cost = documentCharacters(candidate.previous);
            if (candidate.priority() > 0 && candidate.service.repoRoot === first.service.repoRoot
              && typeof candidate.service.getConflictDocuments === "function"
              && characters + cost <= BACKGROUND_CHARACTER_BUDGET) {
              batch.push(candidate); characters += cost; this.pending.splice(index, 1);
            } else index++;
          }
        }
        const entries = batch.filter(entry => {
          try {
            entry.signal.throwIfAborted();
            if (entry.beforeRead()) return true;
            this.finish(entry);
          } catch (error) { this.finish(entry, undefined, { error }); }
          return false;
        });
        if (!entries.length) continue;
        const group = { entries, controller: new AbortController() };
        for (const entry of entries) entry.group = group;
        const backgroundBatch = entries.length > 1;
        if (backgroundBatch) this.backgroundBatchActive = true;
        this.active++;
        void this.run(group).finally(() => {
          this.active--;
          if (backgroundBatch) this.backgroundBatchActive = false;
          this.schedule();
        });
      }
    });
  }

  /**
   * 한 표시 묶음의 Git/파일 읽기가 정리될 때까지 슬롯을 소유하고 파일별 결과를 전달한다.
   * @param group 현재 실행 중인 단독 또는 같은 저장소의 배치 요청
   */
  private async run(group: Group): Promise<void> {
    const entries = group.entries;
    const service = entries[0].service;
    try {
      if (entries.length === 1) {
        const entry = entries[0];
        const document = await service.getConflictDocument(entry.rel, true, {
          deferMetadata: true, previous: entry.previous, signal: group.controller.signal,
        });
        this.finish(entry, document);
      } else {
        const results = await service.getConflictDocuments(entries.map(entry => entry.rel), true, {
          previous: new Map(entries.flatMap(entry => entry.previous ? [[entry.rel, entry.previous] as const] : [])),
          signal: group.controller.signal,
          isNeeded: rel => entries.some(entry => entry.rel === rel && !entry.settled),
        });
        for (const entry of entries) {
          const result = results.get(entry.rel);
          if (result?.status === "fulfilled") this.finish(entry, result.value);
          else this.finish(entry, undefined, {
            error: result?.status === "rejected" ? result.reason : new Error("Missing conflict document read result."),
          });
        }
        logInfo("native conflict document batch read finished", { repoRoot: service.repoRoot,
          files: entries.length, cancelled: group.controller.signal.aborted });
      }
    } catch (error) {
      for (const entry of entries) this.finish(entry, undefined, { error });
    } finally { group.controller.abort(); }
  }

  /**
   * 요청을 한 번만 완료하고 취소 리스너·진행 묶음 참조를 즉시 해제한다.
   * @param entry 완료할 요청 @param document 성공한 문서 또는 dirty로 미룬 undefined
   * @param failure 있으면 성공 대신 원래 실패를 전달한다. undefined 거절 사유도 보존한다.
   */
  private finish(entry: Entry, document?: ConflictDocument, failure?: { error: unknown }): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.group = undefined;
    entry.previous = undefined;
    entry.signal.removeEventListener("abort", entry.abort);
    if (failure) entry.reject(failure.error);
    else entry.resolve(document);
  }
}

/** 이전 원본/Result 문자열 크기로 묶음의 임시 메모리 비용을 보수적으로 추정한다. */
function documentCharacters(document?: ConflictDocument): number {
  return document ? document.result.length + document.base.content.length + document.current.content.length
    + document.incoming.content.length + document.both.length : 0;
}
