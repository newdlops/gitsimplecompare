// 소스 블록 범위와 라인별 git blame 을 결합해 주요 작업자 요약을 만드는 순수 모델.
// - VS Code 심볼/CodeLens API에 의존하지 않아 provider와 테스트가 같은 집계 규칙을 재사용한다.
// - 라인별 작성자 decoration에 전달하는 command payload도 문자열/숫자만 사용해 안전하게 직렬화한다.
import type { GitBlameLine } from "./blameService";

/** Code Vision을 표시할 수 있는 소스 블록 종류. */
export type SourceBlockKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "constructor"
  | "struct"
  | "enum"
  | "namespace"
  | "module"
  | "declarations"
  | "block";

/** 부모 블록 안의 작은 callable을 별도 Code Vision으로 나누지 않을 최소 라인 수. */
const MIN_NESTED_CALLABLE_LINES = 6;

/** 언어별 DocumentSymbol 을 VS Code 비의존 형태로 바꾼 소스 블록. */
export interface SourceBlock {
  /** 문서 안에서 블록을 안정적으로 구분할 식별자 */
  id: string;
  /** 함수/클래스/인터페이스 등의 표시 이름 */
  name: string;
  /** 원래 DocumentSymbol 의 의미 종류 */
  kind: SourceBlockKind;
  /** 블록 전체의 1-based 시작 라인 */
  startLine: number;
  /** 블록 전체의 1-based 끝 라인(포함) */
  endLine: number;
  /** CodeLens를 붙일 선언부의 1-based 라인 */
  declarationLine: number;
}

/** 빈 줄 기준으로 묶기 전의 최상위 변수/type/object 선언 범위. */
export interface LineSeparatedDeclaration {
  /** provider가 알려 준 선언 이름 */
  name: string;
  /** 선언 전체의 1-based 시작 라인 */
  startLine: number;
  /** 선언 전체의 1-based 끝 라인(포함) */
  endLine: number;
}

/** Code Vision 클릭 명령이 편집기 line-by-line blame 표시에 전달하는 범위 정보. */
export interface BlockBlameRequest {
  /** 대상 문서 URI 문자열 */
  uri: string;
  /** 라인별 작성자 표시와 로그에서 구분할 블록 이름 */
  symbolName: string;
  /** 표시 범위와 로그에 사용할 블록 종류 */
  kind: SourceBlockKind;
  /** 조회할 1-based 시작 라인 */
  startLine: number;
  /** 조회할 1-based 끝 라인(포함) */
  endLine: number;
  /** CodeLens 생성 시점의 문서 버전. stale 클릭 진단에만 사용한다. */
  documentVersion?: number;
}

/**
 * 언어 심볼을 독립된 Code Vision 단위로 표시할지 결정한다.
 * - 최상위 선언과 클래스/인터페이스 같은 구조 블록은 크기와 무관하게 유지한다.
 * - 부모 안에 들어 있는 아주 작은 함수/메서드는 부모 blame에 포함해 행 밀도를 낮춘다.
 * @param block 표시 후보 소스 블록
 * @param depth DocumentSymbol 계층의 0-based 깊이
 * @returns 독립 Code Vision을 만들 블록이면 true
 */
export function shouldShowBlockCodeVision(
  block: Pick<SourceBlock, "kind" | "startLine" | "endLine">,
  depth: number
): boolean {
  if (Math.max(0, Math.floor(depth)) === 0 || isStructuralBlock(block.kind)) {
    return true;
  }
  const lineCount = Math.max(1, block.endLine - block.startLine + 1);
  return lineCount >= MIN_NESTED_CALLABLE_LINES;
}

/**
 * 최상위 변수/type/object 선언을 빈 라인이 나올 때만 새 Code Vision 블록으로 나눈다.
 * - 여러 줄 object 내부의 빈 줄은 하나의 심볼 범위 안이므로 블록을 자르지 않는다.
 * - 같은 줄이나 연속 라인의 선언은 이름을 합쳐 첫 선언 라인 위에 CodeLens 하나만 둔다.
 * @param declarations 언어 provider에서 얻은 최상위 선언 범위
 * @param documentLines 0-based 배열로 전달한 문서의 실제 라인 텍스트
 * @param barrierLines 함수/클래스처럼 선언 묶음을 가로지를 수 없는 블록 시작 라인
 * @returns 선언 위치 순서로 정렬된 `declarations` 소스 블록
 */
