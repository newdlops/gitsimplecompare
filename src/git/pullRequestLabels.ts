// GitHub Pull Request label 데이터를 graph UI 에서 쓰기 좋은 형태로 정규화한다.
// - 목록/검색 서비스가 같은 GraphQL selection 과 label 변환 규칙을 공유하게 한다.

/** GitHub GraphQL 에서 PR label 목록을 읽을 때 공통으로 사용하는 selection */
export const PULL_REQUEST_LABELS_QUERY = `
        labels(first: 20) {
          nodes {
            name
            color
            description
          }
        }`;

/** graph 웹뷰에 전달할 Pull Request label 한 건 */
export interface PullRequestLabelInfo {
  name: string;
  color?: string;
  description?: string;
}

/** GitHub GraphQL label connection 의 최소 응답 형태 */
export interface GhPullRequestLabels {
  nodes?: Array<{
    name?: string;
    color?: string;
    description?: string | null;
  } | null>;
}

/**
 * GitHub GraphQL label connection 을 UI 전송용 label 배열로 정규화한다.
 * - 이름이 없는 label 은 렌더링 가치가 없으므로 제외한다.
 * - color 는 GitHub 가 `#` 없는 6자리 hex 로 주지만, 방어적으로 검증해 잘못된 값은 버린다.
 * @param labels GraphQL label connection
 * @returns 이름 기준 중복이 제거된 label 배열
 */
export function normalizePullRequestLabels(
  labels: GhPullRequestLabels | undefined
): PullRequestLabelInfo[] {
  const byName = new Map<string, PullRequestLabelInfo>();
  for (const label of labels?.nodes || []) {
    const name = label?.name?.trim();
    if (!name) {
      continue;
    }
    byName.set(name, {
      name,
      color: normalizeLabelColor(label?.color),
      description: label?.description || undefined,
    });
  }
  return Array.from(byName.values());
}

/**
 * GitHub label color 를 CSS 에 안전하게 넘길 6자리 hex 문자열로 정규화한다.
 * @param color GitHub GraphQL label color 값
 * @returns 유효한 6자리 hex 문자열. 유효하지 않으면 undefined
 */
function normalizeLabelColor(color: string | undefined): string | undefined {
  const hex = String(color || "").replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : undefined;
}
