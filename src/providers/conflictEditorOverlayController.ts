// native conflict Result 문서, trusted action token, overlay/CodeLens 갱신 상태를 관리한다.
// - 실제 저장은 custom FileSystemProvider에서 ConflictService의 no-follow/CAS 경로로만 수행한다.
import * as vscode from "vscode";
import { ConflictService, type ConflictDocument } from "../git/conflictService";
import { logError, logInfo } from "../ui/outputLog";
import type { ConflictOverlayActionPayload, ConflictOverlaySnapshot } from "./conflictOverlayProtocol";
import type { ConflictsController, ConflictsRefreshSnapshot } from "./conflictsController";
import { ConflictReadonlyContentProvider, ConflictResultFileSystemProvider,
  type ConflictResultResource, type ConflictResultResourceHost } from "./conflictResultDocumentProvider";
import { watchConflictResultFile } from "./conflictResultWatcher";
import { ConflictResultSaveCoordinator } from "./conflictResultSaveCoordinator";
import { virtualConflictDocumentText } from "./conflictSessionDocument";
import { applyConflictDocument, applyConflictWorkingResult,
  applyStaleSavedBaseline, createConflictEditorSession } from "./conflictEditorSessionState";
import { buildConflictCodeLensState, isConflictActionCurrent,
  trustedConflictActionContext, trustedConflictBlockSession,
  type ConflictCodeLensState, type TrustedConflictActionContext } from "./conflictEditorSessionAccess";

export type { ConflictCodeLensState, TrustedConflictActionContext } from "./conflictEditorSessionAccess";

export const CONFLICT_OVERLAY_SCHEME = "gitsimplecompare-conflict";
export const CONFLICT_READONLY_SCHEME = "gitsimplecompare-conflict-readonly";

/** command 계층만 사용할 수 있는 host 소유 conflict editor session이다. */
export interface TrustedConflictEditorSession extends ConflictResultResource {
  readonly id: string;
  readonly service: ConflictService;
  readonly rel: string;
  readonly onDidMutate: () => Promise<void>;
  watcher?: vscode.Disposable;
  virtual: boolean;
  document: ConflictDocument;
  revision: number;
  refreshGeneration: number;
  pendingRefreshReason?: string;
  pendingSaveFence?: { sourceVersion: string; resultVersion: string };
  baselineStale: boolean;
  allowBusySave: boolean;
  busy: boolean;
  resolved: boolean;
  suspended: boolean;
}

