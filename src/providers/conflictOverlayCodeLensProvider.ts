// conflict Result의 whole-file 및 marker-block 액션을 VS Code native CodeLens로 표시한다.
// - renderer overlay가 실패해도 commit 출처와 모든 핵심 해결 명령을 native editor에 남기는 fallback이다.
import * as vscode from "vscode";
import type { ConflictEditorOverlayController } from "./conflictEditorOverlayController";
import type {
  ConflictBlockActionArgs,
  ConflictOverlayAction,
  ConflictOverlayActionPayload,
  ConflictOverlaySnapshot,
} from "./conflictOverlayProtocol";

export const CONFLICT_OVERLAY_ACTION_COMMAND =
  "gitSimpleCompare.conflictOverlay.action";
export const CONFLICT_BLOCK_ACTION_COMMAND =
  "gitSimpleCompare.conflictOverlay.applyBlock";

/** native TextEditor의 conflict context와 줄별 해결 액션을 CodeLens로 제공한다. */
export class ConflictOverlayCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(private readonly controller: ConflictEditorOverlayController) {
    this.onDidChangeCodeLenses = controller.onDidChangeCodeLenses;
  }

  /**
   * 문서 상단에는 context/whole-file action을, 각 marker 위에는 block action을 만든다.
   * @param document 현재 native editor 문서
   * @returns stale session/version token이 포함된 native CodeLens 목록
   */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const state = this.controller.codeLensState(document);
    if (!state) return [];
    const snapshot = state.snapshot;
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, actionCommand(
        contextTitle(snapshot),
        snapshot.presentation.impact.detail,
        snapshot,
        "showDetails"
      )),
    ];
    if (snapshot.busy) {
      lenses.push(new vscode.CodeLens(top, {
        command: CONFLICT_OVERLAY_ACTION_COMMAND,
        title: vscode.l10n.t("Resolving..."),
        tooltip: vscode.l10n.t("A conflict action is currently running"),
        arguments: [],
      }));
      return lenses;
    }
    lenses.push(
      new vscode.CodeLens(top, actionCommand(
        snapshot.presentation.actions.current,
        snapshot.presentation.actions.currentTooltip,
        snapshot,
        "acceptCurrent"
      )),
      new vscode.CodeLens(top, actionCommand(
        snapshot.presentation.actions.incoming,
        snapshot.presentation.actions.incomingTooltip,
        snapshot,
        "acceptIncoming"
      ))
    );
    if (snapshot.canAcceptBoth) {
      lenses.push(new vscode.CodeLens(top, actionCommand(
        snapshot.presentation.actions.both,
        snapshot.presentation.actions.bothTooltip,
        snapshot,
        "acceptBoth"
      )));
    }
    if (snapshot.canMarkResolved) {
      lenses.push(new vscode.CodeLens(top, actionCommand(
        snapshot.presentation.actions.resolved,
        snapshot.presentation.actions.resolvedTooltip,
        snapshot,
        "markResolved"
      )));
    }
    if (snapshot.canOpenMergeEditor) {
      lenses.push(new vscode.CodeLens(top, actionCommand(
        snapshot.presentation.actions.mergeEditor,
        snapshot.presentation.actions.mergeEditorTooltip,
        snapshot,
        "openMergeEditor"
      )));
    }
    if (snapshot.canEditBlocks) {
      snapshot.blocks.forEach((block, index) => {
        const range = new vscode.Range(block.startLine, 0, block.startLine, 0);
        lenses.push(
          blockLens(range, snapshot, block.id, index + 1, "current"),
          blockLens(range, snapshot, block.id, index + 1, "incoming"),
          blockLens(range, snapshot, block.id, index + 1, "both")
        );
      });
    }
    return lenses;
  }
}

/** overlay snapshot과 action을 host가 재검증할 command payload로 만든다. */
function actionCommand(
  title: string,
  tooltip: string,
  snapshot: ConflictOverlaySnapshot,
  action: ConflictOverlayAction
): vscode.Command {
  const payload: ConflictOverlayActionPayload = {
    type: "conflictAction",
    action,
    uri: snapshot.uri,
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    editorVersion: snapshot.editorVersion,
  };
  return {
    command: CONFLICT_OVERLAY_ACTION_COMMAND,
    title,
    tooltip,
    arguments: [payload],
  };
}

/** 한 marker block의 선택 command와 상세 tooltip을 만든다. */
function blockLens(
  range: vscode.Range,
  snapshot: ConflictOverlaySnapshot,
  blockId: string,
  number: number,
  choice: "current" | "incoming" | "both"
): vscode.CodeLens {
  const title = choice === "current"
    ? vscode.l10n.t("Current")
    : choice === "incoming"
      ? vscode.l10n.t("Incoming")
      : vscode.l10n.t("Both");
  const tooltip = choice === "current"
    ? vscode.l10n.t("Apply Current block {0} to Result", number)
    : choice === "incoming"
      ? vscode.l10n.t("Apply Incoming block {0} to Result", number)
      : vscode.l10n.t("Apply Both block {0} to Result", number);
  const args: ConflictBlockActionArgs = {
    uri: snapshot.uri,
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    editorVersion: snapshot.editorVersion,
    blockId,
    choice,
  };
  return new vscode.CodeLens(range, {
    command: CONFLICT_BLOCK_ACTION_COMMAND,
    title,
    tooltip,
    arguments: [args],
  });
}

/** 상단 fallback CodeLens에 operation, 두 commit, 최종 영향이 모두 남도록 압축한다. */
function contextTitle(snapshot: ConflictOverlaySnapshot): string {
  const cards = snapshot.presentation.cards;
  const current = cards.find((card) => card.tone === "current")?.identity || "";
  const incoming = cards.find((card) => card.tone === "incoming")?.identity || "";
  return [
    snapshot.presentation.operation,
    `${vscode.l10n.t("Current")}: ${current}`,
    `${vscode.l10n.t("Incoming")}: ${incoming}`,
    snapshot.presentation.impact.title,
  ].join("  →  ");
}
