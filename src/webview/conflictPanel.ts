// 충돌 해결 전용 웹뷰 패널.
// - Current/Incoming/Result 를 한 화면에서 편집하고, 선택한 수용 전략을 ConflictService 로 적용한다.
// - git 데이터 접근은 ConflictService 에 위임하고, 이 모듈은 패널 생애주기와 메시지 라우팅만 담당한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import {
  isConflictMutationActive,
  tryAcquireConflictMutation,
} from "../git/conflictMutationCoordinator";
import { openMergeEditorUri } from "../ui/mergePresenter";
import { logError, logInfo } from "../ui/outputLog";
import {
  buildConflictPanelHtml,
  conflictSourceSignature,
  isConflictPanelGitMutation,
  isConflictPanelSerializedMessage,
  localizeConflictActionError,
  makeNonce,
} from "./conflictPanelSupport";

type ConflictPanelMessage =
  | { type: "ready" }
  | ({ sessionId: string } & (
      | { type: "saveResult"; content: string }
      | { type: "resolveMarked"; content: string }
      | { type: "acceptCurrent" }
      | { type: "acceptIncoming" }
      | { type: "acceptBoth" }
      | { type: "openNative" }
      | { type: "reload" }
      | { type: "dirtyChanged"; dirty: boolean; content: string }
      | { type: "switchSnapshot"; requestId: string; dirty: boolean; content: string }
    ));

/** 닫힌 패널의 미저장 Result를 같은 conflict snapshot에서만 복원하기 위한 메모리 초안이다. */
interface ConflictDraft {
  content: string;
  sourceSignature: string;
  resultVersion: string;
}

/** 전환 직전 웹뷰의 최신 textarea 상태를 기다리는 요청이다. */
interface PendingSwitchSnapshot {
  requestId: string;
  timer: NodeJS.Timeout;
  resolve: (received: boolean) => void;
}

/**
 * 커스텀 conflict editor 패널. 동시에 하나만 유지하고, 다른 파일을 열면 같은 패널을 재사용한다.
 */
export class ConflictPanel {
  private static current: ConflictPanel | undefined;
  private static readonly drafts = new Map<string, ConflictDraft>();
  private readonly disposables: vscode.Disposable[] = [];
  private mutating = false;
  private dirty = false;
  private draft = "";
  private sourceSignature = "";
  private resultVersion = "";
  private documentSession = "";
  private pendingSwitchSnapshot: PendingSwitchSnapshot | undefined;

