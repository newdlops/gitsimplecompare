// 한 저장소/브랜치의 진행 snapshot과 최종 결과를 소비자별 취소로 공유한다.
import type { ActivePullRequestReviewComments } from "../git/pullRequestReviewComments";
import { logInfo } from "../ui/outputLog";

type Data = ActivePullRequestReviewComments;
export type PullRequestCommentProgress = (data: Data) => void;
interface Subscriber { progress?: PullRequestCommentProgress; cancel: () => void; }

/** 원격 작업의 취소 소유권과 UI 구독을 분리하며 임시 snapshot을 TTL 캐시로 취급하지 않는다. */
export class PullRequestCommentLoad {
  readonly controller = new AbortController();
  readonly promise: Promise<Data | undefined>;
  private readonly subscribers = new Set<Subscriber>();
  private latest?: Data;
  private settled = false;

  /** @param start 원격 실행과 API-ready 게시 경계. 구독 등록 뒤 microtask에서 시작한다. */
  constructor(start: (signal: AbortSignal, publish: PullRequestCommentProgress) => Promise<Data | undefined>) {
    this.promise = Promise.resolve().then(() => {
      this.controller.signal.throwIfAborted();
      return start(this.controller.signal, value => this.publish(value));
    }).finally(() => { this.settled = true; this.latest = undefined; });
    // 마지막 소비자가 먼저 취소되어도 실제 자원 종료를 기다리는 Promise의 rejection은 소유한다.
    void this.promise.catch(() => undefined);
  }

  /**
   * 늦게 합류한 소비자에게 최신 API-ready를 재전달하고 최종 결과를 독립적으로 구독한다.
   * @param signal 이 소비자의 취소, progress 선택적 표시 callback
   * @returns 다른 소비자의 취소/예외에 영향받지 않는 최종 결과
   */
  subscribe(signal?: AbortSignal, progress?: PullRequestCommentProgress): Promise<Data | undefined> {
    return new Promise((resolve, reject) => {
      let done = false;
      const subscriber: Subscriber = { progress, cancel: () => finish(new DOMException("PR review comment request was cancelled.", "AbortError")) };
      /** 구독의 listener와 callback을 해제하고 마지막 소비자의 실제 작업만 취소한다. */
      const finish = (error?: unknown, value?: Data) => {
        if (done) return; done = true;
        signal?.removeEventListener("abort", subscriber.cancel); this.subscribers.delete(subscriber);
        if (error) reject(error); else resolve(value);
        if (!this.settled && !this.subscribers.size) this.controller.abort();
      };
      this.subscribers.add(subscriber);
      signal?.addEventListener("abort", subscriber.cancel, { once: true });
      if (signal?.aborted || this.controller.signal.aborted) subscriber.cancel();
      else if (this.latest && progress) notify(progress, this.latest);
      this.promise.then(value => finish(undefined, value), error => finish(error));
    });
  }

  /** 무효화/dispose는 모든 소비자의 callback과 실제 원격 실행을 함께 취소한다. */
  cancel(): void {
    this.controller.abort(); this.latest = undefined;
    for (const subscriber of [...this.subscribers]) subscriber.cancel();
  }

  /** 현재 수명의 snapshot만 저장하고 각 소비자의 예외/변형을 다른 소비자와 격리한다. */
  private publish(value: Data): void {
    if (this.controller.signal.aborted || this.settled) return;
    this.latest = value;
    for (const subscriber of [...this.subscribers]) if (this.subscribers.has(subscriber) && subscriber.progress) notify(subscriber.progress, value);
  }
}

/** callback에는 얕은 도메인 복사본을 전달하며 실패 원문을 로그에 넣지 않는다. */
function notify(progress: PullRequestCommentProgress, value: Data): void {
  try { progress({ ...value, comments: value.comments.map(comment => ({ ...comment,
    ...(comment.suggestedChangesets ? { suggestedChangesets: [...comment.suggestedChangesets] } : {}) })),
    ...(value.suggestedChangesetStatus ? { suggestedChangesetStatus: { ...value.suggestedChangesetStatus } } : {}) }); }
  catch { logInfo("pr editor comments progress subscriber skipped", { reason: "callback-failed" }); }
}