export function groupLineSeparatedDeclarations(
  declarations: readonly LineSeparatedDeclaration[],
  documentLines: readonly string[],
  barrierLines: readonly number[] = []
): SourceBlock[] {
  if (documentLines.length === 0) {
    return [];
  }
  const candidates = declarations
    .filter((value) =>
      Number.isFinite(value.startLine) && Number.isFinite(value.endLine)
    )
    .map((value) => ({
      name: value.name.trim() || "(anonymous)",
      startLine: clamp(Math.floor(value.startLine), 1, documentLines.length),
      endLine: clamp(Math.floor(value.endLine), 1, documentLines.length),
    }))
    .map((value) => ({
      ...value,
      endLine: Math.max(value.startLine, value.endLine),
    }))
    .sort((left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine
    );
  const groups: Array<{
    startLine: number;
    endLine: number;
    names: string[];
  }> = [];
  for (const candidate of candidates) {
    const previous = groups[groups.length - 1];
    if (
      !previous ||
      hasBlankSeparator(documentLines, previous.endLine, candidate.startLine) ||
      barrierLines.some(
        (line) => line > previous.endLine && line < candidate.startLine
      )
    ) {
      groups.push({ ...candidate, names: [candidate.name] });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, candidate.endLine);
    if (!previous.names.includes(candidate.name)) {
      previous.names.push(candidate.name);
    }
  }
  return groups.map((group) => ({
    id: `declarations:${group.startLine}:${group.endLine}`,
    name: declarationGroupName(group.names),
    kind: "declarations",
    startLine: group.startLine,
    endLine: group.endLine,
    declarationLine: group.startLine,
  }));
}

/** 한 블록에서 동일 Git 작성자 identity 로 집계된 기여 정보. */
export interface BlockContributor {
  /** 이메일을 우선 사용한 내부 identity 키 */
  key: string;
  /** Code Vision과 라인 decoration에 표시할 작성자 이름 */
  name: string;
  /** Git blame 이 제공한 작성자 이메일 */
  mail: string;
  /** 주요 작업자 계산에 포함된 비어 있지 않은 라인 수 */
  lineCount: number;
  /** 집계 대상 라인 중 이 작성자가 차지하는 반올림 백분율 */
  percentage: number;
  /** 블록 라인에서 발견한 서로 다른 커밋 수 */
  commitCount: number;
  /** 해당 작성자의 라인 중 가장 최근 작성 시각 */
  latestAuthorTime?: number;
  /** 해당 작성자가 처음 나타난 1-based 라인 */
  firstLine: number;
  /** 0 해시로 표시되는 아직 커밋되지 않은 작업인지 여부 */
  uncommitted: boolean;
}

/** 소스 블록 하나에 대한 주요 작업자와 line-by-line blame 결합 결과. */
export interface BlockBlameSummary {
  /** 요약 대상 블록 */
  block: SourceBlock;
  /** 블록 범위에 실제로 존재하는 모든 blame 라인(빈 라인 포함) */
  lines: GitBlameLine[];
  /** lineCount 내림차순으로 정렬된 작성자 목록 */
  contributors: BlockContributor[];
  /** contributors 첫 항목과 같은 주요 작업자 */
  primaryContributor?: BlockContributor;
  /** 백분율 분모로 사용한 라인 수 */
  countedLineCount: number;
  /** 블록의 집계 라인에서 발견한 서로 다른 커밋 수 */
  commitCount: number;
  /** 블록 집계 라인 중 가장 최근 Git 작성 시각 */
  latestAuthorTime?: number;
}

/** 작성자를 모으는 동안 Set 과 최신 표시 이름을 함께 보관하는 내부 누산기. */
interface ContributorAccumulator {
  key: string;
  name: string;
  mail: string;
  lineCount: number;
  commits: Set<string>;
  latestAuthorTime?: number;
  firstLine: number;
  uncommitted: boolean;
}

/** command payload 에서 허용하는 블록 종류를 런타임에도 검증하기 위한 집합. */
const SOURCE_BLOCK_KINDS = new Set<SourceBlockKind>([
  "class",
  "interface",
  "function",
  "method",
  "constructor",
  "struct",
  "enum",
  "namespace",
  "module",
  "declarations",
  "block",
]);

/** 외부 명령 payload 가 지나치게 큰 문자열로 UI 를 오염시키지 않게 하는 상한. */
const MAX_SYMBOL_NAME_LENGTH = 240;
const MAX_URI_LENGTH = 16_384;

/**
 * 블록 범위의 blame 을 작성자별로 집계하고 주요 작업자를 고른다.
 * - 공백뿐인 라인은 코드 소유 비율을 왜곡하므로 보통 분모에서 제외한다.
 * - 블록 전체가 공백이면 상세를 잃지 않도록 그때만 모든 blame 라인을 집계한다.
 * @param block 언어 심볼에서 얻은 1-based 블록 범위
 * @param fileBlame 파일 전체 또는 블록 일부의 line-by-line blame
 * @returns 작성자 순위와 블록 라인 상세를 포함한 요약
 */
export function summarizeBlockBlame(
  block: SourceBlock,
  fileBlame: readonly GitBlameLine[]
): BlockBlameSummary {
  const normalizedBlock = normalizeSourceBlock(block);
  const lines = selectBlockBlameLines(normalizedBlock, fileBlame);
  const meaningful = lines.filter((line) => line.content.trim().length > 0);
  const countedLines = meaningful.length > 0 ? meaningful : lines;
  const accumulators = new Map<string, ContributorAccumulator>();

  for (const line of countedLines) {
    addContributorLine(accumulators, line);
  }

  const contributors = Array.from(accumulators.values())
    .map((value) => toContributor(value, countedLines.length))
    .sort(compareContributors);
  return {
    block: normalizedBlock,
    lines,
    contributors,
    primaryContributor: contributors[0],
    countedLineCount: countedLines.length,
    commitCount: countDistinctCommits(countedLines),
    latestAuthorTime: findLatestAuthorTime(countedLines),
  };
}

/**
 * 파일 blame 에서 블록의 inclusive 라인 범위만 잘라 라인 번호 순으로 반환한다.
 * @param block 조회할 정규화된 소스 블록
 * @param fileBlame 파일 blame 결과
 * @returns 블록 범위 안에 있는 정렬된 blame 라인 복사본
 */
export function selectBlockBlameLines(
  block: Pick<SourceBlock, "startLine" | "endLine">,
  fileBlame: readonly GitBlameLine[]
): GitBlameLine[] {
  const startLine = Math.max(1, Math.floor(block.startLine));
  const endLine = Math.max(startLine, Math.floor(block.endLine));
  return fileBlame
    .filter((line) => line.line >= startLine && line.line <= endLine)
    .slice()
    .sort((left, right) => left.line - right.line);
}

/**
 * VS Code command 경계에서 받은 알 수 없는 값을 안전한 blame 요청으로 바꾼다.
 * - 숫자 범위와 문자열 길이를 검증해 잘못된 확장/사용자 command 호출을 조용히 거부한다.
 * @param value command handler 로 전달된 알 수 없는 값
 * @returns 검증된 요청, 필수 필드가 잘못됐으면 undefined
 */
export function normalizeBlockBlameRequest(
  value: unknown
): BlockBlameRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const uri = normalizedText(value.uri, MAX_URI_LENGTH);
  const symbolName = normalizedText(value.symbolName, MAX_SYMBOL_NAME_LENGTH);
  const startLine = positiveInteger(value.startLine);
  const endLine = positiveInteger(value.endLine);
  if (!uri || !symbolName || !startLine || !endLine || endLine < startLine) {
    return undefined;
  }
  const kind = SOURCE_BLOCK_KINDS.has(value.kind as SourceBlockKind)
    ? (value.kind as SourceBlockKind)
    : "block";
  const documentVersion = nonNegativeInteger(value.documentVersion);
  return {
    uri,
    symbolName,
    kind,
    startLine,
    endLine,
    documentVersion,
  };
}

