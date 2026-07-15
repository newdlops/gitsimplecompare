// native conflict custom FileSystemProvider의 save와 buffer 동기화를 조정한다.
// - service mutation 성공과 후속 UI refresh 실패를 분리하고 모든 쓰기에 no-follow/CAS fence를 적용한다.
import * as vscode from "vscode";
import { tryAcquireConflictMutation } from "../git/conflictMutationCoordinator";
import {
  localizeConflictActionError,
  showConflictRecoveryWarning,
} from "../ui/conflictActionMessages";
import { logError, logInfo } from "../ui/outputLog";
import type {
  ConflictEditorOverlayController,
  TrustedConflictActionContext,
  TrustedConflictEditorSession,
} from "./conflictEditorOverlayController";
import type { ConflictResultResource } from "./conflictResultDocumentProvider";

/** custom Result resource 저장과 native buffer의 resource-scoped 교체를 담당한다. */
export class ConflictResultSaveCoordinator {
  constructor(private readonly overlay: ConflictEditorOverlayController) {}

  /**
   * native Save bytes를 service CAS로 기록하고 최신 Result baseline을 best-effort로 다시 읽는다.
   * - unresolved이면 source fence까지 검사하고 resolved 문서는 worktree CAS만 수행한다.
   * @param resource provider가 writeFile에서 받은 현재 session resource
   * @param content 저장할 UTF-8 Result text
   */
  async writeResource(
    resource: ConflictResultResource,
    content: string
  ): Promise<void> {
    const current = this.overlay.resourceForUri(resource.uri);
    const session = current === resource
      ? resource as TrustedConflictEditorSession
      : undefined;
    const nestedActionSave = session?.busy && session.allowBusySave;
    if (
      !session || session.virtual || session.suspended || session.baselineStale ||
      session.document.resultState.kind !== "text" ||
      (session.busy && !nestedActionSave)
    ) {
      throw vscode.FileSystemError.Unavailable(
        vscode.l10n.t("This conflict Result cannot be saved right now.")
      );
    }
    const release = tryAcquireConflictMutation(session.service.repoRoot);
    if (!release) {
      throw vscode.FileSystemError.Unavailable(
        vscode.l10n.t("Another conflict action is already running.")
      );
    }
    const ownsBusy = !session.busy;
    if (ownsBusy) this.overlay.setBusy(session, true);
    const saveFence = session.pendingSaveFence ?? {
      sourceVersion: session.document.sourceVersion,
      resultVersion: session.document.resultVersion,
    };
    let recoveryPath: string | undefined;
    try {
      try {
        recoveryPath = session.resolved
          ? await session.service.writeWorkingContent(
              session.rel,
              content,
              saveFence.resultVersion
            )
          : await session.service.writeResolvedContent(
              session.rel,
              content,
              false,
              saveFence.resultVersion,
              saveFence.sourceVersion
            );
        if (recoveryPath) {
          showConflictRecoveryWarning(session.service.repoRoot, session.rel, recoveryPath);
        }
        logInfo("native conflict Result saved through CAS provider", {
          repoRoot: session.service.repoRoot,
          rel: session.rel,
          resolved: session.resolved,
        });
      } catch (error) {
        logError("native conflict Result save failed", error, {
          repoRoot: session.service.repoRoot,
          rel: session.rel,
        });
        throw vscode.FileSystemError.Unavailable(localizeConflictActionError(error));
      }
      try {
        const result = await session.service.getWorkingResult(session.rel, true);
        if (this.overlay.isCurrent(session)) {
          this.overlay.updateWorkingResult(session, result, "nativeSaveBaseline");
          if (!session.resolved) {
            await this.overlay.refreshSession(session, "nativeSaveContext", true);
          }
        }
      } catch (error) {
        logError("native conflict Result saved but context refresh failed", error, {
          repoRoot: session.service.repoRoot,
          rel: session.rel,
          recoveryPath,
        });
        if (this.overlay.isCurrent(session)) {
          this.overlay.markSaveBaselineStale(session, content);
          this.offerBaselineRefresh(session);
        }
      }
    } finally {
      release();
      if (ownsBusy) this.overlay.setBusy(session, false);
    }
  }

