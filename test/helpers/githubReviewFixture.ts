// GitHub PR 리뷰 fixture를 안전하게 읽고 최소 계약을 검증하는 테스트 전용 유틸.
// - 실제 gh/GitHub 호출 없이 서비스 계약을 테스트하려면 응답 상태·헤더·본문이 함께 필요하다.
// - fixture 이름을 경로로 직접 사용하지 않아 테스트 입력이 fixtures 폴더 밖을 읽지 못하게 한다.
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface GitHubReviewFixture<TBody = unknown> {
  schemaVersion: 1;
  source: "gh api" | "gh api graphql" | "gh search prs" | "gh pr checks";
  operation: string;
  response: {
    status: number;
    headers: Record<string, string>;
    body?: TBody;
    stderr?: string;
  };
}

const FIXTURE_DIRECTORY = path.join(process.cwd(), "test", "fixtures", "githubReview");
const FIXTURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/**
 * 테스트 fixture 이름이 githubReview 디렉터리의 단일 JSON 파일인지 검사한다.
 * @param fixtureName 테스트가 요청한 파일 이름
 * @returns 경로 탐색 문자가 없고 .json으로 끝나면 true
 */
function isSafeFixtureName(fixtureName: string): boolean {
  return FIXTURE_NAME_PATTERN.test(fixtureName);
}

/**
 * JSON 값이 null이 아닌 일반 객체인지 판별한다.
 * @param value 검사할 알 수 없는 JSON 값
 * @returns record 형태이면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * fixture response header가 문자열 value만 갖는지 검사한다.
 * @param value headers 후보 값
 * @returns 문자열 key/value record이면 true
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((header) => typeof header === "string");
}

/**
 * fixture JSON을 서비스 contract test가 믿을 수 있는 최소 구조로 좁힌다.
 * @param value JSON.parse가 반환한 값
 * @param fixtureName 오류 메시지에 표시할 fixture 파일명
 * @returns 검증된 GitHubReviewFixture
 */
function parseFixture(value: unknown, fixtureName: string): GitHubReviewFixture {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.source !== "string" || typeof value.operation !== "string") {
    throw new Error(`Invalid GitHub review fixture metadata: ${fixtureName}`);
  }
  if (!isRecord(value.response) || typeof value.response.status !== "number" || !isStringRecord(value.response.headers)) {
    throw new Error(`Invalid GitHub review fixture response: ${fixtureName}`);
  }
  if (value.response.stderr !== undefined && typeof value.response.stderr !== "string") {
    throw new Error(`Invalid GitHub review fixture stderr: ${fixtureName}`);
  }
  if (!isKnownSource(value.source)) {
    throw new Error(`Unsupported GitHub review fixture source: ${fixtureName}`);
  }

  return {
    schemaVersion: 1,
    source: value.source,
    operation: value.operation,
    response: {
      status: value.response.status,
      headers: value.response.headers,
      body: value.response.body,
      stderr: value.response.stderr,
    },
  };
}

/**
 * fixture에 허용한 gh 호출 종류인지 확인한다.
 * @param source JSON fixture가 선언한 호출 종류
 * @returns 테스트 계약에서 지원하는 source이면 true
 */
function isKnownSource(source: string): source is GitHubReviewFixture["source"] {
  return source === "gh api" || source === "gh api graphql" || source === "gh search prs" || source === "gh pr checks";
}

/**
 * synthetic GitHub PR 리뷰 fixture 하나를 읽고 검증한다.
 * @param fixtureName githubReview 디렉터리 안의 JSON 파일명
 * @returns 응답 상태·헤더·본문을 포함한 검증된 fixture
 */
export async function loadGitHubReviewFixture<TBody = unknown>(
  fixtureName: string
): Promise<GitHubReviewFixture<TBody>> {
  if (!isSafeFixtureName(fixtureName)) {
    throw new Error(`Unsafe GitHub review fixture name: ${fixtureName}`);
  }

  const fixturePath = path.join(FIXTURE_DIRECTORY, fixtureName);
  const text = await readFile(fixturePath, "utf8");
  return parseFixture(JSON.parse(text), fixtureName) as GitHubReviewFixture<TBody>;
}
