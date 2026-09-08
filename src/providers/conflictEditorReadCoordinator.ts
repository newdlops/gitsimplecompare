// native conflict editor의 내용 조회를 session별로 합치고 설명 정보는 편집기 표시 뒤 채운다.
// - Git 원본/CAS 검증은 서비스에 남기고, 수명주기와 늦은 응답의 게시 여부만 판단한다.
import type { ConflictDocument, ConflictDocumentMetadata } from "../git/conflictService";
import { logError, logInfo } from "../ui/outputLog";
import type { TrustedConflictEditorSession as Session } from "./conflictEditorOverlayController";

/** controller의 provider/UI 갱신을 안전한 session에만 위임하는 최소 경계다. */
export interface ConflictEditorReadHost {
  isCurrent(session: Session): boolean;
  isDirty(session: Session): boolean;
  commitDocument(session: Session, document: ConflictDocument, reason: string): void;
  commitMetadata(session: Session, metadata: ConflictDocumentMetadata | undefined): void;
  reopen(session: Session, document: ConflictDocument): Promise<void>;
  publishResolvedResult(session: Session, reason: string): Promise<boolean>;
  markResolved(session: Session, reason: string): void;
}
interface ReadRequest { reason: string; allowBusy: boolean }
interface PendingRead { next?: ReadRequest; promise: Promise<boolean> }

/** 진행 중 내용 조회 하나와 마지막 후속 요청 하나만 유지해 이벤트 burst를 합친다. */
export class ConflictEditorReadCoordinator {
  private readonly reads = new WeakMap<Session, PendingRead>();
  private readonly metadataReads = new WeakSet<Session>();

  constructor(private readonly host: ConflictEditorReadHost) {}

  /**
   * 최신 내용이 필요하다는 요청을 합치고 마지막으로 게시된 조회 결과를 반환한다.
   * @param allowBusy 명시적 Reload/Save action이 자신의 busy 구간에서 읽을 때만 true
   */
  refresh(session: Session, reason: string, allowBusy = false): Promise<boolean> {
    if (!this.host.isCurrent(session) || session.resolved) return Promise.resolve(false);
    if (session.busy && !allowBusy) {
      session.pendingRefreshReason = reason;
      return Promise.resolve(true);
    }
    session.refreshGeneration++;
    const pending = this.reads.get(session);
    if (pending) {
      pending.next = { reason, allowBusy: allowBusy || !!pending.next?.allowBusy };
      return pending.promise;
    }
    const state: PendingRead = { next: { reason, allowBusy }, promise: Promise.resolve(false) };
    state.promise = Promise.resolve().then(async () => {
      let published = false;
      try {
        while (state.next) {
          const request = state.next;
          state.next = undefined;
          published = await this.read(session, request);
        }
        return published;
      } finally { this.reads.delete(session); }
    });
    this.reads.set(session, state);
    return state.promise;
  }

  /**
   * 편집 가능한 Result를 게시한 뒤 source에 고정된 설명만 비동기로 보강한다.
   * - Result 본문·저장 기준선은 바꾸지 않으며 close/reopen/resolve/새 source의 늦은 응답을 버린다.
   */
  enrich(session: Session): void {
    if (!this.host.isCurrent(session) || session.resolved || session.document.metadataState !== "pending"
      || this.metadataReads.has(session)) return;
    if (session.busy) { session.pendingRefreshReason = "conflictMetadataDeferred"; return; }
    const document = session.document;
    const started = Date.now();
    this.metadataReads.add(session);
    void session.service.getConflictDocumentMetadata(document).then(metadata => {
      if (!this.canPublishMetadata(session, document)) return;
      if (session.busy) {
        session.pendingRefreshReason = "conflictMetadataDeferred";
      } else if (metadata) {
        this.host.commitMetadata(session, metadata);
        logInfo("native conflict metadata ready", { rel: session.rel, elapsedMs: Date.now() - started });
      } else {
        void this.refresh(session, "conflictMetadataSourceChanged").catch(() => undefined);
      }
    }).catch(error => {
      if (this.canPublishMetadata(session, document)) {
        if (session.busy) session.pendingRefreshReason = "conflictMetadataDeferred";
        else this.host.commitMetadata(session, undefined);
      }
      logError("native conflict metadata read failed", error, { repoRoot: session.service.repoRoot, rel: session.rel });
    }).finally(() => {
      this.metadataReads.delete(session);
      if (session.document.sourceVersion !== document.sourceVersion) this.enrich(session);
    });
  }