/**
 * 0으로만 구성된 Git blame 해시인지 검사한다.
 * @param commit Git blame commit 필드
 * @returns 아직 커밋되지 않은 라인이면 true
 */
export function isUncommittedBlameCommit(commit: string): boolean {
  return commit.length > 0 && /^0+$/.test(commit);
}

/**
 * 두 선언 범위 사이에 공백만 있는 라인이 하나라도 있는지 확인한다.
 * @param lines 문서의 0-based 라인 텍스트 배열
 * @param previousEnd 앞 선언의 1-based 끝 라인
 * @param nextStart 뒤 선언의 1-based 시작 라인
 * @returns 빈 줄로 블록을 나눠야 하면 true
 */
function hasBlankSeparator(
  lines: readonly string[],
  previousEnd: number,
  nextStart: number
): boolean {
  for (let line = previousEnd + 1; line < nextStart; line++) {
    if ((lines[line - 1] ?? "").trim().length === 0) {
      return true;
    }
  }
  return false;
}

/**
 * 선언 묶음 이름을 tooltip을 과도하게 넓히지 않는 대표 이름으로 만든다.
 * @param names 같은 빈 줄 블록에 포함된 중복 없는 심볼 이름
 * @returns 최대 세 이름과 남은 개수를 조합한 표시 이름
 */