  /** 현재 native buffer를 provider CAS로 저장하며 outer action 중에는 이 save만 허용한다. */
  async saveNativeDocument(
    session: TrustedConflictEditorSession,
    expectedEditorVersion: number,
    fence?: Pick<TrustedConflictActionContext, "sourceVersion" | "resultVersion">
  ): Promise<boolean> {
    const document = this.activeDocument(session, expectedEditorVersion);
    if (!document) return false;
    const expectedContent = document.getText();
    session.allowBusySave = true;
    session.pendingSaveFence = fence && {
      sourceVersion: fence.sourceVersion,
      resultVersion: fence.resultVersion,
    };
    try {
      const saved = await document.save();
      const current = this.activeDocument(session, expectedEditorVersion);
      return saved && current === document && !document.isDirty &&
        document.getText() === expectedContent;
    } finally {
      session.allowBusySave = false;
      session.pendingSaveFence = undefined;
    }
  }

  /** stale typing이 없을 때만 native buffer 전체를 provider baseline으로 바꾸고 저장한다. */
  async replaceBufferAndSave(
    session: TrustedConflictEditorSession,
    expectedEditorVersion: number,
    content: string,
    fence?: Pick<TrustedConflictActionContext, "sourceVersion" | "resultVersion">
  ): Promise<boolean> {
    const document = this.activeDocument(session, expectedEditorVersion);
    if (!document) return false;
    const raw = document.getText();
    if (raw !== content) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(raw.length)),
        content
      );
      if (!await vscode.workspace.applyEdit(edit)) return false;
    }
    const current = this.activeDocument(session);
    return current === document && current.getText() === content
      ? this.saveNativeDocument(session, current.version, fence)
      : false;
  }

  /** baseline 후속 조회 실패 시 사용자가 명시적으로 최신 CAS 기준선을 다시 읽게 한다. */
  private offerBaselineRefresh(session: TrustedConflictEditorSession): void {
    const refresh = vscode.l10n.t("Refresh Baseline");
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Result was saved safely, but its latest baseline could not be refreshed. Reload before another conflict action."
      ),
      refresh
    ).then((choice) => {
      if (choice === refresh && this.overlay.isCurrent(session)) {
        void this.recoverBaseline(session).catch((error) => {
          logError("native conflict stale save baseline recovery failed", error, {
            repoRoot: session.service.repoRoot,
            rel: session.rel,
          });
          void vscode.window.showErrorMessage(localizeConflictActionError(error));
        });
      }
    });
  }

  /** dirty Result의 보존/폐기를 먼저 확인한 뒤 resolved/unresolved 기준선을 올바르게 복구한다. */
  private async recoverBaseline(session: TrustedConflictEditorSession): Promise<void> {
    const document = this.activeDocument(session);
    if (!document || !session.baselineStale) return;
    const editorVersion = document.version;
    let keepDirty = false;
    if (document.isDirty) {
      const discard = vscode.l10n.t("Discard and Reload");
      const keep = vscode.l10n.t("Keep My Result");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "The Result changed again after the last save. Reload the on-disk Result or keep your edits for an explicit overwrite?"
        ),
        { modal: true },
        discard,
        keep
      );
      if (!this.activeDocument(session, editorVersion) || !session.baselineStale) return;
      if (choice !== discard && choice !== keep) return;
      keepDirty = choice === keep;
    }
    const refreshed = session.resolved
      ? await this.overlay.publishResolvedResult(session, "recoverStaleSave")
      : await this.overlay.refreshSession(session, "recoverStaleSave", true);
    if (!refreshed || !this.overlay.isCurrent(session)) return;
    if (keepDirty || !document.isDirty) return;
    const current = this.activeDocument(session, editorVersion);
    if (!current) return;
    const synchronized = await this.replaceBufferAndSave(
      session,
      editorVersion,
      session.content,
      {
        sourceVersion: session.document.sourceVersion,
        resultVersion: session.document.resultVersion,
      }
    );
    if (!synchronized) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The Result changed while reloading. Review the editor before saving.")
      );
    }
  }

  /** action 보조 저장이 현재 focused native Result 문서에만 적용되도록 object/version을 검증한다. */
  private activeDocument(
    session: TrustedConflictEditorSession,
    expectedVersion?: number
  ): vscode.TextDocument | undefined {
    const document = this.overlay.textDocument(session);
    const active = vscode.window.activeTextEditor?.document;
    if (!vscode.window.state.focused || !document || active !== document) return undefined;
    return expectedVersion === undefined || document.version === expectedVersion
      ? document
      : undefined;
  }
}
