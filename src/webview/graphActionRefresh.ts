// Git 명령 완료와 표시용 새로고침을 분리하고, 겹친 요청은 최신 후속 조회 하나로 합친다.
export type GraphActionRefreshKind = "checkout" | "graph";
interface Request { repoRoot: string; kind: GraphActionRefreshKind; }

/** 패널 수명과 현재 저장소를 확인하면서 실제 화면 조회를 호출하는 경계다. */
export interface GraphActionRefreshDeps {
  currentRepository(): string;
  refresh(kind: GraphActionRefreshKind): Promise<void>;
  info(event: string, fields: Record<string, unknown>): void;
  error(error: unknown, request: Request): void;
}

/** 한 패널의 느린 새로고침을 직렬화하고 중간 명령 결과의 중복 조회를 합친다. */
export class GraphActionRefreshQueue {
  private pending?: Request;
  private running = false;
  private disposed = false;

  /** @param deps 저장소 확인·실제 조회·관찰 로그를 제공하는 패널 adapter */
  constructor(private readonly deps: GraphActionRefreshDeps) {}

  /**
   * 완료된 명령의 화면 갱신을 요청한다. 실행 중 요청은 최신 한 건으로 합치고 graph 강도를 유지한다.
   * @param repoRoot 명령이 실제로 실행된 저장소 @param kind checkout의 기존 DAG 재사용 또는 전체 graph 조회
   */
  request(repoRoot: string, kind: GraphActionRefreshKind): void {
    if (this.disposed || repoRoot !== this.deps.currentRepository()) {
      this.deps.info("graph action refresh skipped", { repoRoot, kind, reason: "inactiveRepository" });
      return;
    }
    const previous = this.pending;
    this.pending = { repoRoot, kind: previous?.repoRoot === repoRoot && previous.kind === "graph" ? "graph" : kind };
    this.deps.info(previous ? "graph action refresh coalesced" : "graph action refresh queued", { repoRoot, kind: this.pending.kind });
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
  }

  /** 폐기된 패널의 후속 조회와 늦게 닫힌 알림의 새 요청을 무시한다. */
  dispose(): void { this.disposed = true; this.pending = undefined; }

  /** 실행 중인 요청은 끝까지 처리하고, 그동안 도착한 최신 요청만 다음에 한 번 읽는다. */
  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.pending) {
        const request = this.pending;
        this.pending = undefined;
        if (request.repoRoot !== this.deps.currentRepository()) continue;
        const started = Date.now();
        try { await this.deps.refresh(request.kind); }
        catch (error) { this.deps.error(error, request); }
        this.deps.info("graph action refresh finished", { ...request, elapsedMs: Date.now() - started });
      }
    } finally { this.running = false; }
  }
}

/**
 * 한 명령의 await refresh 호출은 기록만 하고, busy 해제 뒤 complete가 실제 조회를 시작하게 한다.
 * @param queue 패널이 소유한 표시용 조회 큐 @param repoRoot 명령 시작 시 고정한 저장소
 * @returns 기존 action 의존성에 넣을 함수들과 busy 해제 뒤 호출할 complete 함수
 */
export function deferGraphActionRefresh(queue: GraphActionRefreshQueue, repoRoot: string) {
  let pending: GraphActionRefreshKind | undefined;
  let complete = false;
  /** @param kind 명령이 요청한 갱신 강도 @returns 즉시 완료되며 Git 명령은 화면 조회를 기다리지 않는다. */
  const request = async (kind: GraphActionRefreshKind): Promise<void> => {
    if (complete) queue.request(repoRoot, kind);
    else pending = pending === "graph" ? "graph" : kind;
  };
  return {
    refreshCheckout: () => request("checkout"),
    refreshGraph: () => request("graph"),
    /** 명령 완료/실패의 busy 해제가 게시된 뒤 보류한 요청 하나를 전달한다. */
    complete: () => {
      if (complete) return;
      complete = true;
      if (pending) queue.request(repoRoot, pending);
    },
  };
}