  /**
   * 충돌 파일을 커스텀 편집 패널로 연다.
   * @param extensionUri 확장 루트 URI
   * @param service      대상 저장소의 ConflictService
   * @param rel          저장소 상대 경로
   * @param onDidMutate  파일 저장/해결 후 외부 뷰를 갱신하는 콜백
   */
  static async createOrShow(
    extensionUri: vscode.Uri,
    service: ConflictService,
    rel: string,
    onDidMutate: () => Promise<void>
  ): Promise<void> {
    if (isConflictMutationActive(service.repoRoot)) {
      ConflictPanel.current?.panel.reveal();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("A conflict action is still running. Try switching files again when it finishes.")
      );
      return;
    }
    if (ConflictPanel.current) {
      const current = ConflictPanel.current;
      if (current.mutating) {
        current.panel.reveal();
        void vscode.window.showInformationMessage(
          vscode.l10n.t("A conflict action is still running. Try switching files again when it finishes.")
        );
        return;
      }
      current.mutating = true;
      const previous = {
        service: current.service,
        rel: current.rel,
        onDidMutate: current.onDidMutate,
      };
      try {
        if (current.rel !== rel || current.service.repoRoot !== service.repoRoot) {
          if (!await current.captureDraftBeforeSwitch()) {
            current.panel.reveal();
            return;
          }
          if (!await current.confirmFileSwitch()) {
            current.post({ type: "actionCancelled", sessionId: current.documentSession });
            current.panel.reveal();
            return;
          }
          current.service = service;
          current.rel = rel;
          current.onDidMutate = onDidMutate;
        }
        current.panel.reveal();
        if (!current.dirty) {
          await current.reload();
        }
      } catch (err) {
        current.service = previous.service;
        current.rel = previous.rel;
        current.onDidMutate = previous.onDidMutate;
        const message = localizeConflictActionError(err);
        logError("conflict editor file switch failed", err, {
          repoRoot: service.repoRoot,
          rel,
        });
        current.post({ type: "error", message, sessionId: current.documentSession });
      } finally {
        current.mutating = false;
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.conflictEditor",
      vscode.l10n.t("Resolve Conflict"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    ConflictPanel.current = new ConflictPanel(
      panel,
      extensionUri,
      service,
      rel,
      onDidMutate
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: ConflictService,
    private rel: string,
    private onDidMutate: () => Promise<void>
  ) {
    this.panel.webview.html = buildConflictPanelHtml(this.panel.webview, this.extensionUri);
    this.panel.webview.onDidReceiveMessage(
      (msg: ConflictPanelMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    if (this.dirty && this.sourceSignature) {
      ConflictPanel.drafts.set(this.draftKey(), {
        content: this.draft,
        sourceSignature: this.sourceSignature,
        resultVersion: this.resultVersion,
      });
      logInfo("unsaved conflict Result cached after panel close", {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
      });
    }
    if (ConflictPanel.current === this) {
      ConflictPanel.current = undefined;
    }
    if (this.pendingSwitchSnapshot) {
      clearTimeout(this.pendingSwitchSnapshot.timer);
      this.pendingSwitchSnapshot.resolve(false);
      this.pendingSwitchSnapshot = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰에서 온 액션 메시지를 처리한다.
   * @param msg 웹뷰 메시지
   */
  private async handleMessage(msg: ConflictPanelMessage): Promise<void> {
    if (msg.type === "switchSnapshot") {
      this.acceptSwitchSnapshot(msg);
      return;
    }
    if (msg.type !== "ready" && msg.sessionId !== this.documentSession) {
      logInfo("stale conflict editor message skipped", {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
        type: msg.type,
      });
      return;
    }
    if (msg.type === "dirtyChanged") {
      this.dirty = msg.dirty;
      this.draft = msg.content;
      return;
    }
    const mutation = isConflictPanelSerializedMessage(msg);
    const gitMutation = isConflictPanelGitMutation(msg);
    if (mutation && this.mutating) {
      this.post({
        type: "error",
        message: vscode.l10n.t("Another conflict action is already running."),
        sessionId: this.documentSession,
      });
      return;
    }
    const release = gitMutation
      ? tryAcquireConflictMutation(this.service.repoRoot)
      : undefined;
    if (gitMutation && !release) {
      this.post({
        type: "error",
        message: vscode.l10n.t("Another conflict action is already running."),
        sessionId: this.documentSession,
      });
      return;
    }
    if (mutation) {
      this.mutating = true;
    }
    try {
      const keepsDraft = msg.type === "saveResult" || msg.type === "resolveMarked";
      if (gitMutation && !await this.confirmCurrentResultVersion(keepsDraft)) return;
      const expectedVersion = this.resultVersion;
      if (msg.type === "ready") {
        await this.reload();
      } else if (msg.type === "reload") {
        await this.reload();
      } else if (msg.type === "openNative") {
        await this.openNativeEditor();
      } else if (msg.type === "saveResult") {
        const recovery = await this.service.writeResolvedContent(
          this.rel, msg.content, false, expectedVersion, this.sourceSignature
        );
        await this.afterMutation("saved", false, recovery);
      } else if (msg.type === "resolveMarked") {
        const recovery = await this.service.writeResolvedContent(
          this.rel, msg.content, true, expectedVersion, this.sourceSignature
        );
        await this.afterMutation("resolved", true, recovery);
      } else if (msg.type === "acceptCurrent") {
        const recovery = await this.service.acceptCurrent(
          this.rel, undefined, expectedVersion, this.sourceSignature
        );
        await this.afterMutation("acceptedCurrent", true, recovery);
      } else if (msg.type === "acceptIncoming") {
        const recovery = await this.service.acceptIncoming(
          this.rel, undefined, expectedVersion, this.sourceSignature
        );
        await this.afterMutation("acceptedIncoming", true, recovery);
      } else if (msg.type === "acceptBoth") {
        const recovery = await this.service.acceptBoth(
          this.rel, expectedVersion, this.sourceSignature
        );
        await this.afterMutation("acceptedBoth", true, recovery);
      }
    } catch (err) {
      const message = localizeConflictActionError(err);
      logError("conflict editor action failed", err, {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
        type: msg.type,
      });
      this.post({ type: "error", message, sessionId: this.documentSession });
    } finally {
      if (mutation) this.mutating = false;
      release?.();
    }
  }

  /** 현재 충돌 문서를 다시 읽어 웹뷰에 보낸다. */
  private async reload(): Promise<void> {
    const document = await this.service.getConflictDocument(this.rel);
    const sourceSignature = conflictSourceSignature(document);
    const cached = ConflictPanel.drafts.get(this.draftKey());
    const retainedDraft = this.dirty &&
        this.sourceSignature === sourceSignature &&
        this.resultVersion === document.resultVersion
      ? this.draft
      : cached?.sourceSignature === sourceSignature &&
          cached.resultVersion === document.resultVersion
        ? cached.content
        : undefined;
    const draftRestored = retainedDraft !== undefined;
    ConflictPanel.drafts.delete(this.draftKey());
    this.sourceSignature = sourceSignature;
    this.resultVersion = document.resultVersion;
    this.dirty = draftRestored;
    this.draft = retainedDraft ?? document.result;
    document.result = this.draft;
    this.documentSession = makeNonce();
    this.panel.title = vscode.l10n.t("Resolve Conflict: {0}", this.rel);
    this.post({
      type: "document",
      document,
      draftRestored,
      sessionId: this.documentSession,
    });
    logInfo("conflict editor document loaded", {
      repoRoot: this.service.repoRoot,
      rel: this.rel,
      operation: document.operation,
      currentCommit: document.current.commit,
      incomingCommit: document.incoming.commit,
      rebaseStep: document.context.rebase?.currentStep?.index,
      rebaseTotal: document.context.rebase?.currentStep?.total,
      futurePathChanges: document.context.rebase?.futurePathChangeCount,
      futurePathAnalysisComplete: document.context.rebase?.futurePathAnalysisComplete,
      pendingComplexSteps: document.context.rebase?.pendingComplexSteps,
      predictedOutcome: document.context.rebase?.fileOutcome,
    });
  }

  /**
   * 파일을 수정한 뒤 관련 뷰를 갱신하고 최신 문서를 다시 보낸다.
   * @param reason 로그와 웹뷰 완료 상태에 남길 변경 이유
   * @param resolved true면 stage 2/3가 사라지기 전에 보낸 source snapshot을 화면에 유지한다
   * @param recoveryPath 동시 편집 원본을 격리 보존한 경로
   */
  private async afterMutation(
    reason: string,
    resolved: boolean,
    recoveryPath?: string
  ): Promise<void> {
    logInfo("conflict editor mutation", {
      repoRoot: this.service.repoRoot,
      rel: this.rel,
      reason,
    });
    ConflictPanel.drafts.delete(this.draftKey());
    this.dirty = false;
    if (resolved) {
      const result = await this.service.getWorkingResult(this.rel).catch((err) => {
        logError("resolved conflict result refresh failed", err, {
          repoRoot: this.service.repoRoot,
          rel: this.rel,
          reason,
        });
        return undefined;
      });
      if (result) this.draft = result.content;
      this.post({
        type: "resolved",
        reason,
        result,
        sessionId: this.documentSession,
      });
    } else {
      await this.reload();
    }
    if (recoveryPath) this.postRecoveryWarning(recoveryPath);
    try {
      await this.onDidMutate();
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason: `conflict:${reason}`,
      });
    } catch (err) {
      logError("conflict mutation follow-up refresh failed", err, {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
        reason,
      });
    }
  }

  /**
   * 파일 전환 전에 웹뷰 textarea의 최신 dirty/content를 요청해 메시지 큐 race를 없앤다.
   * @returns snapshot을 받았거나 아직 문서가 없으면 true, timeout/dispose면 false
   */
  private async captureDraftBeforeSwitch(): Promise<boolean> {
    if (!this.documentSession) return true;
    const requestId = makeNonce();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.finishSwitchSnapshot(requestId, false);
        this.post({ type: "actionCancelled", sessionId: this.documentSession });
      }, 2_000);
      this.pendingSwitchSnapshot = { requestId, timer, resolve };
      void this.panel.webview.postMessage({
        type: "prepareSwitch",
        requestId,
        sessionId: this.documentSession,
      }).then((delivered) => {
        if (!delivered) this.finishSwitchSnapshot(requestId, false);
      });
    });
  }

  /** 전환 snapshot 응답이 현재 session/request와 일치할 때만 host draft를 갱신한다. */
  private acceptSwitchSnapshot(
    msg: Extract<ConflictPanelMessage, { type: "switchSnapshot" }>
  ): void {
    const pending = this.pendingSwitchSnapshot;
    if (!pending || pending.requestId !== msg.requestId || msg.sessionId !== this.documentSession) {
      return;
    }
    this.dirty = msg.dirty;
    this.draft = msg.content;
    this.finishSwitchSnapshot(msg.requestId, true);
  }

  /** 대기 중인 snapshot 요청 하나를 정리하고 호출자에게 수신 여부를 돌려준다. */
  private finishSwitchSnapshot(requestId: string, received: boolean): void {
    const pending = this.pendingSwitchSnapshot;
    if (!pending || pending.requestId !== requestId) return;
    clearTimeout(pending.timer);
    this.pendingSwitchSnapshot = undefined;
    pending.resolve(received);
  }

  /**
   * load 이후 작업트리 Result가 바뀌었으면 reload/overwrite 의도를 명시적으로 확인한다.
   * @param keepsDraft true면 화면 draft를 쓰고, false면 선택 side가 파일 전체를 교체한다
   * @returns 선택한 mutation을 계속해도 되면 true
   */
  private async confirmCurrentResultVersion(keepsDraft = true): Promise<boolean> {
    const actualVersion = await this.service.getConflictResultVersion(this.rel);
    if (actualVersion === this.resultVersion) return true;
    const reload = vscode.l10n.t("Reload External Result");
    const overwrite = keepsDraft
      ? vscode.l10n.t("Keep My Result")
      : vscode.l10n.t("Continue with Selection");
    const choice = await vscode.window.showWarningMessage(
      keepsDraft
        ? vscode.l10n.t("The conflict Result changed outside this editor. Reload it or keep your Result and overwrite the external change?")
        : vscode.l10n.t("The conflict Result changed outside this editor. Reload it or continue with the selected whole-file action and replace the external change?"),
      { modal: true },
      reload,
      overwrite
    );
    if (choice === reload) {
      this.dirty = false;
      await this.reload();
      return false;
    }
    if (choice === overwrite) {
      this.resultVersion = actualVersion;
      return true;
    }
    this.post({ type: "actionCancelled", sessionId: this.documentSession });
    return false;
  }

  /**
   * 다른 충돌 파일로 전환하기 전에 미저장 Result를 저장할지 확인한다.
   * @returns 전환을 계속해도 되면 true, 취소하면 false
   */
  private async confirmFileSwitch(): Promise<boolean> {
    if (!this.dirty) return true;
    const save = vscode.l10n.t("Save and Switch");
    const discard = vscode.l10n.t("Discard and Switch");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("The Result for {0} has unsaved changes.", this.rel),
      { modal: true },
      save,
      discard
    );
    if (choice === save) {
      if (!await this.saveDraft("savedBeforeSwitch")) return false;
      this.dirty = false;
      return true;
    }
    if (choice === discard) {
      this.dirty = false;
      return true;
    }
    return false;
  }

