// git commit 실패 출력을 UI 에 표시할 파일/행 진단 목록으로 변환하는 순수 파서.
// - ESLint/TypeScript/Ruff/Prettier/pre-commit/Husky처럼 흔한 형식을 느슨하게 인식한다.
// - 특정 도구 출력에 종속되지 않으며, 해석하지 못한 실패도 일반 메시지 항목으로 보존한다.
import * as path from "node:path";
import type { CommitHookName } from "./commitHookService";

/** Changes 커밋 버튼이 지원하는 커밋 실행 종류. */
export type CommitOperation =
  | "commit"
  | "staged"
  | "all"
  | "amend"
  | "amendStaged"
  | "amendAll";

/** 실패 카드가 실제 commit과 staged hook 사전 실행 중 어느 흐름에서 만들어졌는지 나타낸다. */
export type CommitFailureOrigin = "commit" | "hookPreflight";

/** 파싱된 commit 검사 실패 한 건. 파일 위치가 있으면 UI 에서 바로 열 수 있다. */
export interface CommitFailureItem {
  /** 렌더 key 와 중복 제거에 사용할 안정적인 식별자 */
  id: string;
  /** 검사 도구가 출력한 사람이 읽을 오류 내용 */
  message: string;
  /** 저장소 루트 기준 슬래시 경로. 위치가 없는 일반 오류면 undefined */
  path?: string;
  /** 1부터 시작하는 행 번호 */
  line?: number;
  /** 1부터 시작하는 열 번호 */
  column?: number;
  /** 출력 단어에서 추론한 표시 심각도 */
  severity: "error" | "warning" | "info";
}

/** 한 번의 git commit 실패를 Changes UI 에 전달하는 구조화된 보고서. */
export interface CommitFailureReport {
  /** hook/검사 실패일 가능성이 높으면 true, 일반 Git 실패면 false */
  likelyHook: boolean;
  /** 출력에서 확인한 표준 hook 이름 */
  hookName?: string;
  /** pre-commit framework 등이 출력한 개별 검사 id */
  checkName?: string;
  /** 토스트와 카드 첫 줄에 쓸 짧은 요약 */
  summary: string;
  /** 파일 위치 또는 일반 오류로 구조화한 항목 목록 */
  items: CommitFailureItem[];
  /** 원문에서 비어 있지 않은 전체 행 수 */
  outputLines: number;
  /** 표시 항목 상한 때문에 일부 진단이 생략되었는지 여부 */
  truncated: boolean;
  /** 실패가 발생한 ISO 시각 */
  occurredAt: string;
  /** Retry 버튼이 반복할 원래 커밋 종류 */
  operation: CommitOperation;
  /** Retry 버튼이 실제 commit 또는 hook 사전 실행 중 무엇을 반복할지 결정하는 출처 */
  origin: CommitFailureOrigin;
}

interface ParseOptions {
  activeHooks?: readonly CommitHookName[];
  /** 호출자가 직접 실행해 실패 지점을 정확히 알고 있는 hook 이름 */
  knownHookName?: CommitHookName;
  /** 호출자가 실패한 명령이 실제 `git commit`임을 확인했을 때 조용한 custom hook 추론에 사용한다. */
  commitCommandFailed?: boolean;
  operation?: CommitOperation;
  origin?: CommitFailureOrigin;
  occurredAt?: string;
}

interface ParsedLocation {
  path?: string;
  line?: number;
  column?: number;
  message: string;
  severity: CommitFailureItem["severity"];
}

const MAX_ITEMS = 100;
const MAX_INPUT_LINES = 5000;
const ANSI_ESCAPE = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const WRAPPER_NOISE =
  /^(git .* 실패:|Command failed:|yarn run |npm ERR! code |\$ |> |husky - DEPRECATED|\[(STARTED|SUCCESS|SKIPPED)\])/i;
const PREFLIGHT_WRAPPER_NOISE =
  /^(Staged commit hook preflight$|Staged files:|Commit message hooks:|The real Git index is isolated|RESULT:|\[[^\]]+\] (?:STARTED|PASSED|FAILED|SKIPPED|stdout$|stderr$))/i;
