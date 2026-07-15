// native conflict overlay와 CodeLens action을 immutable click context에서 실행한다.
// - renderer payload는 신뢰하지 않고 host session/CAS/version fence를 매 await 뒤 다시 확인한다.
import * as vscode from "vscode";
import { tryAcquireConflictMutation } from "../git/conflictMutationCoordinator";
import type {
  ConflictEditorOverlayController,
  TrustedConflictActionContext,
  TrustedConflictEditorSession,
} from "../providers/conflictEditorOverlayController";
import {
  CONFLICT_BLOCK_ACTION_COMMAND,
  CONFLICT_OVERLAY_ACTION_COMMAND,
} from "../providers/conflictOverlayCodeLensProvider";
import type {
  ConflictBlockActionArgs,
  ConflictOverlayActionHandler,
  ConflictOverlayActionPayload,
} from "../providers/conflictOverlayProtocol";
import {
  localizeConflictActionError,
  showConflictRecoveryWarning,
} from "../ui/conflictActionMessages";
import { openMergeEditorUri } from "../ui/mergePresenter";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import { conflictBlockChoiceEdit } from "../utils/conflictMarkerModel";

const VALID_ACTIONS = new Set<ConflictOverlayActionPayload["action"]>([
  "acceptCurrent",
  "acceptIncoming",
  "acceptBoth",
  "markResolved",
  "openMergeEditor",
  "reload",
  "showDetails",
]);

/** renderer와 CodeLens 요청을 직렬화하고 ConflictService exact action으로 연결한다. */
export class ConflictEditorActions implements ConflictOverlayActionHandler {
  constructor(private readonly overlay: ConflictEditorOverlayController) {}

