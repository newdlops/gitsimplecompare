// Webview fixture를 안전하게 읽고 PR-00의 최소 schema를 검증하는 테스트 전용 유틸.
// - 실제 GitHub·사용자 workspace 데이터 없이 UI renderer가 기대하는 상태를 재현한다.
import { readFile } from "node:fs/promises";
import path from "node:path";

export type WebviewFixtureSurface = "changes" | "reviews" | "review-workspace";
export type WebviewFixtureState = "small" | "large" | "error" | "populated" | "cached";

/** browser fixture가 공통으로 가지는 metadata와 renderer payload의 최소 계약이다. */
export interface WebviewFixture<TPayload = Record<string, unknown>> {
  schemaVersion: 1;
  surface: WebviewFixtureSurface;
  state: WebviewFixtureState;
  locale: "en" | "ko";
  viewport: { width: number; height: number };
  payload: TPayload;
}

const FIXTURE_DIRECTORY = path.join(process.cwd(), "test", "fixtures", "webview");
const FIXTURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** fixture 요청 이름이 webview fixture 디렉터리의 단일 JSON 파일인지 검사한다. */
function isSafeFixtureName(fixtureName: string): boolean {
  return FIXTURE_NAME_PATTERN.test(fixtureName);
}

/** JSON 값이 null/array가 아닌 record인지 좁힌다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** fixture JSON의 공통 metadata와 화면 크기 계약을 검사한다. */
function parseFixture(value: unknown, fixtureName: string): WebviewFixture {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isKnownSurface(value.surface) || !isKnownState(value.state) || (value.locale !== "en" && value.locale !== "ko")) {
    throw new Error(`Invalid webview fixture metadata: ${fixtureName}`);
  }
  if (!isRecord(value.viewport) || !isPositiveInteger(value.viewport.width) || !isPositiveInteger(value.viewport.height)) {
    throw new Error(`Invalid webview fixture viewport: ${fixtureName}`);
  }
  if (!isRecord(value.payload)) {
    throw new Error(`Invalid webview fixture payload: ${fixtureName}`);
  }
  return {
    schemaVersion: 1,
    surface: value.surface,
    state: value.state,
    locale: value.locale,
    viewport: { width: value.viewport.width, height: value.viewport.height },
    payload: value.payload,
  };
}

/** 허용한 UI surface 이름인지 검사한다. */
function isKnownSurface(value: unknown): value is WebviewFixtureSurface {
  return value === "changes" || value === "reviews" || value === "review-workspace";
}

/** PR-00 fixture가 구분해야 할 대표 상태인지 검사한다. */
function isKnownState(value: unknown): value is WebviewFixtureState {
  return value === "small" || value === "large" || value === "error" || value === "populated" || value === "cached";
}

/** viewport 값이 CSS pixel 기준의 양의 정수인지 검사한다. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 이름으로 지정한 deterministic webview fixture를 읽고 최소 schema를 보장한다. */
export async function loadWebviewFixture<TPayload = Record<string, unknown>>(
  fixtureName: string
): Promise<WebviewFixture<TPayload>> {
  if (!isSafeFixtureName(fixtureName)) {
    throw new Error(`Unsafe webview fixture name: ${fixtureName}`);
  }
  const fixturePath = path.join(FIXTURE_DIRECTORY, fixtureName);
  const text = await readFile(fixturePath, "utf8");
  return parseFixture(JSON.parse(text), fixtureName) as WebviewFixture<TPayload>;
}