/** native TextEditor와 안전한 Result resource, overlay session 수명주기를 조정한다. */
export class ConflictEditorOverlayController
implements vscode.Disposable, ConflictResultResourceHost {
  private readonly sessions = new Map<string, TrustedConflictEditorSession>();
  private readonly onDidChangeOverlayEmitter = new vscode.EventEmitter<void>();
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private readonly resultFiles: ConflictResultFileSystemProvider;
  private readonly readonlyDocuments: ConflictReadonlyContentProvider;
  private readonly saves: ConflictResultSaveCoordinator;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private uiRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly onDidChangeOverlay = this.onDidChangeOverlayEmitter.event;
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly conflicts: ConflictsController) {
    this.resultFiles = new ConflictResultFileSystemProvider(this);
    this.readonlyDocuments = new ConflictReadonlyContentProvider(this);
    this.saves = new ConflictResultSaveCoordinator(this);
  }

  /** custom resource provider와 native editor 생명주기 이벤트를 등록한다. */
  register(): vscode.Disposable {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(
        CONFLICT_OVERLAY_SCHEME,
        this.resultFiles,
        { isCaseSensitive: true }
      ),
      vscode.workspace.registerTextDocumentContentProvider(
        CONFLICT_READONLY_SCHEME,
        this.readonlyDocuments
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.onActiveTextEditorChanged(editor)
      ),
      vscode.window.onDidChangeVisibleTextEditors(() => this.fireUiChanged("visibleEditors")),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.onDocumentChanged(event.document)
      ),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.onDocumentClosed(document.uri)
      ),
      this.conflicts.onDidRefresh((snapshot) => this.onConflictsRefreshed(snapshot))
    );
    return this;
  }

  /**
   * 충돌 Result를 VS Code native TextEditor로 연다.
   * - text는 writable custom FS, symlink/binary/absent/nonfile은 readonly content scheme을 사용한다.
   */
  async open(
    service: ConflictService,
    rel: string,
    onDidMutate: () => Promise<void>
  ): Promise<void> {
    const document = await service.getConflictDocument(rel, true);
    if (this.disposed) return;
    this.invalidateSameConflictSessions(service.repoRoot, rel);
    await this.openLoadedSession(service, rel, onDidMutate, document);
  }

  /** FileSystemProvider/readonly provider가 현재 URI resource를 찾을 때 사용한다. */
  resourceForUri(uri: vscode.Uri): ConflictResultResource | undefined {
    return this.sessions.get(uri.toString());
  }

  /**
   * native Save를 service CAS로 기록하고 최신 Result baseline을 session에 반영한다.
   * - unresolved이면 source fence까지 검사하고 resolved 문서는 worktree CAS만 수행한다.
   */
  async writeResource(resource: ConflictResultResource, content: string): Promise<void> {
    await this.saves.writeResource(resource, content);
  }

  /** 현재 active native editor에 대응하는 renderer snapshot을 만든다. */
  overlaySnapshot(): ConflictOverlaySnapshot | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor ? this.codeLensState(editor.document)?.snapshot : undefined;
  }

  /** 한 native document의 context와 marker block CodeLens snapshot을 만든다. */
  codeLensState(document: vscode.TextDocument): ConflictCodeLensState | undefined {
    return buildConflictCodeLensState(
      this.sessions.get(document.uri.toString()),
      document
    );
  }

  /** renderer/CodeLens token과 active URI를 검증하고 클릭 시점 기준선을 immutable하게 고정한다. */
  trustedActionContext(
    payload: Pick<
      ConflictOverlayActionPayload,
      "uri" | "sessionId" | "revision" | "editorVersion"
    >
  ): TrustedConflictActionContext | undefined {
    const session = this.sessions.get(payload.uri);
    return trustedConflictActionContext(
      session, session && this.textDocument(session), payload, vscode.window.state.focused,
      vscode.window.activeTextEditor?.document.uri.toString()
    );
  }

  /** marker CodeLens token이 현재 active document와 같은 session/revision인지 검증한다. */
  trustedBlockSession(args: {
    uri: string;
    sessionId: string;
    revision: number;
    editorVersion: number;
  }): TrustedConflictEditorSession | undefined {
    const session = this.sessions.get(args.uri);
    return trustedConflictBlockSession(
      session, session && this.textDocument(session), args, vscode.window.state.focused,
      vscode.window.activeTextEditor?.document.uri.toString()
    );
  }

  /** action await 뒤에도 같은 session/document가 유효한지 확인한다. */
  isActionCurrent(
    context: TrustedConflictActionContext,
    editorVersion?: number
  ): boolean {
    return isConflictActionCurrent(
      context, this.sessions.get(context.session.uri.toString()),
      this.textDocument(context.session), editorVersion, vscode.window.state.focused,
      vscode.window.activeTextEditor?.document.uri.toString()
    );
  }

  /** 현재 native buffer를 provider CAS로 저장하며 outer action 중에는 이 save만 명시 허용한다. */
  async saveNativeDocument(
    session: TrustedConflictEditorSession,
    expectedEditorVersion: number,
    fence?: Pick<TrustedConflictActionContext, "sourceVersion" | "resultVersion">
  ): Promise<boolean> {
    return this.saves.saveNativeDocument(session, expectedEditorVersion, fence);
  }

  /** stale typing이 없을 때만 native buffer 전체를 provider baseline으로 바꾸고 안전하게 저장한다. */
  async replaceBufferAndSave(
    session: TrustedConflictEditorSession,
    expectedEditorVersion: number,
    content: string,
    fence?: Pick<TrustedConflictActionContext, "sourceVersion" | "resultVersion">
  ): Promise<boolean> {
    return this.saves.replaceBufferAndSave(
      session,
      expectedEditorVersion,
      content,
      fence
    );
  }

  /** session의 현재 열린 native TextDocument를 object identity까지 검증해 찾는다. */
  textDocument(session: TrustedConflictEditorSession): vscode.TextDocument | undefined {
    if (!this.isCurrent(session)) return undefined;
    return vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === session.uri.toString()
    );
  }

  /** map의 현재 값이 바로 이 session인지 검사해 close/reopen stale action을 막는다. */
  isCurrent(session: TrustedConflictEditorSession): boolean {
    return !this.disposed && this.sessions.get(session.uri.toString()) === session;
  }

  /** 특정 URI가 conflict overlay session에 속하는지 빠르게 판별한다. */
  ownsUri(uri: vscode.Uri): boolean {
    const session = this.sessions.get(uri.toString());
    return !!session && !session.resolved && !session.suspended;
  }

  /** decoration처럼 같은 host 내부 UI가 URI의 현재 unresolved session을 재사용한다. */
  sessionForUri(uri: vscode.Uri): TrustedConflictEditorSession | undefined {
    const session = this.sessions.get(uri.toString());
    return session && !session.resolved ? session : undefined;
  }

  /** action/save busy 상태를 바꾸고 미뤄 둔 외부 refresh를 종료 뒤 한 번 실행한다. */
  setBusy(session: TrustedConflictEditorSession, busy: boolean): void {
    if (!this.isCurrent(session) || session.busy === busy) return;
    session.refreshGeneration++;
    session.busy = busy;
    session.revision++;
    this.fireUiChanged(busy ? "actionStarted" : "actionFinished");
    if (!busy && session.pendingRefreshReason && !session.resolved) {
      const reason = session.pendingRefreshReason;
      session.pendingRefreshReason = undefined;
      this.scheduleSessionRefresh(session.uri, reason, 0);
    }
  }

  /**
   * 외부 index/Result 변경 뒤 full ConflictDocument를 generation-safe하게 다시 읽는다.
   * @param allowBusy 명시적인 reload/save action처럼 현재 action 안에서 조회할 때만 true
   */
  async refreshSession(
    session: TrustedConflictEditorSession,
    reason: string,
    allowBusy = false
  ): Promise<boolean> {
    if (!this.isCurrent(session) || session.resolved) return false;
    if (session.busy && !allowBusy) {
      session.pendingRefreshReason = reason;
      return true;
    }
    const generation = ++session.refreshGeneration;
    try {
      const document = await session.service.getConflictDocument(session.rel, true);
      if (!this.isCurrent(session) || generation !== session.refreshGeneration) return false;
      if (!allowBusy && this.textDocument(session)?.isDirty) {
        session.pendingRefreshReason = reason;
        return true;
      }
      const virtual = document.resultState.kind !== "text";
      if (virtual !== session.virtual) {
        await this.reopenForResultKindChange(session, document);
        return false;
      }
      this.commitDocument(session, document, reason);
      return true;
    } catch (error) {
      if (!this.isCurrent(session) || generation !== session.refreshGeneration) return false;
      if (/no longer conflicted|Reload the conflict editor/i.test(errorText(error))) {
        const published = await this.publishResolvedResult(session, reason)
          .catch(() => false);
        if (published && this.isCurrent(session)) this.markResolved(session, reason);
        return false;
      }
      logError("native conflict editor session refresh failed", error, {
        repoRoot: session.service.repoRoot,
        rel: session.rel,
        reason,
      });
      throw error;
    }
  }

  /** 해결 mutation 뒤 full working Result를 custom provider baseline으로 게시한다. */
  async publishResolvedResult(
    session: TrustedConflictEditorSession,
    reason: string
  ): Promise<boolean> {
    const generation = ++session.refreshGeneration;
    const result = await session.service.getWorkingResult(session.rel, true);
    if (!this.isCurrent(session) || generation !== session.refreshGeneration) return false;
    this.updateWorkingResult(session, result, reason);
    logInfo("native conflict Result baseline published", {
      repoRoot: session.service.repoRoot,
      rel: session.rel,
      reason,
      resultKind: result.state.kind,
    });
    return true;
  }

  /** 해결된 session의 overlay/CodeLens를 제거하되 열린 native Result 문서는 유지한다. */
  markResolved(session: TrustedConflictEditorSession, reason: string): void {
    if (!this.isCurrent(session)) return;
    session.resolved = true;
    session.pendingRefreshReason = undefined;
    session.revision++;
    session.watcher?.dispose();
    session.watcher = undefined;
    if (session.virtual) {
      session.content = virtualConflictDocumentText(session.document, true);
      session.mtime = Date.now();
      this.fireResourceChanged(session);
    }
    this.fireUiChanged(reason);
    logInfo("native conflict editor session resolved", {
      repoRoot: session.service.repoRoot,
      rel: session.rel,
      reason,
    });
  }

  /** native merge editor가 열린 동안 일반 Result overlay/CodeLens를 숨긴다. */
  suspend(session: TrustedConflictEditorSession, reason: string): void {
    if (!this.isCurrent(session)) return;
    session.suspended = true;
    session.busy = false;
    session.revision++;
    this.fireUiChanged(reason);
  }

  /** 등록한 provider/event/timer/session을 모두 정리한다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.uiRefreshTimer) clearTimeout(this.uiRefreshTimer);
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    for (const session of this.sessions.values()) session.watcher?.dispose();
    this.sessions.clear();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.resultFiles.dispose();
    this.readonlyDocuments.dispose();
    this.onDidChangeOverlayEmitter.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  /** 이미 읽은 ConflictDocument로 고유 native session URI를 만들고 editor를 연다. */
  private async openLoadedSession(
    service: ConflictService,
    rel: string,
    onDidMutate: () => Promise<void>,
    document: ConflictDocument
  ): Promise<void> {
    const session = createConflictEditorSession(
      service,
      rel,
      onDidMutate,
      document,
      CONFLICT_OVERLAY_SCHEME,
      CONFLICT_READONLY_SCHEME
    );
    this.sessions.set(session.uri.toString(), session);
    session.watcher = watchConflictResultFile(
      service.absPath(rel),
      (watchReason) => {
        if (this.isCurrent(session) && !session.resolved) {
          this.scheduleSessionRefresh(
            session.uri,
            `worktree:${watchReason}`,
            0
          );
        }
      }
    );
    try {
      const textDocument = await vscode.workspace.openTextDocument(session.uri);
      if (!this.isCurrent(session)) return;
      await vscode.window.showTextDocument(textDocument, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      });
      if (!this.isCurrent(session)) return;
    } catch (error) {
      session.watcher?.dispose();
      if (this.sessions.get(session.uri.toString()) === session) {
        this.sessions.delete(session.uri.toString());
      }
      throw error;
    }
    this.fireUiChanged("opened");
    logInfo("native conflict editor opened", {
      repoRoot: service.repoRoot,
      rel,
      uri: session.uri.toString(),
      virtual: session.virtual,
      resultKind: document.resultState.kind,
      operation: document.operation,
    });
  }

  /** full document 조회 결과를 session/provider/UI에 한 번에 반영한다. */
  private commitDocument(
    session: TrustedConflictEditorSession,
    document: ConflictDocument,
    reason: string
  ): void {
    applyConflictDocument(session, document);
    this.fireResourceChanged(session);
    this.fireUiChanged(reason);
    logInfo("native conflict editor session refreshed", {
      repoRoot: session.service.repoRoot,
      rel: session.rel,
      reason,
      revision: session.revision,
    });
  }

  /** full working Result를 current session의 provider baseline으로 원자적으로 갱신한다. */
  updateWorkingResult(
    session: TrustedConflictEditorSession,
    result: import("../git/conflictContentService").ConflictWorkingResult,
    reason: string
  ): void {
    applyConflictWorkingResult(session, result);
    this.fireResourceChanged(session);
    this.fireUiChanged(reason);
  }

  /** save는 성공했지만 version 재조회에 실패한 session을 추가 mutation 불가 상태로 표시한다. */
  markSaveBaselineStale(
    session: TrustedConflictEditorSession,
    content: string
  ): void {
    if (!this.isCurrent(session)) return;
    applyStaleSavedBaseline(session, content);
    this.fireResourceChanged(session);
    this.fireUiChanged("nativeSaveBaselineStale");
  }

  /** Result kind가 text↔특수 파일로 바뀌면 기존 URI를 무효화하고 올바른 scheme으로 다시 연다. */
  private async reopenForResultKindChange(
    session: TrustedConflictEditorSession,
    document: ConflictDocument
  ): Promise<void> {
    session.resolved = true;
    session.suspended = true;
    session.watcher?.dispose();
    session.watcher = undefined;
    session.content = vscode.l10n.t(
      "The conflict Result type changed. Continue in the newly opened native editor."
    );
    session.mtime = Date.now();
    this.fireResourceChanged(session);
    this.fireUiChanged("resultKindChanged");
    await this.openLoadedSession(
      session.service,
      session.rel,
      session.onDidMutate,
      document
    );
    void vscode.window.showInformationMessage(
      vscode.l10n.t("The conflict Result type changed, so a safe native editor was reopened.")
    );
  }

  /** custom Result document가 다시 active가 되면 merge 전환용 suspension을 해제한다. */
  private onActiveTextEditorChanged(editor: vscode.TextEditor | undefined): void {
    const session = editor && this.sessions.get(editor.document.uri.toString());
    if (session?.suspended && !session.resolved) {
      session.suspended = false;
      session.revision++;
    }
    this.fireUiChanged("activeEditor");
  }

  /** native buffer 편집은 token revision만 즉시 폐기하고 UI repaint는 debounce한다. */
  private onDocumentChanged(document: vscode.TextDocument): void {
    const session = this.sessions.get(document.uri.toString());
    if (!session || session.virtual || session.resolved) return;
    session.refreshGeneration++;
    session.revision++;
    this.scheduleUiChanged("documentChanged");
  }

  /** 닫힌 editor의 session과 예약 refresh를 제거해 오래된 action을 무효화한다. */
  private onDocumentClosed(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.refreshTimers.get(key);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(key);
    const session = this.sessions.get(key);
    session?.watcher?.dispose();
    if (this.sessions.delete(key)) this.fireUiChanged("documentClosed");
  }

  /** ConflictsController가 index를 갱신하면 같은 저장소 session을 다시 검증한다. */
  private onConflictsRefreshed(snapshot: ConflictsRefreshSnapshot): void {
    for (const session of this.sessions.values()) {
      if (session.service.repoRoot !== snapshot.repoRoot) continue;
      if (session.resolved) {
        if (snapshot.conflicts.includes(session.rel) && !session.suspended) {
          session.suspended = true;
          session.revision++;
          this.fireUiChanged("resolvedSessionReconflicted");
        }
        continue;
      }
      session.refreshGeneration++;
      if (!snapshot.conflicts.includes(session.rel)) {
        void this.publishResolvedResult(session, "conflictsRefreshResolved")
          .then(async (published) => {
            if (!published || !this.isCurrent(session)) return;
            const latest = await session.service.listConflicts();
            if (this.isCurrent(session) && !latest.includes(session.rel)) {
              this.markResolved(session, "conflictsRefreshResolved");
            }
          })
          .catch((error) => logError(
            "native conflict external resolution refresh failed",
            error,
            { repoRoot: session.service.repoRoot, rel: session.rel }
          ));
      } else {
        this.scheduleSessionRefresh(session.uri, "conflictsRefresh", 0);
      }
    }
  }

  /** 저장/외부 갱신 burst를 session별 마지막 조회 하나로 합친다. */
  private scheduleSessionRefresh(uri: vscode.Uri, reason: string, delay: number): void {
    const key = uri.toString();
    const session = this.sessions.get(key);
    if (!session || session.resolved || this.disposed) return;
    const previous = this.refreshTimers.get(key);
    if (previous) clearTimeout(previous);
    this.refreshTimers.set(key, setTimeout(() => {
      if (this.sessions.get(key) !== session) return;
      this.refreshTimers.delete(key);
      void this.refreshSession(session, reason).catch(() => undefined);
    }, delay));
  }

  /** 같은 repo/path의 이전 native 문서를 stale 안내로 바꾸고 command 권한을 폐기한다. */
  private invalidateSameConflictSessions(repoRoot: string, rel: string): void {
    for (const session of this.sessions.values()) {
      if (session.service.repoRoot !== repoRoot || session.rel !== rel) continue;
      const timer = this.refreshTimers.get(session.uri.toString());
      if (timer) clearTimeout(timer);
      this.refreshTimers.delete(session.uri.toString());
      session.resolved = true;
      session.suspended = true;
      session.watcher?.dispose();
      session.watcher = undefined;
      session.content = vscode.l10n.t(
        "This conflict editor was replaced by a newer native session."
      );
      session.mtime = Date.now();
      session.revision++;
      this.fireResourceChanged(session);
    }
  }

  /** resource scheme에 맞는 provider change event를 발생시킨다. */
  private fireResourceChanged(session: TrustedConflictEditorSession): void {
    if (session.uri.scheme === CONFLICT_OVERLAY_SCHEME) {
      this.resultFiles.fireChanged(session.uri);
    } else {
      this.readonlyDocuments.fireChanged(session.uri);
    }
  }

  /** 잦은 typing 이벤트의 renderer/CodeLens repaint를 짧게 합친다. */
  private scheduleUiChanged(reason: string): void {
    if (this.uiRefreshTimer) clearTimeout(this.uiRefreshTimer);
    this.uiRefreshTimer = setTimeout(() => {
      this.uiRefreshTimer = undefined;
      this.fireUiChanged(reason);
    }, 80);
  }

  /** renderer overlay와 CodeLens provider에 동일한 refresh 신호를 보낸다. */
  private fireUiChanged(reason: string): void {
    if (this.disposed) return;
    this.onDidChangeOverlayEmitter.fire();
    this.onDidChangeCodeLensesEmitter.fire();
    if (reason !== "documentChanged") {
      logInfo("native conflict editor UI refresh requested", { reason });
    }
  }
}

/** unknown error를 로그/분기에 사용할 문자열로 정규화한다. */
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
