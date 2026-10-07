// 네이티브 blame 호버와 Extension Host 사이의 제한된 메시지/정보 계약이다.
import type { BlameCommitInfo } from "../git/blameHoverService";

/** renderer가 실행할 수 있는 읽기·복사·탐색 동작만 허용한다. */
export type BlameHoverAction = "load" | "dismiss" | "retry" | "copyHash" | "openCommit" | "openRemote" | "settings";

/** 한 snapshot의 특정 라인과 커밋에 고정된 renderer 요청이다. */
export interface BlameHoverRequest {
  type: "blameHover";
  action: BlameHoverAction;
  uri: string;
  revision: number;
  line: number;
  commit: string;
  requestId: number;
}

/** 상세는 호버에 필요한 정보만 직렬화하고 파일 목록/부모는 host가 액션에 재사용한다. */
export type BlameHoverDetails = Omit<BlameCommitInfo, "files" | "parents"> & { remoteUrl?: string };

/** 늦은 응답이 다른 라인의 popup에 들어가지 않도록 원래 요청 식별자를 유지한다. */
export interface BlameHoverResponse {
  uri: string;
  revision: number;
  line: number;
  commit: string;
  requestId: number;
  status: "ready" | "error" | "copied";
  details?: BlameHoverDetails;
  message?: string;
}

/** controller가 renderer 메시지를 특정 호버 presenter에 전달할 수 있는 좁은 경계다. */
export interface BlameHoverActionHandler { handleRendererAction(value: unknown): void; }

/** host의 l10n 결과를 주입된 renderer에 전달해 모든 안내·액션을 같은 표시 언어로 만든다. */
export interface BlameHoverLabels {
  title: string; loading: string; error: string; retry: string; copied: string;
  copyHash: string; openCommit: string; openRemote: string; settings: string; coAuthor: string;
  filesChanged: string; fileChanged: string; noChanges: string; insertions: string; deletions: string;
  binaryFiles: string; unknownDate: string;
}

/**
 * wire 입력을 허용된 action과 정수 식별자로 좁힌다. URI/커밋 소유권은 presenter가 snapshot과 확인한다.
 * @param value JSON에서 읽은 알 수 없는 값
 * @returns 형식이 올바른 호버 요청, 그 외 undefined
 */
export function parseBlameHoverRequest(value: unknown): BlameHoverRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as BlameHoverRequest;
  if (request.type !== "blameHover" || typeof request.uri !== "string"
    || !["load", "dismiss", "retry", "copyHash", "openCommit", "openRemote", "settings"].includes(request.action)
    || typeof request.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.commit)
    || !Number.isInteger(request.revision) || request.revision < 0 || !Number.isInteger(request.line) || request.line < 1
    || !Number.isInteger(request.requestId) || request.requestId < 1) return undefined;
  return request;
}