  /** native CodeLens가 호출할 whole-file 및 marker-block command를 등록한다. */
  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.commands.registerCommand(
        CONFLICT_OVERLAY_ACTION_COMMAND,
        (payload: ConflictOverlayActionPayload) => this.executeAction(payload)
      ),
      vscode.commands.registerCommand(
        CONFLICT_BLOCK_ACTION_COMMAND,
        (args: ConflictBlockActionArgs) => this.applyBlockSafely(args)
      )
    );
  }

  /** renderer binding 이벤트를 fire-and-forget action 실행으로 전달한다. */
  handleRendererAction(payload: ConflictOverlayActionPayload): void {
    void this.executeAction(payload);
  }

  /** payload를 클릭 순간 immutable 기준선으로 바꾼 뒤 한 session action만 실행한다. */
  private async executeAction(payload: ConflictOverlayActionPayload): Promise<void> {
    if (!payload || payload.type !== "conflictAction" || !VALID_ACTIONS.has(payload.action)) {
      return;
    }
    const context = this.overlay.trustedActionContext(payload);
    if (!context) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Conflict context changed. Use the refreshed controls and try again.")
      );
      return;
    }
    const session = context.session;
    this.overlay.setBusy(session, true);
    try {
      if (payload.action === "showDetails") {
        await this.showDetails(session);
      } else if (payload.action === "reload") {
        await this.reload(context);
      } else if (payload.action === "openMergeEditor") {
        await this.openMergeEditor(context);
      } else if (payload.action === "markResolved") {
        await this.markResolved(context);
      } else {
        await this.acceptWholeFile(context, payload.action);
      }
    } catch (error) {
      logError("native conflict editor action failed", error, {
        repoRoot: session.service.repoRoot,
        rel: session.rel,
        action: payload.action,
      });
      void vscode.window.showErrorMessage(localizeConflictActionError(error));
    } finally {
      this.overlay.setBusy(session, false);
    }
  }

  /** marker block command 오류를 command rejection 대신 로그와 사용자 알림으로 닫는다. */
  private async applyBlockSafely(args: ConflictBlockActionArgs): Promise<void> {
    try {
      await this.applyBlock(args);
    } catch (error) {
      logError("native conflict block action failed", error, {
        uri: args?.uri,
        blockId: args?.blockId,
        choice: args?.choice,
      });
      void vscode.window.showErrorMessage(localizeConflictActionError(error));
    }
  }

  /**
   * 한 완결된 marker block을 현재 native buffer에서만 교체한다.
   * - choice/session/version을 runtime 재검증하고 busy lock 안에서 한 WorkspaceEdit만 적용한다.
   */
  private async applyBlock(args: ConflictBlockActionArgs): Promise<void> {
    if (!isBlockArgs(args)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Conflict block changed. Use the refreshed controls and try again.")
      );
      return;
    }
    const session = this.overlay.trustedBlockSession(args);
    if (!session || session.virtual) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Conflict block changed. Use the refreshed controls and try again.")
      );
      return;
    }
    this.overlay.setBusy(session, true);
    try {
      const document = this.overlay.textDocument(session);
      if (!document || document.version !== args.editorVersion) return;
      const raw = document.getText();
      const blockEdit = conflictBlockChoiceEdit(raw, args.blockId, args.choice);
      if (!blockEdit || document.version !== args.editorVersion) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Conflict block changed. Use the refreshed controls and try again.")
        );
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(blockEdit.startOffset),
          document.positionAt(blockEdit.endOffset)
        ),
        blockEdit.replacement
      );
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error(vscode.l10n.t("Could not apply the selected conflict block."));
      }
      const expected = `${raw.slice(0, blockEdit.startOffset)}` +
        `${blockEdit.replacement}${raw.slice(blockEdit.endOffset)}`;
      const current = this.overlay.textDocument(session);
      if (
        current !== document || current.getText() !== expected ||
        !vscode.window.state.focused || vscode.window.activeTextEditor?.document !== document
      ) {
        this.warnConcurrentBuffer(session, args.editorVersion);
        return;
      }
      logInfo("native conflict block applied", {
        repoRoot: session.service.repoRoot,
        rel: session.rel,
        blockId: args.blockId,
        choice: args.choice,
      });
    } finally {
      this.overlay.setBusy(session, false);
    }
  }

  /** exact Current/Incoming/Both로 파일 전체와 index stage를 함께 해결한다. */
  private async acceptWholeFile(
    context: TrustedConflictActionContext,
    action: "acceptCurrent" | "acceptIncoming" | "acceptBoth"
  ): Promise<void> {
    const session = context.session;
    const document = this.overlay.textDocument(session);
    const discardDirty = Boolean(document?.isDirty);
    if (discardDirty && !await this.confirmDiscardDirty(context)) return;
    const expectedResult = await this.confirmOnDiskResultVersion(context, false);
    if (expectedResult === undefined) return;
    const editorVersion = context.editorVersion;
    if (!this.overlay.isActionCurrent(context, editorVersion)) return;
    const release = this.acquireLease(session);
    if (!release) return;
    let recoveryPath: string | undefined;
    try {
      recoveryPath = action === "acceptCurrent"
        ? await session.service.acceptCurrent(
            session.rel, undefined, expectedResult, context.sourceVersion
          )
        : action === "acceptIncoming"
          ? await session.service.acceptIncoming(
              session.rel, undefined, expectedResult, context.sourceVersion
            )
          : await session.service.acceptBoth(
              session.rel, expectedResult, context.sourceVersion
            );
    } finally {
      release();
    }
    await this.finalizeResolved(
      session,
      action,
      recoveryPath,
      editorVersion,
      discardDirty
    );
  }

  /** 클릭 시점 buffer 또는 exact 특수 Result를 source/result fence와 함께 stage 0으로 기록한다. */
  private async markResolved(context: TrustedConflictActionContext): Promise<void> {
    const session = context.session;
    const document = this.overlay.textDocument(session);
    if (!document) return;
    if (document.version !== context.editorVersion) return;
    const editorVersion = context.editorVersion;
    const content = session.virtual ? undefined : document.getText();
    const wasDirty = document.isDirty;
    if (["submodule", "nonfile"].includes(session.document.resultState.kind)) {
      throw new Error(
        "Manual Result editing is not available for symlink, directory, or other non-regular file conflicts."
      );
    }
    const expectedResult = await this.confirmOnDiskResultVersion(
      context,
      !session.virtual
    );
    if (expectedResult === undefined) return;
    if (!this.overlay.isActionCurrent(context, editorVersion)) return;
    const release = this.acquireLease(session);
    if (!release) return;
    let recoveryPath: string | undefined;
    try {
      if (content === undefined) {
        await session.service.markResolved(
          session.rel,
          expectedResult,
          context.sourceVersion
        );
      } else {
        recoveryPath = await session.service.writeResolvedContent(
          session.rel,
          content,
          true,
          expectedResult,
          context.sourceVersion
        );
      }
    } finally {
      release();
    }
    await this.finalizeResolved(
      session,
      "markResolved",
      recoveryPath,
      editorVersion,
      wasDirty
    );
  }

  /** 외부 Result와 source context를 다시 읽고 dirty buffer는 명시 확인 뒤 provider baseline으로 바꾼다. */
  private async reload(context: TrustedConflictActionContext): Promise<void> {
    const session = context.session;
    const document = this.overlay.textDocument(session);
    if (!document) return;
    const editorVersion = context.editorVersion;
    if (!this.overlay.isActionCurrent(context, editorVersion)) return;
    const dirty = document.isDirty;
    if (dirty) {
      const discard = vscode.l10n.t("Discard and Reload");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("The native Result has unsaved changes. Discard them and reload the conflict?"),
        { modal: true },
        discard
      );
      if (choice !== discard || !this.overlay.isActionCurrent(context, editorVersion)) return;
    }
    if (!await this.overlay.refreshSession(session, "manualReload", true)) return;
    if (dirty) {
      const synchronized = await this.overlay.replaceBufferAndSave(
        session,
        editorVersion,
        session.content
      );
      if (!synchronized) this.warnConcurrentBuffer(session, editorVersion);
    }
  }

  /** dirty Result 처리 뒤 VS Code 3-way merge editor로 전환하고 성공한 동안만 overlay를 숨긴다. */
  private async openMergeEditor(context: TrustedConflictActionContext): Promise<void> {
    const session = context.session;
    if (session.virtual || session.document.resultState.kind !== "text") return;
    const document = this.overlay.textDocument(session);
    if (!document) return;
    if (!this.overlay.isActionCurrent(context, context.editorVersion)) return;
    if (document.isDirty) {
      const save = vscode.l10n.t("Save and Open");
      const discard = vscode.l10n.t("Open Without Saving");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("The Result has unsaved changes. Save them before opening the native merge editor?"),
        { modal: true },
        save,
        discard
      );
      if (!choice || !this.overlay.isActionCurrent(context, context.editorVersion)) return;
      const version = context.editorVersion;
      const prepared = choice === save
        ? await this.overlay.saveNativeDocument(session, version, context)
        : await this.overlay.replaceBufferAndSave(
            session,
            version,
            session.content,
            context
          );
      if (!prepared) return;
      const preparedDocument = this.overlay.textDocument(session);
      if (!preparedDocument || preparedDocument.isDirty) {
        this.warnConcurrentBuffer(session, version);
        return;
      }
    }
    const preparedDocument = this.overlay.textDocument(session);
    if (
      !preparedDocument || preparedDocument.isDirty || !vscode.window.state.focused ||
      vscode.window.activeTextEditor?.document !== preparedDocument
    ) return;
    const preparedVersion = preparedDocument.version;
    const expectedSource = session.document.sourceVersion;
    const expectedResult = session.document.resultVersion;
    const opened = await openMergeEditorUri(
      vscode.Uri.file(session.service.absPath(session.rel)),
      false,
      true,
      async () => {
        const latest = await session.service.getConflictDocument(session.rel, true);
        const valid = this.overlay.textDocument(session) === preparedDocument &&
          preparedDocument.version === preparedVersion && !preparedDocument.isDirty &&
          vscode.window.state.focused && vscode.window.activeTextEditor?.document === preparedDocument &&
          latest.sourceVersion === expectedSource && latest.resultVersion === expectedResult &&
          latest.resultState.kind === "text";
        if (!valid) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Conflict context changed. Use the refreshed controls and try again.")
          );
        }
        return valid;
      }
    );
    if (opened && this.overlay.isCurrent(session)) {
      this.overlay.suspend(session, "openMergeEditor");
    }
  }

  /** context fallback CodeLens 클릭 시 card 원문을 native QuickPick으로 보여준다. */
  private async showDetails(session: TrustedConflictEditorSession): Promise<void> {
    const document = this.overlay.textDocument(session);
    const presentation = document
      ? this.overlay.codeLensState(document)?.snapshot.presentation
      : undefined;
    if (!presentation) return;
    await vscode.window.showQuickPick(
      presentation.cards.map((card) => ({
        label: card.title,
        description: card.identity,
        detail: [card.secondary, card.state, card.detail].filter(Boolean).join(" · "),
      })),
      {
        title: `${presentation.title}: ${presentation.path}`,
        placeHolder: `${presentation.impact.title} — ${presentation.impact.detail}`,
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
  }

  /** whole-file action이 dirty Result 편집을 모두 교체한다는 명시 동의를 받는다. */
  private async confirmDiscardDirty(
    context: TrustedConflictActionContext
  ): Promise<boolean> {
    const discard = vscode.l10n.t("Discard Result Edits and Continue");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("This whole-file action replaces all unsaved Result edits. Discard them and continue?"),
      { modal: true },
      discard
    );
    return choice === discard && this.overlay.isActionCurrent(
      context,
      context.editorVersion
    );
  }

  /** 클릭 이후 disk Result가 바뀌었으면 reload 또는 명시적 overwrite 의도를 확인한다. */
  private async confirmOnDiskResultVersion(
    context: TrustedConflictActionContext,
    keepsResult: boolean
  ): Promise<string | undefined> {
    const session = context.session;
    const actualVersion = await session.service.getConflictResultVersion(session.rel);
    if (!this.overlay.isActionCurrent(context, context.editorVersion)) return undefined;
    if (actualVersion === context.resultVersion) return actualVersion;
    const reload = vscode.l10n.t("Reload External Result");
    const overwrite = keepsResult
      ? vscode.l10n.t("Keep My Result")
      : vscode.l10n.t("Continue with Selection");
    const choice = await vscode.window.showWarningMessage(
      keepsResult
        ? vscode.l10n.t("The conflict Result changed outside this editor. Reload it or keep your Result and overwrite the external change?")
        : vscode.l10n.t("The conflict Result changed outside this editor. Reload it or continue with the selected whole-file action and replace the external change?"),
      { modal: true },
      reload,
      overwrite
    );
    if (!this.overlay.isActionCurrent(context, context.editorVersion)) return undefined;
    if (choice === reload) {
      await this.reload(context);
      return undefined;
    }
    return choice === overwrite ? actualVersion : undefined;
  }

  /**
   * Git 성공 직후 authoritative resolved 상태를 먼저 게시하고 editor 동기화 실패는 경고로 격리한다.
   * - follow-up UI refresh가 실패해도 이미 성공한 index mutation을 오류로 오인시키지 않는다.
   */
  private async finalizeResolved(
    session: TrustedConflictEditorSession,
    reason: string,
    recoveryPath?: string,
    observedEditorVersion?: number,
    synchronizeBuffer = false
  ): Promise<void> {
    if (recoveryPath) {
      showConflictRecoveryWarning(session.service.repoRoot, session.rel, recoveryPath);
    }
    let published = false;
    try {
      published = await this.overlay.publishResolvedResult(session, reason);
    } catch (error) {
      logError("native conflict resolved Result refresh failed", error, {
        repoRoot: session.service.repoRoot,
        rel: session.rel,
        reason,
      });
    }
    this.overlay.markResolved(session, reason);
    if (synchronizeBuffer && observedEditorVersion !== undefined && published) {
      try {
        const synchronized = await this.overlay.replaceBufferAndSave(
          session,
          observedEditorVersion,
          session.content
        );
        if (!synchronized) this.warnConcurrentBuffer(session, observedEditorVersion);
      } catch (error) {
        logWarn("native conflict resolved buffer sync failed", {
          repoRoot: session.service.repoRoot,
          rel: session.rel,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        this.warnConcurrentBuffer(session, observedEditorVersion);
      }
    } else if (synchronizeBuffer && observedEditorVersion !== undefined && !published) {
      this.warnConcurrentBuffer(session, observedEditorVersion);
    } else if (observedEditorVersion !== undefined) {
      const current = this.overlay.textDocument(session);
      if (current?.isDirty && current.version !== observedEditorVersion) {
        this.warnConcurrentBuffer(session, observedEditorVersion);
      }
    }
    try {
      await session.onDidMutate();
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason: `conflict:${reason}`,
      });
    } catch (error) {
      logError("native conflict mutation follow-up refresh failed", error, {
        repoRoot: session.service.repoRoot,
        rel: session.rel,
        reason,
      });
    }
    logInfo("native conflict editor mutation completed", {
      repoRoot: session.service.repoRoot,
      rel: session.rel,
      reason,
    });
  }

  /** service 중 들어온 새 typing은 덮지 않고 남겼음을 사용자와 OUTPUT에 알린다. */
  private warnConcurrentBuffer(
    session: TrustedConflictEditorSession,
    beforeVersion: number
  ): void {
    const document = this.overlay.textDocument(session);
    logWarn("native conflict editor changed during resolution", {
      repoRoot: session.service.repoRoot,
      rel: session.rel,
      beforeVersion,
      afterVersion: document?.version,
      dirty: document?.isDirty,
    });
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Edits made during conflict resolution were kept in the editor. Review them before saving.")
    );
  }

  /** 저장소 공용 conflict lease를 얻고 실패하면 즉시 사용자에게 알린다. */
  private acquireLease(
    session: TrustedConflictEditorSession
  ): (() => void) | undefined {
    const release = tryAcquireConflictMutation(session.service.repoRoot);
    if (!release) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Another conflict action is already running.")
      );
    }
    return release;
  }
}

/** untyped command argument가 허용된 block action shape인지 검사한다. */
function isBlockArgs(value: ConflictBlockActionArgs | undefined): value is ConflictBlockActionArgs {
  return !!value && typeof value.uri === "string" && typeof value.sessionId === "string" &&
    Number.isInteger(value.revision) && Number.isInteger(value.editorVersion) &&
    typeof value.blockId === "string" &&
    ["current", "incoming", "both"].includes(value.choice);
}
