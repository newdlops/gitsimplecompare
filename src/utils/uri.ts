// 커스텀 URI 스킴(gitsimplecompare:) 인코딩/디코딩 유틸.
// - 특정 ref의 파일 내용을 "가상 문서"로 띄우기 위해, ref/저장소루트/실제경로 정보를
//   하나의 URI에 담아 TextDocumentContentProvider 가 다시 꺼내 쓸 수 있게 한다.
// - vscode 타입만 의존하고 git 로직은 모른다(경계 분리).
import * as vscode from "vscode";

/** 가상 문서 식별용 커스텀 스킴 이름 */
export const COMPARE_SCHEME = "gitsimplecompare";

/** 삭제 전 파일을 일반 편집기로 여는 전용 미리보기 URI fragment. */
export const DELETED_COMPARISON_PREVIEW_FRAGMENT =
  "deleted-comparison-preview";

/** URI query 에 직렬화되는 페이로드 구조 */
interface RefUriPayload {
  ref: string;
  repoRoot: string;
  nonce?: string;
}

/**
 * 특정 ref의 파일을 가리키는 가상 문서 URI를 만든다.
 * - path 에 실제 파일 경로를 그대로 넣어 에디터가 확장자로 언어를 추론하게 한다.
 * - ref/repoRoot 는 query 에 JSON으로 담는다.
 * @param ref       git 참조(브랜치명/커밋해시 등)
 * @param fsPath    저장소 루트 기준 상대 경로(혹은 절대 경로)
 * @param repoRoot  저장소 루트 절대 경로
 * @returns 가상 문서를 가리키는 vscode.Uri
 */
export function makeRefUri(
  ref: string,
  fsPath: string,
  repoRoot: string,
  nonce?: string
): vscode.Uri {
  const payload: RefUriPayload = { ref, repoRoot, nonce };
  return vscode.Uri.from({
    scheme: COMPARE_SCHEME,
    // path 앞에 "/"를 보장해 일관된 형태를 유지한다.
    path: fsPath.startsWith("/") ? fsPath : `/${fsPath}`,
    query: JSON.stringify(payload),
  });
}

/**
 * 비교에서 완전히 삭제된 파일의 기준 버전을 읽기 전용 미리보기 URI로 만든다.
 * - 일반 ref 문서와 fragment를 달리해 diff 편집기의 왼쪽 문서와 identity가 충돌하지 않는다.
 * - BranchContentProvider는 fragment와 무관하게 같은 ref/path 캐시를 재사용할 수 있다.
 * @param ref 삭제되기 전 내용을 가진 기준 ref 또는 고정 commit hash
 * @param fsPath 기준 ref에서 읽을 저장소 상대 파일 경로
 * @param repoRoot 파일이 속한 저장소 루트 절대 경로
 * @returns 빨간 삭제 거터 전용으로 식별 가능한 읽기 전용 가상 문서 URI
 */
export function makeDeletedComparisonPreviewUri(
  ref: string,
  fsPath: string,
  repoRoot: string
): vscode.Uri {
  return makeRefUri(ref, fsPath, repoRoot).with({
    fragment: DELETED_COMPARISON_PREVIEW_FRAGMENT,
  });
}

/**
 * 주어진 URI가 삭제 파일 전체를 보여 주는 비교 미리보기인지 판별한다.
 * - scheme과 fragment를 함께 검사해 다른 확장 문서나 일반 branch diff를 잘못 장식하지 않는다.
 * @param uri 현재 보이는 텍스트 편집기의 문서 URI
 * @returns 삭제 비교 미리보기면 true
 */
export function isDeletedComparisonPreviewUri(uri: vscode.Uri): boolean {
  return (
    uri.scheme === COMPARE_SCHEME &&
    uri.fragment === DELETED_COMPARISON_PREVIEW_FRAGMENT
  );
}

/**
 * makeRefUri 로 만든 URI를 다시 해석한다.
 * - 컨텐츠 프로바이더가 어떤 ref의 어떤 파일을 읽어야 하는지 알아내는 데 쓴다.
 * @param uri 가상 문서 URI
 * @returns ref / repoRoot / 파일 경로(path)
 */
export function parseRefUri(uri: vscode.Uri): {
  ref: string;
  repoRoot: string;
  path: string;
} {
  const payload = JSON.parse(uri.query || "{}") as Partial<RefUriPayload>;
  return {
    ref: payload.ref ?? "",
    repoRoot: payload.repoRoot ?? "",
    path: uri.path,
  };
}

/**
 * diff 에디터 제목에 쓸 짧은 라벨을 만든다.
 * 예) "main ↔ feature/x — src/app.ts"
 * @param left  왼쪽(기준) 라벨
 * @param right 오른쪽(대상) 라벨
 * @param fileLabel 파일 표시 이름
 */
export function makeDiffTitle(
  left: string,
  right: string,
  fileLabel: string
): string {
  return `${left} ↔ ${right} — ${fileLabel}`;
}
