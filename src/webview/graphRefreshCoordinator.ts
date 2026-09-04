// Graph 자동/직접 새로고침의 수명주기를 VS Code와 Git 구현에서 분리하는 모듈.
// - 의미 fingerprint, visibility, generation, 후속 PR 게시를 한 곳에서 소유한다.

/** Graph reload 뒤에 필요한 PR 게시 강도를 나타낸다. */
export type GraphRefreshMode = "none" | "stacks" | "pullRequests";
/** 외부 요청이 coordinator에 전달하는 최소 정보다. */
export interface GraphRefreshRequest { repoRoot: string; cause: string; mode: GraphRefreshMode; force?: boolean; }
/** Graph reload callback이 stale 여부를 판단할 수 있도록 전달하는 실행 문맥이다. */
export interface GraphRefreshContext { repoRoot: string; cause: string; generation: number; fingerprint: string; }
/** UI adapter가 주입하는 Git read, reload, publication, invalidation, logging 경계다. */
export interface GraphRefreshLifecycleDeps {
  readFingerprint(repoRoot: string): Promise<string>;
  reloadGraph(context: GraphRefreshContext): Promise<void>;
  publishAfterReload(context: GraphRefreshContext, mode: GraphRefreshMode): Promise<void>;
  invalidateReload(reason: string): void;
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, error: unknown, fields: Record<string, unknown>): void;
}

interface ResolvedRequest extends GraphRefreshRequest { fingerprint: string; sequence: number; }