const NON_HOOK_FAILURE =
  /nothing to commit|nothing added to commit|please tell me who you are|unable to auto-detect email|unmerged files|empty commit message|gpg failed to sign|index\.lock|cannot lock ref/i;
const HOOK_SIGNAL =
  /\bhook\b|husky|lint-staged|lefthook|pre-commit|eslint|prettier|ruff|stylelint|commitlint|check(?:s|ing)? files/i;

/**
 * GitError 또는 임의 오류에서 stdout/stderr 를 꺼내 구조화된 commit 실패 보고서를 만든다.
 * @param error git commit 중 throw 된 오류
 * @param repoRoot 파일 경로를 상대 경로로 정규화할 저장소 루트
 * @param options 활성 hook 후보, 직접 commit 실패 여부, 원래 커밋 종류와 실패 시각
 * @returns Changes 웹뷰에 직렬화 가능한 실패 보고서
 */
export function buildCommitFailureReport(
  error: unknown,
  repoRoot: string,
  options: ParseOptions = {}
): CommitFailureReport {
  const output = commitFailureOutput(error);
  return parseCommitFailureOutput(output, repoRoot, options);
}

/**
 * 이미 추출된 commit 실패 텍스트를 도구 독립적인 진단 목록으로 변환한다.
 * @param output git/hook 이 stdout 또는 stderr 로 남긴 전체 텍스트
 * @param repoRoot 상대/절대 파일 위치를 검증할 저장소 루트
 * @param options 활성 hook 후보, 직접 commit 실패 여부와 Retry 메타데이터
 * @returns 파일 위치, 요약, hook 추론 결과가 포함된 보고서
 */
export function parseCommitFailureOutput(
  output: string,
  repoRoot: string,
  options: ParseOptions = {}
): CommitFailureReport {
  const allLines = cleanOutputLines(output);
  const lines = allLines.slice(0, MAX_INPUT_LINES);
  const locations: ParsedLocation[] = [];
  const parsedLocationLines = new Set<string>();
  let currentFile: string | undefined;

  for (const line of lines) {
    const header = pathHeader(line, repoRoot);
    if (header) {
      currentFile = header;
      continue;
    }
    const parsed = parseLocationLine(line, repoRoot, currentFile);
    if (parsed) {
      locations.push(parsed);
      parsedLocationLines.add(line.trim());
    } else {
      currentFile = undefined;
    }
  }

  const meaningful = meaningfulFailureLines(lines);
  const genericCandidates = locations.length
    ? meaningful.filter(
        (line) =>
          !parsedLocationLines.has(line) && isImportantGenericLine(line)
      )
    : meaningful;
  const genericLimit = locations.length ? 12 : 20;
  const generic = genericCandidates.slice(0, genericLimit);
  const candidates = [
    ...locations,
    ...generic.map<ParsedLocation>((message) => ({
      message,
      severity: severityOf(message),
    })),
  ];
  const uniqueItems = dedupeItems(candidates);
  const items = uniqueItems.slice(0, MAX_ITEMS);
  const explicitHook = inferHookName(lines, []);
  const checkName = inferCheckName(lines);
  const text = lines.join("\n");
  const blockingHooks = (options.activeHooks ?? []).filter(
    (name) =>
      name === "pre-commit" ||
      name === "prepare-commit-msg" ||
      name === "commit-msg"
  );
  const silentCommitExit =
    blockingHooks.length > 0 &&
    lines.length <= 2 &&
    (options.commitCommandFailed === true ||
      /^(git commit .*실패:|Command failed: git commit)/i.test(text));
  const validationOutput = Boolean(
    explicitHook ||
      checkName ||
      HOOK_SIGNAL.test(text) ||
      locations.length ||
      silentCommitExit
  );
  const inferredHook =
    explicitHook ??
    options.knownHookName ??
    (validationOutput && blockingHooks.length === 1
      ? blockingHooks[0]
      : undefined);
  const likelyHook = Boolean(
    options.knownHookName ||
    explicitHook ||
    checkName ||
    (!NON_HOOK_FAILURE.test(text) && validationOutput)
  );
  const summary = summarizeFailure(items, meaningful, output);
  return {
    likelyHook,
    hookName: inferredHook,
    checkName,
    summary,
    items,
    outputLines: allLines.length,
    truncated:
      allLines.length > MAX_INPUT_LINES ||
      uniqueItems.length > MAX_ITEMS ||
      genericCandidates.length > genericLimit,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    operation: options.operation ?? "commit",
    origin: options.origin ?? "commit",
  };
}

