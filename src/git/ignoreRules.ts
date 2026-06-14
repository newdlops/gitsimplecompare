// git ignore/exclude 규칙 파일을 다루는 보조 모듈.
// - GitService 가 git 명령 실행 경계를 유지하도록, 순수 경로 정규화와 파일 쓰기만 분리한다.
// - .gitignore 와 .git/info/exclude 모두 같은 루트 기준 패턴 규칙을 사용한다.
import * as path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";

/** ignore 규칙을 추가할 대상 파일 종류. */
export type IgnoreTarget = "gitignore" | "exclude";

/** ignore 처리 후 이미 추적 중인 파일을 인덱스에서 제거한 결과. */
export interface UntrackResult {
  removed: string[];
  skipped: string[];
}

/**
 * 선택 경로를 .gitignore 또는 .git/info/exclude 에 추가한다.
 * - 저장소 루트 기준 패턴(`/path` 또는 `/dir/`)으로 기록해 같은 이름의 다른 파일과
 *   섞이지 않게 한다.
 * - 이미 같은 패턴이 있으면 중복으로 쓰지 않는다.
 * @param repoRoot 저장소 루트 절대 경로
 * @param target 규칙을 쓸 대상 파일
 * @param paths 저장소 상대 경로 목록
 * @param resolveGitPath `git rev-parse --git-path` 결과를 제공하는 함수
 * @returns 실제로 새로 추가된 ignore 패턴 목록
 */
export async function appendIgnoreEntries(
  repoRoot: string,
  target: IgnoreTarget,
  paths: string[],
  resolveGitPath: (gitPath: string) => Promise<string>
): Promise<string[]> {
  const entries = uniqueStrings(
    paths
      .map((p) => ignorePatternForPath(p))
      .filter((p): p is string => !!p)
  );
  if (!entries.length) {
    return [];
  }
  const filePath = await ignoreFilePath(repoRoot, target, resolveGitPath);
  await mkdir(path.dirname(filePath), { recursive: true });

  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const existing = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  const missing = entries.filter((entry) => !existing.has(entry));
  if (!missing.length) {
    return [];
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(filePath, `${prefix}${missing.join("\n")}\n`, "utf8");
  return missing;
}

/**
 * Git pathspec 인자로 넘길 경로 목록을 고유하게 정리한다.
 * @param paths 저장소 상대 경로 후보 목록
 */
export function gitPathArgs(paths: string[]): string[] {
  return uniqueStrings(
    paths
      .map((p) => normalizeRepoPath(p))
      .filter((p): p is string => !!p)
  );
}

/**
 * `git ls-files -u -z` 출력을 충돌 파일 경로 집합으로 파싱한다.
 * @param output NUL 로 구분된 unmerged index entry 출력
 */
export function parseUnmergedPaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record) {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab >= 0) {
      paths.add(record.slice(tab + 1));
    }
  }
  return paths;
}

/**
 * ignore 규칙 대상 파일의 실제 경로를 반환한다.
 * - exclude 는 worktree 공통/분리 git-dir 구성을 지원하기 위해 `git rev-parse --git-path`
 *   결과를 사용한다.
 * @param repoRoot 저장소 루트 절대 경로
 * @param target ignore 대상 종류
 * @param resolveGitPath git-dir 상대 경로를 실제 경로로 해석하는 함수
 */
async function ignoreFilePath(
  repoRoot: string,
  target: IgnoreTarget,
  resolveGitPath: (gitPath: string) => Promise<string>
): Promise<string> {
  if (target === "gitignore") {
    return path.join(repoRoot, ".gitignore");
  }
  const resolved = await resolveGitPath("info/exclude");
  return path.resolve(repoRoot, resolved.trim());
}

/**
 * 경로 문자열을 Git 이 기대하는 저장소 상대 POSIX 경로로 정규화한다.
 * @param value 저장소 상대 경로 후보
 * @returns 빈 경로면 undefined, 아니면 정규화된 경로
 */
function normalizeRepoPath(value: string): string | undefined {
  const raw = String(value ?? "").replace(/\\/g, "/");
  const hasTrailingSlash = raw.endsWith("/");
  const normalized = raw
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  if (!normalized) {
    return undefined;
  }
  return hasTrailingSlash ? `${normalized}/` : normalized;
}

/**
 * ignore 파일에 쓸 루트 기준 패턴을 만든다.
 * @param value 저장소 상대 경로 후보
 */
function ignorePatternForPath(value: string): string | undefined {
  const normalized = normalizeRepoPath(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.endsWith("/")) {
    return `/${normalized.replace(/\/+$/, "")}/`;
  }
  return `/${normalized}`;
}

/**
 * 순서를 유지하면서 문자열 중복을 제거한다.
 * @param values 중복 제거 대상 문자열 목록
 */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