/** semantic fingerprint 전체를 안정적으로 축약한 OUTPUT 식별자다. */
export function graphRefreshFingerprintDigest(fingerprint: string): string {
  let hash = 2166136261;
  for (const character of fingerprint) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Git fingerprint에 직접 드러나지 않는 명령 mutation만 강제 reload로 승격한다. */
export const GRAPH_REFRESH_FORCE_CAUSES = new Set([
  "manual", "stackSubmitted", "stackAdvanced", "stackParentEdited", "localStackDeleted",
  "stackRestackContinue", "stackRestackAbort", "commit", "graphAction",
]);

/** comma-delimited reason에서 정확히 일치한 force cause가 있는지 반환한다. */
export function isForcedGraphRefreshCause(cause: string): boolean {
  return cause.split(",").map((part) => part.trim()).some((part) => GRAPH_REFRESH_FORCE_CAUSES.has(part));
}

/** mode 둘 중 PR 목록 재조회 요구를 잃지 않는 더 강한 값을 고른다. */
function strongestMode(left: GraphRefreshMode, right: GraphRefreshMode): GraphRefreshMode {
  const strength: Record<GraphRefreshMode, number> = { none: 0, stacks: 1, pullRequests: 2 };
  return strength[left] >= strength[right] ? left : right;
}

/** Graph refresh의 visibility, fingerprint, generation, publication을 끝까지 소유한다. */
export class GraphRefreshLifecycleCoordinator {
  private repository = "";
  private visible = true;
  private focused = true;
  private disposed = false;
  private epoch = 0;
  private requestSequence = 0;
  private directSequence = 0;
  private generation = 0;
  private baseline: string | undefined;
  private running: ResolvedRequest | undefined;
  private directRunning = false;
  private pending: ResolvedRequest | undefined;
  private deferred: GraphRefreshRequest | undefined;
  private unreadIntent: Pick<GraphRefreshRequest, "mode" | "force"> = { mode: "none", force: false };

  /** coordinator에 Git/UI adapter를 주입해 테스트에서 deferred promise로 제어할 수 있게 한다. */
  constructor(private readonly deps: GraphRefreshLifecycleDeps) {}

  /** 저장소 경계를 바꾸고 이전 read/run/baseline을 모두 무효화한다. */
  setRepository(repoRoot: string): void {
    if (this.repository === repoRoot) return;
    this.repository = repoRoot;
    this.baseline = undefined;
    this.running = undefined;
    this.directRunning = false;
    this.pending = undefined;
    this.deferred = undefined;
    this.unreadIntent = { mode: "none", force: false };
    this.epoch++;
    this.deps.invalidateReload("repositoryChanged");
  }

  /** hide/reveal을 반영하고 reveal 시 현재 deferred 요청 한 건을 안전하게 재개한다. */
  setVisible(visible: boolean): boolean {
    this.visible = visible;
    if (!visible) { this.invalidate("hidden"); return false; }
    return this.consumeDeferred();
  }

  /** unfocus/focus를 반영하고 focus 복귀 시 stale 작업 없이 한 건만 소비한다. */
  setFocused(focused: boolean): boolean {
    this.focused = focused;
    if (!focused) { this.invalidate("windowUnfocused"); return false; }
    return this.consumeDeferred();
  }

  /** 자동 refresh를 fingerprint 순서로 읽어 schedule/coalesce/skip 중 하나로 결정한다. */
  async request(request: GraphRefreshRequest): Promise<void> {
    if (this.disposed) return;
    this.setRepository(request.repoRoot);
    if (!this.canRun()) { this.defer(request); return; }
    const epoch = this.epoch;
    // 같은 lifecycle 안에서도 Git read 완료 순서는 요청 도착 순서와 다를 수 있으므로 별도 세대를 둔다.
    const sequence = ++this.requestSequence;
    const force = !!request.force || isForcedGraphRefreshCause(request.cause);
    // 뒤의 약한 watcher read가 먼저 끝나도 앞선 command/PR 요청의 강한 의도를 잃지 않게 누적한다.
    this.unreadIntent = { force: !!(force || this.unreadIntent.force), mode: strongestMode(request.mode, this.unreadIntent.mode) };
    try {
      const fingerprint = await this.readFingerprint(request, this.generation);
      if (!this.isCurrent(request.repoRoot, epoch) || !this.canRun()) { this.defer(request); return; }
      if (sequence !== this.requestSequence) {
        this.deps.info("graph refresh coalesce", this.fields(request, this.generation, graphRefreshFingerprintDigest(fingerprint)));
        return;
      }
      const intent = this.unreadIntent;
      this.unreadIntent = { mode: "none", force: false };
      this.schedule({ ...request, fingerprint, sequence, force: intent.force, mode: strongestMode(request.mode, intent.mode) });
    } catch (error) {
      // 최신 read 실패 뒤에도 누적 intent는 다음 성공 read가 소비한다. 명령 mutation의 force를 오류로 잃지 않는다.
      this.deps.error("graph refresh error", error, this.fields(request, this.generation, "unavailable"));
    }
  }

  /** ready/manual처럼 호출자가 await하는 직접 reload를 정확히 한 번 실행하고 baseline까지 확정한다. */
  async runDirect(request: Pick<GraphRefreshRequest, "repoRoot" | "cause">): Promise<boolean> {
    if (this.disposed) return false;
    this.setRepository(request.repoRoot);
    const superseded = !!(
      this.running || this.directRunning || this.pending || this.deferred ||
      this.unreadIntent.force || this.unreadIntent.mode !== "none"
    );
    this.running = undefined;
    this.directRunning = false;
    this.pending = undefined;
    this.deferred = undefined;
    this.unreadIntent = { mode: "none", force: false };
    // 아직 fingerprint를 읽는 요청도 같은 repository에서 뒤늦게 schedule되지 않도록 epoch를 항상 전진시킨다.
    this.epoch++;
    this.requestSequence++;
    if (superseded) this.deps.invalidateReload("directSupersede");
    const epoch = this.epoch;
    const directSequence = ++this.directSequence;
    const generation = ++this.generation;
    this.directRunning = true;
    this.deps.info("graph refresh start", this.fields(request, generation, "direct"));
    try {
      const fingerprint = await this.readFingerprint(request, generation);
      const context = { ...request, generation, fingerprint };
      await this.deps.reloadGraph(context);
      if (!this.isCurrentDirect(request.repoRoot, epoch, directSequence)) return false;
      this.baseline = fingerprint;
      this.deps.info("graph refresh complete", this.fields(request, generation, graphRefreshFingerprintDigest(fingerprint)));
      return true;
    } catch (error) {
      if (this.isCurrentDirect(request.repoRoot, epoch, directSequence)) this.deps.error("graph refresh error", error, this.fields(request, generation, "direct"));
      return false;
    } finally {
      if (this.isCurrentDirect(request.repoRoot, epoch, directSequence)) {
        this.directRunning = false;
        this.consumePending();
      }
    }
  }

  /** panel 폐기 시 모든 지연 read/run을 무효화하고 더 이상 callback을 실행하지 않는다. */
  dispose(): void { this.disposed = true; this.invalidate("dispose"); }

  /** fingerprint가 확정된 요청을 baseline/running/pending과 비교해 transaction을 결정한다. */
  private schedule(request: ResolvedRequest): void {
    const digest = graphRefreshFingerprintDigest(request.fingerprint);
    // start 직전 generation을 올리므로 schedule/coalesce도 다음 실행 세대를 같은 값으로 기록한다.
    const scheduledGeneration = this.generation + 1;
    const fields = this.fields(request, scheduledGeneration, digest);
    this.deps.info("graph refresh schedule", fields);
    if (!this.running && !this.directRunning && !request.force && this.baseline === request.fingerprint) {
      this.deps.info("graph refresh skip", fields);
      return;
    }
    if (this.running) {
      this.pending = this.mergePending(this.pending, request);
      if (this.pending.fingerprint === this.running.fingerprint && !this.pending.force) {
        this.running.mode = strongestMode(this.running.mode, this.pending.mode);
        this.pending = undefined;
      }
      this.deps.info("graph refresh coalesce", fields);
      return;
    }
    if (this.directRunning) {
      this.pending = this.mergePending(this.pending, request);
      this.deps.info("graph refresh coalesce", fields);
      return;
    }
    this.running = request;
    void this.run(request, ++this.generation, this.epoch);
  }

  /** 한 자동 transaction을 실행하고 성공시에만 baseline을 전진시킨 뒤 newest pending을 소비한다. */
  private async run(request: ResolvedRequest, generation: number, epoch: number): Promise<void> {
    const context = { repoRoot: request.repoRoot, cause: request.cause, generation, fingerprint: request.fingerprint };
    const digest = graphRefreshFingerprintDigest(request.fingerprint);
    this.deps.info("graph refresh start", this.fields(request, generation, digest));
    try {
      await this.deps.reloadGraph(context);
      if (!this.isCurrent(request.repoRoot, epoch) || this.running !== request) return;
      // reload 중 관측된 실제 변경은 다음 세대가 소유한다. 이전 세대의 PR 게시만 막아 stale 화면을 피한다.
      const superseded = this.pending && (this.pending.force || this.pending.fingerprint !== request.fingerprint);
      if (!superseded) await this.deps.publishAfterReload(context, request.mode);
      if (!this.isCurrent(request.repoRoot, epoch) || this.running !== request) return;
      this.baseline = request.fingerprint;
      this.deps.info("graph refresh complete", this.fields(request, generation, digest));
    } catch (error) {
      if (this.isCurrent(request.repoRoot, epoch)) this.deps.error("graph refresh error", error, this.fields(request, generation, digest));
    } finally {
      if (this.running !== request || !this.isCurrent(request.repoRoot, epoch)) return;
      this.running = undefined;
      this.consumePending();
    }
  }

  /** hidden/unfocused 상태에서는 최신 cause/mode/force를 잃지 않고 한 건으로 보관한다. */
  private defer(request: GraphRefreshRequest): void {
    this.deferred = this.deferred && this.deferred.repoRoot === request.repoRoot
      ? { ...request, force: !!(request.force || this.deferred.force), mode: strongestMode(request.mode, this.deferred.mode) }
      : request;
    this.deps.info("graph refresh coalesce", this.fields(request, this.generation, "deferred"));
  }

  /** visibility와 focus가 모두 회복됐을 때만 가장 최신 deferred 요청을 다시 fingerprint로 판정한다. */
  private consumeDeferred(): boolean {
    if (!this.canRun() || !this.deferred) return false;
    const request = this.deferred;
    this.deferred = undefined;
    void this.request(request);
    return true;
  }

  /** direct/automatic run 뒤 newest pending을 기준선과 다시 비교해 필요한 한 세대만 시작한다. */
  private consumePending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || (!pending.force && pending.fingerprint === this.baseline) || !this.canRun()) return;
    this.running = pending;
    void this.run(pending, ++this.generation, this.epoch);
  }

  /** newest fingerprint를 유지하면서 이전 요청의 강제/PR 강도를 보존한다. */
  private mergePending(previous: ResolvedRequest | undefined, next: ResolvedRequest): ResolvedRequest {
    return previous
      ? { ...next, force: !!(next.force || previous.force), mode: strongestMode(next.mode, previous.mode) }
      : next;
  }

  /** fingerprint Git read 시간을 모든 direct/automatic 경로에서 같은 필드로 기록한다. */
  private async readFingerprint(
    request: Pick<GraphRefreshRequest, "repoRoot" | "cause">,
    generation: number
  ): Promise<string> {
    const started = Date.now();
    const fingerprint = await this.deps.readFingerprint(request.repoRoot);
    this.deps.info("graph performance fingerprint", {
      ...this.fields(request, generation, graphRefreshFingerprintDigest(fingerprint)),
      elapsedMs: Date.now() - started,
    });
    return fingerprint;
  }

  /** lifecycle 경계에서 자동 실행 중인 최신 reconcile을 deferred로 보존하고 늦은 결과를 stale 처리한다. */
  private invalidate(reason: string): void {
    if (reason === "hidden" || reason === "windowUnfocused") {
      const current = this.pending
        ? this.mergePending(this.running, this.pending)
        : this.running;
      if (current) this.defer(current);
    }
    this.running = undefined;
    this.directRunning = false;
    this.directSequence++;
    this.pending = undefined;
    this.epoch++;
    this.deps.invalidateReload(reason);
  }
  /** 현재 repository/epoch/lifecycle인지 확인해 늦은 promise의 publish를 차단한다. */
  private isCurrent(repoRoot: string, epoch: number): boolean { return !this.disposed && this.repository === repoRoot && this.epoch === epoch; }
  /** 같은 repository의 뒤 direct 실행이 baseline을 덮어쓰지 않도록 direct 순번까지 확인한다. */
  private isCurrentDirect(repoRoot: string, epoch: number, sequence: number): boolean { return this.isCurrent(repoRoot, epoch) && this.directSequence === sequence; }
  /** visible과 focused가 모두 true인 경우에만 자동 Graph 작업을 실행한다. */
  private canRun(): boolean { return this.visible && this.focused && !this.disposed; }
  /** 모든 aggregate 로그에 repository/cause/generation/digest를 동일하게 부착한다. */
  private fields(request: Pick<GraphRefreshRequest, "repoRoot" | "cause">, generation: number, fingerprint: string): Record<string, unknown> { return { repoRoot: request.repoRoot, cause: request.cause, generation, fingerprint }; }
}