function declarationGroupName(names: readonly string[]): string {
  const visible = names.slice(0, 3).join(", ");
  const remaining = names.length - 3;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

/**
 * 소스 블록 종류가 내부 callable을 묶는 구조 컨테이너인지 판별한다.
 * @param kind 소스 블록 종류
 * @returns 클래스/인터페이스/모듈처럼 항상 독립 표시할 종류이면 true
 */
function isStructuralBlock(kind: SourceBlockKind): boolean {
  return (
    kind === "class" ||
    kind === "interface" ||
    kind === "struct" ||
    kind === "enum" ||
    kind === "namespace" ||
    kind === "module"
  );
}

/**
 * provider 가 만든 블록 범위를 방어적으로 정규화한다.
 * @param block 원본 블록
 * @returns 시작/끝/선언 위치와 표시 이름이 안전한 새 객체
 */
function normalizeSourceBlock(block: SourceBlock): SourceBlock {
  const startLine = Math.max(1, Math.floor(block.startLine));
  const endLine = Math.max(startLine, Math.floor(block.endLine));
  const declarationLine = clamp(
    Math.floor(block.declarationLine),
    startLine,
    endLine
  );
  return {
    ...block,
    id: block.id || `${block.kind}:${startLine}:${endLine}:${block.name}`,
    name: block.name.trim() || "(anonymous)",
    startLine,
    endLine,
    declarationLine,
  };
}

/**
 * 블록 작성 이력의 규모를 Code Vision에 표시할 수 있도록 서로 다른 커밋을 센다.
 * @param lines 주요 작업자 집계에 사용한 blame 라인
 * @returns 미커밋 0 해시를 제외한 고유 커밋 수
 */
function countDistinctCommits(lines: readonly GitBlameLine[]): number {
  return new Set(
    lines
      .map((line) => line.commit)
      .filter((commit) => commit && !isUncommittedBlameCommit(commit))
  ).size;
}

/**
 * 블록의 Code Vision 날짜로 사용할 가장 최근 author-time을 찾는다.
 * @param lines 주요 작업자 집계에 사용한 blame 라인
 * @returns 가장 큰 Unix epoch seconds, 날짜 정보가 없으면 undefined
 */
function findLatestAuthorTime(
  lines: readonly GitBlameLine[]
): number | undefined {
  let latest: number | undefined;
  for (const line of lines) {
    if (
      line.authorTime !== undefined &&
      (latest === undefined || line.authorTime > latest)
    ) {
      latest = line.authorTime;
    }
  }
  return latest;
}

/**
 * blame 한 라인을 identity 별 누산기에 더한다.
 * - 이메일이 있으면 이름 변경과 대소문자 차이에도 같은 사람으로 묶는다.
 * - 가장 최근 라인의 이름/메일을 표시값으로 사용해 오래된 별칭이 Code Vision에 남지 않게 한다.
 * @param accumulators identity 별 작성자 누산기
 * @param line 집계할 blame 라인
 */
function addContributorLine(
  accumulators: Map<string, ContributorAccumulator>,
  line: GitBlameLine
): void {
  const uncommitted = isUncommittedBlameCommit(line.commit);
  const key = contributorKey(line, uncommitted);
  const existing = accumulators.get(key);
  if (!existing) {
    accumulators.set(key, {
      key,
      name: displayAuthorName(line.authorName),
      mail: line.authorMail.trim(),
      lineCount: 1,
      commits: new Set(line.commit ? [line.commit] : []),
      latestAuthorTime: line.authorTime,
      firstLine: line.line,
      uncommitted,
    });
    return;
  }
  existing.lineCount++;
  existing.firstLine = Math.min(existing.firstLine, line.line);
  if (line.commit) {
    existing.commits.add(line.commit);
  }
  if (isNewerIdentity(line.authorTime, existing.latestAuthorTime)) {
    existing.name = displayAuthorName(line.authorName);
    existing.mail = line.authorMail.trim();
    existing.latestAuthorTime = line.authorTime;
  }
}

/**
 * 내부 누산기를 UI 가 사용할 불변 기여자 모델로 바꾼다.
 * @param value 작성자 누산기
 * @param totalLines 백분율 분모
 * @returns 커밋 Set 이 개수로 변환된 기여자 정보
 */
function toContributor(
  value: ContributorAccumulator,
  totalLines: number
): BlockContributor {
  return {
    key: value.key,
    name: value.name,
    mail: value.mail,
    lineCount: value.lineCount,
    percentage:
      totalLines > 0 ? Math.round((value.lineCount / totalLines) * 100) : 0,
    commitCount: value.commits.size,
    latestAuthorTime: value.latestAuthorTime,
    firstLine: value.firstLine,
    uncommitted: value.uncommitted,
  };
}

/**
 * 기여자를 주요 작업자 우선순위로 정렬한다.
 * - 라인 수가 같으면 최근 기여, 첫 등장 라인, 이름 순서로 결과를 안정화한다.
 * @param left 왼쪽 기여자
 * @param right 오른쪽 기여자
 * @returns Array.sort 비교값
 */
function compareContributors(
  left: BlockContributor,
  right: BlockContributor
): number {
  return (
    right.lineCount - left.lineCount ||
    (right.latestAuthorTime ?? -1) - (left.latestAuthorTime ?? -1) ||
    left.firstLine - right.firstLine ||
    left.name.localeCompare(right.name)
  );
}

/**
 * 라인의 작성자 identity 키를 만든다.
 * @param line Git blame 라인
 * @param uncommitted 미커밋 라인 여부
 * @returns 이메일, 이름 또는 미커밋 공용 키
 */
function contributorKey(line: GitBlameLine, uncommitted: boolean): string {
  if (uncommitted) {
    return "uncommitted";
  }
  const mail = line.authorMail.trim().toLowerCase();
  if (mail) {
    return `mail:${mail}`;
  }
  return `name:${displayAuthorName(line.authorName).toLowerCase()}`;
}

/**
 * 비어 있는 Git 작성자 이름을 일관된 대체값으로 보정한다.
 * @param value Git blame authorName
 * @returns trim 된 표시 이름
 */
function displayAuthorName(value: string): string {
  return value.trim() || "Unknown";
}

/**
 * 새 라인의 identity 메타데이터가 기존 값보다 최근인지 판단한다.
 * @param candidate 새 author-time
 * @param current 기존 최신 author-time
 * @returns 표시 이름/메일을 새 값으로 교체해야 하면 true
 */
function isNewerIdentity(
  candidate: number | undefined,
  current: number | undefined
): boolean {
  return candidate !== undefined && (current === undefined || candidate > current);
}

/**
 * 알 수 없는 값이 문자열 키를 읽을 수 있는 객체인지 검사한다.
 * @param value 검사할 값
 * @returns null/배열이 아닌 객체이면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * command 문자열을 trim 하고 허용 길이를 넘으면 거부한다.
 * @param value 알 수 없는 입력
 * @param maxLength 허용할 최대 UTF-16 길이
 * @returns 검증된 문자열 또는 undefined
 */
function normalizedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

/**
 * 알 수 없는 값을 1 이상의 안전한 정수로 읽는다.
 * @param value command 숫자 필드
 * @returns 양의 정수 또는 undefined
 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

/**
 * 선택 필드인 문서 버전을 0 이상의 정수로 읽는다.
 * @param value command documentVersion 필드
 * @returns 값이 없거나 잘못됐으면 undefined, 정상이면 해당 정수
 */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * 숫자를 inclusive 최소/최대 범위 안으로 제한한다.
 * @param value 제한할 숫자
 * @param minimum 최솟값
 * @param maximum 최댓값
 * @returns 범위 안 숫자
 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
