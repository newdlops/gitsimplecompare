// 활성 에디터 URI를 파일 히스토리 조회 위치로 바꾸는 순수 유틸리티.
// - 실제 작업 파일과 gitsimplecompare ref 문서를 같은 명령 흐름에서 처리하게 한다.
// - vscode API나 Git 실행에 의존하지 않아 URI 경계 조건을 단위 테스트할 수 있다.

/** 파일 히스토리 대상 판정에 필요한 URI 최소 형태 */
export interface FileHistoryResourceLike {
  scheme: string;
  fsPath: string;
  path: string;
  query: string;
}

/** 실제 작업 파일에서 저장소를 탐색해야 하는 히스토리 위치 */
export interface WorkingFileHistoryLocation {
  kind: "workingFile";
  fsPath: string;
}

/** ref 가상 문서가 이미 제공하는 저장소와 상대 경로 히스토리 위치 */
export interface RefFileHistoryLocation {
  kind: "refDocument";
  repoRoot: string;
  relPath: string;
}

/** 활성 문서에서 해석할 수 있는 파일 히스토리 위치 */
export type FileHistoryResourceLocation =
  | WorkingFileHistoryLocation
  | RefFileHistoryLocation;

interface RefUriPayload {
  ref?: unknown;
  repoRoot?: unknown;
}

/**
 * 실제 파일 또는 gitsimplecompare ref 문서를 히스토리 조회 위치로 해석한다.
 * - 삭제 diff는 작업트리 파일이 없지만 ref URI의 query에 repoRoot가, path에 Git 상대 경로가 남아 있다.
 * - 알 수 없는 scheme이나 손상된 query는 호출부가 안내 문구를 표시할 수 있도록 undefined로 반환한다.
 * @param resource VS Code URI에서 scheme/fsPath/path/query만 추린 객체
 * @returns 저장소 탐색용 실제 경로 또는 ref 문서의 저장소·상대 경로
 */
export function fileHistoryResourceLocation(
  resource: FileHistoryResourceLike
): FileHistoryResourceLocation | undefined {
  if (resource.scheme === "file") {
    return resource.fsPath
      ? { kind: "workingFile", fsPath: resource.fsPath }
      : undefined;
  }
  if (resource.scheme !== "gitsimplecompare") {
    return undefined;
  }
  const payload = parseRefPayload(resource.query);
  const repoRoot = nonEmptyString(payload?.repoRoot);
  const ref = nonEmptyString(payload?.ref);
  const relPath = normalizeRelativePath(resource.path);
  if (!repoRoot || !ref || !relPath) {
    return undefined;
  }
  return { kind: "refDocument", repoRoot, relPath };
}

/**
 * ref URI query의 JSON payload를 예외 없이 읽는다.
 * @param query makeRefUri가 직렬화한 JSON query 문자열
 * @returns object 형태의 payload 또는 JSON이 손상됐으면 undefined
 */
function parseRefPayload(query: string): RefUriPayload | undefined {
  try {
    const parsed = JSON.parse(query || "{}");
    return parsed && typeof parsed === "object"
      ? parsed as RefUriPayload
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * URI path를 Git이 받는 선행 slash 없는 POSIX 상대 경로로 정규화한다.
 * @param value URI의 decoded path 문자열
 * @returns 비어 있지 않은 저장소 상대 경로 또는 undefined
 */
function normalizeRelativePath(value: string): string | undefined {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * unknown payload 필드를 공백으로만 이루어지지 않은 문자열로 좁힌다.
 * @param value JSON payload에서 읽은 임의 값
 * @returns 유효한 문자열 또는 undefined
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
