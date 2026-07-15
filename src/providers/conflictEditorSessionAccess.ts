// native conflict session에서 CodeLens snapshot과 immutable action 권한을 계산한다.
// - controller의 수명주기/refresh와 분리해 모든 클릭 검증이 같은 active URI/version 규칙을 사용한다.
import * as vscode from "vscode";
import { buildConflictOverlayPresentation } from "../ui/conflictOverlayPresentation";
import { scanConflictMarkers } from "../utils/conflictMarkerModel";
import type { TrustedConflictEditorSession } from "./conflictEditorOverlayController";
import type {
  ConflictOverlayActionPayload,
  ConflictOverlaySnapshot,
} from "./conflictOverlayProtocol";

/** 클릭 순간 사용자가 본 source/result/editor 기준선을 고정한 action context다. */
export interface TrustedConflictActionContext {
  readonly session: TrustedConflictEditorSession;
  readonly sourceVersion: string;
  readonly resultVersion: string;
  readonly editorVersion: number;
  readonly revision: number;
}

/** CodeLens provider가 현재 문서에서 사용할 안전한 session view다. */
export interface ConflictCodeLensState {
  session: TrustedConflictEditorSession;
  snapshot: ConflictOverlaySnapshot;
}

/** 한 native document의 context와 marker block CodeLens snapshot을 만든다. */
export function buildConflictCodeLensState(
  session: TrustedConflictEditorSession | undefined,
  document: vscode.TextDocument
): ConflictCodeLensState | undefined {
  if (!session || session.resolved || session.suspended || session.baselineStale) {
    return undefined;
  }
  const markerScan = !session.virtual && session.document.resultState.kind === "text"
    ? scanConflictMarkers(document.getText())
    : { blocks: [] };
  const snapshot: ConflictOverlaySnapshot = {
    uri: session.uri.toString(),
    sessionId: session.id,
    revision: session.revision,
    editorVersion: document.version,
    busy: session.busy,
    virtual: session.virtual,
    canEditBlocks: !session.virtual && session.document.resultState.kind === "text",
    canAcceptBoth: session.document.bothAvailable,
    canMarkResolved: !["submodule", "nonfile"].includes(session.document.resultState.kind),
    canOpenMergeEditor: !session.virtual && session.document.resultState.kind === "text",
    blocks: markerScan.blocks,
    presentation: buildConflictOverlayPresentation(session.document),
  };
  return { session, snapshot };
}

/** renderer/CodeLens token과 active URI를 검증하고 immutable 클릭 기준선을 반환한다. */
export function trustedConflictActionContext(
  session: TrustedConflictEditorSession | undefined,
  document: vscode.TextDocument | undefined,
  payload: Pick<
    ConflictOverlayActionPayload,
    "uri" | "sessionId" | "revision" | "editorVersion"
  >,
  windowFocused: boolean,
  activeUri: string | undefined
): TrustedConflictActionContext | undefined {
  if (
    !session || !document || !windowFocused || session.resolved || session.suspended ||
    session.busy || session.baselineStale || session.id !== payload.sessionId ||
    session.revision !== payload.revision || document.version !== payload.editorVersion ||
    activeUri !== payload.uri
  ) return undefined;
  return Object.freeze({
    session,
    sourceVersion: session.document.sourceVersion,
    resultVersion: session.document.resultVersion,
    editorVersion: document.version,
    revision: session.revision,
  });
}

/** marker CodeLens token이 현재 active document와 같은 session/revision인지 검증한다. */
export function trustedConflictBlockSession(
  session: TrustedConflictEditorSession | undefined,
  document: vscode.TextDocument | undefined,
  args: {
    uri: string;
    sessionId: string;
    revision: number;
    editorVersion: number;
  },
  windowFocused: boolean,
  activeUri: string | undefined
): TrustedConflictEditorSession | undefined {
  return session && document && windowFocused && !session.resolved && !session.suspended &&
    !session.busy && !session.baselineStale && session.id === args.sessionId &&
    session.revision === args.revision && document.version === args.editorVersion &&
    activeUri === args.uri
    ? session
    : undefined;
}

/** action await 뒤에도 같은 session/document와 active editor version인지 확인한다. */
export function isConflictActionCurrent(
  context: TrustedConflictActionContext,
  currentSession: TrustedConflictEditorSession | undefined,
  document: vscode.TextDocument | undefined,
  editorVersion: number | undefined,
  windowFocused: boolean,
  activeUri: string | undefined
): boolean {
  return currentSession === context.session && !context.session.resolved &&
    !context.session.suspended && context.session.busy && windowFocused && !!document &&
    context.session.revision === context.revision + 1 &&
    context.session.document.sourceVersion === context.sourceVersion &&
    context.session.document.resultVersion === context.resultVersion &&
    (editorVersion === undefined || document.version === editorVersion) &&
    activeUri === context.session.uri.toString();
}
