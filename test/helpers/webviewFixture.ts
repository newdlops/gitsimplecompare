// surviving webview fixture를 안전하게 읽고 최소 schema를 검증하는 테스트 전용 유틸이다.
import { readFile } from "node:fs/promises";
import path from "node:path";

export type WebviewFixtureSurface = "changes" | "pr-preview";
export type WebviewFixtureState = "small" | "populated" | "loading" | "error" | "no-target" | "existing-pr";
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

/** fixture 요청이 허용된 단일 JSON 파일 이름인지 확인한다. */
function isSafeFixtureName(name: string): boolean { return FIXTURE_NAME_PATTERN.test(name); }
/** JSON 값이 null/array가 아닌 record인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** viewport 수치가 양의 정수인지 확인한다. */
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
/** 살아 있는 화면 이름인지 확인한다. */
function isSurface(value: unknown): value is WebviewFixtureSurface { return value === "changes" || value === "pr-preview"; }
/** fixture가 표현할 수 있는 Preview/Changes 상태인지 확인한다. */
function isState(value: unknown): value is WebviewFixtureState { return ["small", "populated", "loading", "error", "no-target", "existing-pr"].includes(String(value)); }

/** fixture JSON의 metadata, locale, 화면 크기, payload 형태를 fail-closed로 검증한다. */
export function parseWebviewFixture(value: unknown, name = "inline.json"): WebviewFixture {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isSurface(value.surface) || !isState(value.state) || (value.locale !== "en" && value.locale !== "ko")) {
    throw new Error(`Invalid webview fixture metadata: ${name}`);
  }
  if (!isRecord(value.viewport) || !isPositiveInteger(value.viewport.width) || !isPositiveInteger(value.viewport.height)) {
    throw new Error(`Invalid webview fixture viewport: ${name}`);
  }
  if (!isRecord(value.payload)) throw new Error(`Invalid webview fixture payload: ${name}`);
  return { schemaVersion: 1, surface: value.surface, state: value.state, locale: value.locale, viewport: { width: value.viewport.width, height: value.viewport.height }, payload: value.payload };
}

/** deterministic fixture를 읽고 경로 traversal와 malformed schema를 거부한다. */
export async function loadWebviewFixture<TPayload = Record<string, unknown>>(name: string): Promise<WebviewFixture<TPayload>> {
  if (!isSafeFixtureName(name)) throw new Error(`Unsafe webview fixture name: ${name}`);
  const text = await readFile(path.join(FIXTURE_DIRECTORY, name), "utf8");
  return parseWebviewFixture(JSON.parse(text), name) as WebviewFixture<TPayload>;
}