  /** 마지막으로 게시한 동일 source의 미완성 설명에만 응답을 반영할 수 있다. */
  private canPublishMetadata(session: Session, document: ConflictDocument): boolean {
    return this.host.isCurrent(session) && !session.resolved && !session.suspended
      && session.document.sourceVersion === document.sourceVersion
      && session.document.operation === document.operation && session.document.metadataState === "pending";
  }

  /** 새 내용은 generation/dirty 검증 뒤 게시하고, unchanged refresh는 provider repaint를 생략한다. */
  private async read(session: Session, { reason, allowBusy }: ReadRequest): Promise<boolean> {
    if (!this.host.isCurrent(session) || session.resolved) return false;
    if (session.busy && !allowBusy) { session.pendingRefreshReason = reason; return true; }
    const generation = session.refreshGeneration;
    const started = Date.now();
    try {
      const previous = session.document;
      const document = await session.service.getConflictDocument(session.rel, true, { deferMetadata: true, previous });
      if (!this.host.isCurrent(session) || session.resolved || generation !== session.refreshGeneration) return false;
      preserveNewerMetadata(document, session.document);
      if (!allowBusy && this.host.isDirty(session)) { session.pendingRefreshReason = reason; return true; }
      if ((document.resultState.kind !== "text") !== session.virtual) {
        await this.host.reopen(session, document);
        return false;
      }
      if (allowBusy || !sameContent(session.document, document) || session.baselineStale) this.host.commitDocument(session, document, reason);
      this.enrich(session);
      logInfo("native conflict content read finished", { repoRoot: session.service.repoRoot, rel: session.rel,
        reason, elapsedMs: Date.now() - started, metadataReused: document.metadataState === "ready" });
      return true;
    } catch (error) {
      if (!this.host.isCurrent(session) || generation !== session.refreshGeneration) return false;
      if (/no longer conflicted|Reload the conflict editor/i.test(error instanceof Error ? error.message : String(error))) {
        const published = await this.host.publishResolvedResult(session, reason).catch(() => false);
        if (published && this.host.isCurrent(session)) this.host.markResolved(session, reason);
        return false;
      }
      logError("native conflict editor session refresh failed", error, { repoRoot: session.service.repoRoot, rel: session.rel, reason });
      throw error;
    }
  }
}

/** 내용 조회 도중 같은 source의 설명이 완성됐으면 pending 상태로 되돌리지 않는다. */
function preserveNewerMetadata(document: ConflictDocument, current: ConflictDocument): void {
  if (document.metadataState !== "pending" || current.metadataState !== "ready"
    || document.sourceVersion !== current.sourceVersion || document.operation !== current.operation) return;
  document.metadataState = "ready";
  document.context = current.context;
  for (const side of ["current", "incoming"] as const) {
    const { label, ref, commit, subject, fileCommit, fileSubject } = current[side];
    document[side] = { ...document[side], label, ref, commit, subject, fileCommit, fileSubject };
  }
}

/** 원본·Result identity와 속성에 의한 내용 분류까지 같아야 이전 provider baseline을 유지한다. */
function sameContent(a: ConflictDocument, b: ConflictDocument): boolean {
  return a.sourceVersion === b.sourceVersion && a.resultVersion === b.resultVersion && a.operation === b.operation
    && a.metadataState === b.metadataState && a.resultState.kind === b.resultState.kind
    && a.base.kind === b.base.kind && a.current.kind === b.current.kind && a.incoming.kind === b.incoming.kind
    && a.bothAvailable === b.bothAvailable;
}
