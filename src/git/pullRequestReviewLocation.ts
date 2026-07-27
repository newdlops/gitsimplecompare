// GitHub AddPullRequestReviewThreadInput에 전달할 file/line/range 위치 검증 모델.
// - UI 선택 방식과 무관하게 service가 안전한 path·side·line invariant를 한 번만 강제한다.

/** GitHub diff에서 review comment가 붙는 좌/우 side. */
export type PullRequestReviewDiffSide = "LEFT" | "RIGHT";

/** line anchor가 아닌 파일 전체에 붙는 review thread 위치. */
export interface PullRequestFileReviewLocation {
  /** 변경 파일의 repository 상대 경로 */
  path: string;
  /** file-level comment임을 명시하는 subject type */
  subjectType: "FILE";
}

/** 단일 또는 연속 범위 diff line에 붙는 review thread 위치. */
export interface PullRequestLineReviewLocation {
  /** 변경 파일의 repository 상대 경로 */
  path: string;
  /** line-level comment임을 명시하는 subject type */
  subjectType: "LINE";
  /** 끝 라인이 속한 diff side */
  side: PullRequestReviewDiffSide;
  /** 끝 라인의 1-based line number */
  line: number;
  /** multi-line range의 시작 side. 현재 GitHub 규칙상 end side와 같아야 한다. */
  startSide?: PullRequestReviewDiffSide;
  /** multi-line range의 시작 1-based line number */
  startLine?: number;
}

/** pending review thread가 지원하는 모든 anchor 종류. */
export type PullRequestReviewLocation = PullRequestFileReviewLocation | PullRequestLineReviewLocation;

/** GraphQL variables와 inline literal selection에 안전한 normalized location. */
export type NormalizedPullRequestReviewLocation = PullRequestReviewLocation & {
  /** 공백을 제거한 repository 상대 path */
  path: string;
};

/** UI/호출자가 전달한 location을 GitHub GraphQL 계약에 맞는 안정된 값으로 정규화한다. */
export function normalizePullRequestReviewLocation(
  location: PullRequestReviewLocation
): NormalizedPullRequestReviewLocation {
  const path = normalizePath(location.path);
  if (location.subjectType === "FILE") return { subjectType: "FILE", path };
  if (!isSide(location.side) || !isPositiveInteger(location.line)) {
    throw new Error("A line review comment needs a valid side and line number.");
  }
  const hasStart = location.startLine !== undefined || location.startSide !== undefined;
  if (!hasStart) return { subjectType: "LINE", path, side: location.side, line: location.line };
  if (!isPositiveInteger(location.startLine) || !isSide(location.startSide) || location.startSide !== location.side || location.startLine >= location.line) {
    throw new Error("A multi-line review comment needs an earlier start line on the same side.");
  }
  if (location.line - location.startLine >= 100) {
    throw new Error("A review comment range cannot span 100 or more lines.");
  }
  return {
    subjectType: "LINE",
    path,
    side: location.side,
    line: location.line,
    startSide: location.startSide,
    startLine: location.startLine,
  };
}

/** repo root escape·absolute path·빈 path 없이 GitHub가 기대하는 relative POSIX path만 허용한다. */
function normalizePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("A review comment needs a valid repository-relative file path.");
  }
  return path;
}

/** GitHub DiffSide enum으로 안전하게 직렬화할 수 있는 값인지 확인한다. */
function isSide(value: unknown): value is PullRequestReviewDiffSide {
  return value === "LEFT" || value === "RIGHT";
}

/** GraphQL line input에 쓸 수 있는 양의 정수인지 확인한다. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
