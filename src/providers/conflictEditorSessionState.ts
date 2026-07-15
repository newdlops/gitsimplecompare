// native conflict editor session의 생성과 provider baseline mutation을 순수하게 모은다.
// - 이벤트, watcher, Git 조회는 controller가 담당하고 이 모듈은 이미 검증된 snapshot만 반영한다.
import { randomUUID } from "node:crypto";
import type { ConflictWorkingResult } from "../git/conflictContentService";
import type {
  ConflictDocument,
  ConflictService,
} from "../git/conflictService";
import type { TrustedConflictEditorSession } from "./conflictEditorOverlayController";
import {
  conflictSessionUri,
  virtualConflictDocumentText,
} from "./conflictSessionDocument";

/**
 * 이미 full read가 끝난 ConflictDocument로 새 native session 객체를 만든다.
 * @param service 대상 저장소 service
 * @param rel 저장소 상대 충돌 경로
 * @param onDidMutate 해결 뒤 tree/changes refresh callback
 * @param document full Result를 포함한 conflict snapshot
 * @param writableScheme text Result용 custom FileSystemProvider scheme
 * @param readonlyScheme 특수 Result용 readonly content scheme
 */
export function createConflictEditorSession(
  service: ConflictService,
  rel: string,
  onDidMutate: () => Promise<void>,
  document: ConflictDocument,
  writableScheme: string,
  readonlyScheme: string
): TrustedConflictEditorSession {
  const virtual = document.resultState.kind !== "text";
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    uri: conflictSessionUri(rel, id, virtual ? readonlyScheme : writableScheme),
    readOnly: virtual,
    virtual,
    service,
    rel,
    onDidMutate,
    document,
    content: virtual ? virtualConflictDocumentText(document) : document.result,
    ctime: now,
    mtime: now,
    revision: 1,
    refreshGeneration: 0,
    allowBusySave: false,
    baselineStale: false,
    busy: false,
    resolved: false,
    suspended: false,
  };
}

/** full ConflictDocument를 기존 같은-kind session의 resource baseline으로 반영한다. */
export function applyConflictDocument(
  session: TrustedConflictEditorSession,
  document: ConflictDocument
): void {
  session.document = document;
  session.baselineStale = false;
  session.content = session.virtual
    ? virtualConflictDocumentText(document)
    : document.result;
  session.mtime = Date.now();
  session.revision++;
}

/** 해결 뒤 full working Result를 provider baseline으로 반영한다. */
export function applyConflictWorkingResult(
  session: TrustedConflictEditorSession,
  result: ConflictWorkingResult
): void {
  session.document.result = result.content;
  session.document.resultState = result.state;
  session.document.resultVersion = result.version;
  session.baselineStale = false;
  session.content = session.virtual || result.state.kind !== "text"
    ? virtualConflictDocumentText(session.document, session.resolved)
    : result.content;
  session.mtime = Date.now();
  session.revision++;
}

/** save 성공 뒤 version 재조회만 실패한 resource를 추가 mutation 불가 상태로 표시한다. */
export function applyStaleSavedBaseline(
  session: TrustedConflictEditorSession,
  content: string
): void {
  session.content = content;
  session.document.result = content;
  session.baselineStale = true;
  session.mtime = Date.now();
  session.revision++;
}