/**
 * GitError 의 상세 출력이 있으면 우선 사용하고, 없으면 일반 Error 메시지로 폴백한다.
 * @param error commit 중 발생한 알 수 없는 오류
 * @returns 파서에 넘길 개행 결합 텍스트
 */
export function commitFailureOutput(error: unknown): string {
  const detail = error as { stderr?: unknown; stdout?: unknown };
  const streams = [detail?.stderr, detail?.stdout]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .join("\n");
  if (streams) {
    return streams;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * ANSI 색상과 CR 을 제거하고 내용이 있는 행만 보존한다.
 * @param output 터미널 제어 문자가 포함될 수 있는 hook 원문
 * @returns 화면/정규식 처리에 안전한 행 목록
 */
function cleanOutputLines(output: string): string[] {
  return output
    .replace(ANSI_ESCAPE, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);
}

/**
 * ESLint stylish 출력처럼 파일 경로만 단독으로 나온 행을 현재 파일 header 로 인식한다.
 * @param line 검사할 출력 한 행
 * @param repoRoot 경로가 저장소 안인지 확인할 기준
 * @returns 정규화된 상대 경로 또는 undefined
 */
function pathHeader(line: string, repoRoot: string): string | undefined {
  const trimmed = line.trim().replace(/^['"`]|['"`]$/g, "");
  if (
    /[:()]\d+/.test(trimmed) ||
    /\s(?:error|warning|failed)\b/i.test(trimmed) ||
    /^\[(?:warn|warning|error)\]\s+/i.test(trimmed) ||
    /^in\s+["'`].+?["'`],\s*line\s+\d+/i.test(trimmed)
  ) {
    return undefined;
  }
  return normalizeReportedPath(trimmed, repoRoot);
}

/**
 * 여러 lint/compiler 위치 형식 중 하나와 일치하는지 검사한다.
 * @param line 출력 한 행
 * @param repoRoot 절대 경로 검증과 상대화 기준
 * @param currentFile 직전에 단독 header 로 출력된 파일 경로
 * @returns 위치가 포함된 진단 또는 인식하지 못하면 undefined
 */
function parseLocationLine(
  line: string,
  repoRoot: string,
  currentFile?: string
): ParsedLocation | undefined {
  const inFile = /^\s*in\s+["'`](.+?)["'`],\s*line\s+(\d+)(?:,\s*column\s+(\d+))?[:,]?\s*(.*)$/i.exec(
    line
  );
  if (inFile) {
    return location(
      inFile[1],
      inFile[2],
      inFile[3],
      inFile[4] || line.trim(),
      repoRoot
    );
  }
  const paren = /^(.+?)\((\d+),(\d+)\):\s*(.+)$/.exec(line.trim());
  if (paren) {
    return location(paren[1], paren[2], paren[3], paren[4], repoRoot);
  }
  const colon = /^(.+):(\d+):(\d+)(?::|\s+)\s*(.+)$/.exec(line.trim());
  if (colon) {
    return location(colon[1], colon[2], colon[3], colon[4], repoRoot);
  }
  const lineOnly = /^(.+):(\d+)(?::|\s+)\s*(.+)$/.exec(line.trim());
  if (lineOnly) {
    const parsed = location(
      lineOnly[1],
      lineOnly[2],
      undefined,
      lineOnly[3],
      repoRoot
    );
    if (parsed) {
      return parsed;
    }
  }
  const stylish = /^\s*(\d+):(\d+)\s+(error|warning|✖|×)\s+(.+)$/i.exec(line);
  if (stylish && currentFile) {
    return {
      path: currentFile,
      line: positiveNumber(stylish[1]),
      column: positiveNumber(stylish[2]),
      message: `${stylish[3]} ${stylish[4]}`.trim(),
      severity: severityOf(stylish[3]),
    };
  }
  const bracketed = /^\s*\[(error|warn|warning)\]\s+(.+)$/.exec(line);
  if (bracketed) {
    const reportedPath = normalizeReportedPath(bracketed[2].trim(), repoRoot);
    if (reportedPath) {
      return {
        path: reportedPath,
        message: bracketed[1],
        severity: severityOf(bracketed[1]),
      };
    }
  }
  const fileMessage = /^\s*([^\s].*?\S)\s+(\(.+?\)\s+.+)$/.exec(line);
  if (fileMessage) {
    const reportedPath = normalizeReportedPath(fileMessage[1], repoRoot);
    if (reportedPath) {
      return {
        path: reportedPath,
        message: fileMessage[2].trim(),
        severity: severityOf(fileMessage[2]),
      };
    }
  }
  return undefined;
}

/**
 * 정규식 capture 를 검증된 파일 위치 진단으로 바꾼다.
 * @param rawPath 도구가 출력한 파일 경로
 * @param rawLine 1-based 행 문자열
 * @param rawColumn 선택적 1-based 열 문자열
 * @param message 위치 뒤의 오류 메시지
 * @param repoRoot 경로 정규화 기준
 * @returns 저장소 내부 파일이면 진단, 아니면 undefined
 */
function location(
  rawPath: string,
  rawLine: string,
  rawColumn: string | undefined,
  message: string,
  repoRoot: string
): ParsedLocation | undefined {
  const normalized = normalizeReportedPath(rawPath, repoRoot);
  if (!normalized) {
    return undefined;
  }
  return {
    path: normalized,
    line: positiveNumber(rawLine),
    column: positiveNumber(rawColumn),
    message: message.trim(),
    severity: severityOf(message),
  };
}

/**
 * 출력 경로를 저장소 상대 슬래시 경로로 바꾸고 저장소 밖 위치는 거부한다.
 * @param rawPath 따옴표/file URI/상대 경로일 수 있는 후보
 * @param repoRoot 허용 경계가 되는 저장소 루트
 * @returns 안전한 상대 경로 또는 undefined
 */
export function normalizeReportedPath(
  rawPath: string,
  repoRoot: string
): string | undefined {
  const cleaned = rawPath
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/^['"`]|['"`,]$/g, "")
    .replace(/^\.\//, "");
  if (hasPathWrapperPrefix(cleaned) || !looksLikeFilePath(cleaned)) {
    return undefined;
  }
  const absolute = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(repoRoot, cleaned);
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/**
 * npm/stack trace/formatter 요약처럼 실제 경로 앞에 설명 문구가 붙은 후보를 거부한다.
 * @param candidate normalizeReportedPath가 정리한 경로 후보
 * @returns 경로 자체가 아니라 wrapper 문장으로 보이면 true
 */
function hasPathWrapperPrefix(candidate: string): boolean {
  return (
    /^(?:npm ERR!|at\s+|Error\b|Code style issues\b|Forgot to run\b)/i.test(
      candidate
    ) ||
    /\s\/(?:[^/]+\/)+[^/]+$/.test(candidate) ||
    /\s[A-Za-z]:[\\/]/.test(candidate)
  );
}

/**
 * 일반 문장을 파일로 오인하지 않도록 확장자/경로 구분자가 있는 후보만 허용한다.
 * @param candidate 정리된 파일 경로 후보
 * @returns 파일 경로 형태이면 true
 */
function looksLikeFilePath(candidate: string): boolean {
  if (!candidate || candidate.length > 1000 || /[<>|\u0000]/.test(candidate)) {
    return false;
  }
  const base = path.basename(candidate);
  return (
    (candidate.includes("/") ||
      candidate.includes("\\") ||
      path.extname(base) !== "" ||
      base.startsWith(".") ||
      /^(Dockerfile|Makefile|Jenkinsfile|Gemfile|Rakefile|Vagrantfile)$/i.test(base)) &&
    !/\s{2,}/.test(candidate)
  );
}

/**
 * UI 일반 항목으로 남길 의미 있는 오류 행을 진행 로그에서 골라낸다.
 * @param lines ANSI 제거가 끝난 출력 행 목록
 * @returns 순서를 보존한 짧은 실패 후보 목록
 */
function meaningfulFailureLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !WRAPPER_NOISE.test(line) &&
        !PREFLIGHT_WRAPPER_NOISE.test(line)
    );
}

/**
 * 파일 위치 진단과 함께 보여 줄 가치가 있는 전체 검사 실패/요약 행인지 판단한다.
 * @param line 의미 있는 출력 한 행
 * @returns 실패 키워드나 hook id가 있으면 true
 */
function isImportantGenericLine(line: string): boolean {
  return /\b(error|failed|failure|fatal|hook id)\b|[✖×]/i.test(line);
}

/**
 * 위치/메시지가 같은 항목을 하나만 남기고 UI 식별자를 부여한다.
 * @param candidates 위치 파서와 일반 행 파서가 만든 후보 목록
 * @returns 입력 순서를 보존한 고유 실패 항목
 */
function dedupeItems(candidates: ParsedLocation[]): CommitFailureItem[] {
  const seen = new Set<string>();
  const items: CommitFailureItem[] = [];
  for (const candidate of candidates) {
    const message = candidate.message.replace(/\s+/g, " ").trim();
    if (!message) {
      continue;
    }
    const key = [candidate.path, candidate.line, candidate.column, message].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      id: `failure-${items.length + 1}`,
      message,
      path: candidate.path,
      line: candidate.line,
      column: candidate.column,
      severity: candidate.severity,
    });
  }
  return items;
}

/**
 * 표준 hook 이름 또는 활성 hook 단일 후보로 실패 단계를 추론한다.
 * @param lines 전체 출력 행
 * @param activeHooks 현재 활성화된 표준 commit hook 이름
 * @returns 확인 가능한 hook 이름 또는 undefined
 */
function inferHookName(
  lines: string[],
  activeHooks: readonly CommitHookName[]
): string | undefined {
  const text = lines.join("\n");
  const explicit = /\b(pre-commit|prepare-commit-msg|commit-msg|post-commit|post-rewrite|pre-merge-commit)\b/i.exec(
    text
  )?.[1];
  if (explicit) {
    return explicit.toLowerCase();
  }
  return activeHooks.length === 1 ? activeHooks[0] : undefined;
}

/**
 * pre-commit framework 의 `hook id` 행에서 실제 검사 이름을 뽑는다.
 * @param lines 전체 출력 행
 * @returns 검사 id 또는 undefined
 */
function inferCheckName(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = /(?:-|\b)hook id:\s*([^\s]+)/i.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * 파싱 결과 중 가장 구체적인 오류를 400자 이하 요약으로 고른다.
 * @param items 구조화된 진단 목록
 * @param meaningful 잡음을 제외한 원문 행
 * @param fallback 아무 행도 없을 때 사용할 오류 텍스트
 * @returns 토스트/실패 카드용 한 줄 요약
 */
function summarizeFailure(
  items: CommitFailureItem[],
  meaningful: string[],
  fallback: string
): string {
  const source =
    items.find((item) => item.path)?.message ??
    items[0]?.message ??
    meaningful[0] ??
    (fallback.trim() || "Commit failed.");
  return source.length > 400 ? `${source.slice(0, 400)}…` : source;
}

/**
 * 오류 단어를 UI 색상에 사용할 세 단계 심각도로 정규화한다.
 * @param message 검사 도구가 출력한 메시지
 * @returns warning 키워드면 warning, 정보성 키워드면 info, 나머지는 error
 */
function severityOf(message: string): CommitFailureItem["severity"] {
  if (/\bwarn(?:ing)?\b/i.test(message)) {
    return "warning";
  }
  if (/\b(info|note)\b/i.test(message)) {
    return "info";
  }
  return "error";
}

/**
 * 행/열 문자열을 유효한 1-based 정수로 바꾼다.
 * @param value 숫자 문자열 또는 undefined
 * @returns 1 이상이면 정수, 아니면 undefined
 */
function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