  /**
   * 미저장 Result 처리 방식을 확인한 뒤 내장 merge editor를 열고 stale 패널을 닫는다.
   */
  private async openNativeEditor(): Promise<void> {
    if (this.dirty) {
      const save = vscode.l10n.t("Save and Open");
      const discard = vscode.l10n.t("Open Without Saving");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("The Result has unsaved changes. Save them before opening the native merge editor?"),
        { modal: true },
        save,
        discard
      );
      if (!choice) {
        this.post({ type: "actionCancelled", sessionId: this.documentSession });
        return;
      }
      if (choice === save) {
        if (!await this.saveDraft("savedBeforeNativeEditor")) return;
      }
    }
    logInfo("opening native conflict editor", {
      repoRoot: this.service.repoRoot,
      rel: this.rel,
    });
    await openMergeEditorUri(vscode.Uri.file(this.service.absPath(this.rel)));
    this.dirty = false;
    ConflictPanel.drafts.delete(this.draftKey());
    this.panel.dispose();
  }

  /** 미저장 draft를 공용 lease/CAS로 작업트리에 쓰고 관련 뷰를 갱신한다. */
  private async saveDraft(reason: string): Promise<boolean> {
    const release = tryAcquireConflictMutation(this.service.repoRoot);
    if (!release) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("A conflict action is still running. Try switching files again when it finishes.")
      );
      return false;
    }
    try {
      if (!await this.confirmCurrentResultVersion()) return false;
      const recoveryPath = await this.service.writeResolvedContent(
        this.rel,
        this.draft,
        false,
        this.resultVersion,
        this.sourceSignature
      );
      if (recoveryPath) this.postRecoveryWarning(recoveryPath);
      this.resultVersion = await this.service.getConflictResultVersion(this.rel);
      logInfo("conflict editor draft saved", {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
        reason,
      });
      try {
        await this.onDidMutate();
        await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
          reason: `conflict:${reason}`,
        });
      } catch (err) {
        logError("conflict draft follow-up refresh failed", err, {
          repoRoot: this.service.repoRoot,
          rel: this.rel,
          reason,
        });
      }
      return true;
    } finally {
      release();
    }
  }

  /** index/worktree 적용은 끝났지만 동시 편집 원본을 격리 보존했음을 로그와 화면에 알린다. */
  private postRecoveryWarning(recoveryPath: string): void {
    const message = vscode.l10n.t(
      "Conflict Result was applied, but a concurrent edit to the previous file was preserved at {0}. Review it before continuing.",
      recoveryPath
    );
    logInfo("concurrent conflict edit preserved", {
      repoRoot: this.service.repoRoot,
      rel: this.rel,
      recoveryPath,
    });
    void vscode.window.showWarningMessage(message);
    this.post({ type: "warning", message, sessionId: this.documentSession });
  }

  /** 현재 저장소와 충돌 경로를 닫힌 패널 초안 map의 충돌 없는 key로 만든다. */
  private draftKey(): string {
    return `${this.service.repoRoot}\0${this.rel}`;
  }

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

}
