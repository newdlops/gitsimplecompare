// git diff 출력 파싱을 모아둔 순수 유틸 모듈.
// - GitService(브랜치 비교)와 GitLogService(커밋 상세)가 동일한 파서를 공유한다(재사용).
import { FileChange, FileChangeStatus } from "./gitTypes";

/**
 * `git diff --name-status -z` 출력(NUL 구분)을 FileChange 배열로 파싱한다.
 * - 일반 항목: <status>\0<path>\0
 * - 이름변경/복사: <Rxxx|Cxxx>\0<oldPath>\0<newPath>\0
 * @param raw git diff 의 원문 출력
 */
export function parseNameStatusZ(raw: string): FileChange[] {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const changes: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++][0] as FileChangeStatus;
    if (code === "R" || code === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      changes.push({ status: code, path: newPath, oldPath });
    } else {
      changes.push({ status: code, path: tokens[i++] });
    }
  }
  return changes;
}

/**
 * `git diff --raw --numstat -z`의 상태와 라인 통계를 한 번에 파싱한다.
 * - raw 레코드의 상태/경로를 먼저 읽고 뒤따르는 numstat을 새 경로 기준으로 합친다.
 * - 두 Git 프로세스의 실행 대기를 줄이고, 한 diff에서 계산한 이름변경 판단을 공유한다.
 * - NUL로 구분된 경로는 공백·탭·줄바꿈·화살표를 포함해 원문 그대로 보존한다.
 * @param raw 상태 레코드 뒤에 numstat 레코드가 이어지는 Git 원문 출력
 * @returns Git 출력 순서의 파일 변경 목록과 추가/삭제 라인 수
 */
export function parseRawNumstatZ(raw: string): FileChange[] {
  const tokens = raw.split("\0");
  const changes: FileChange[] = [];
  let index = 0;
  while (tokens[index]?.startsWith(":")) {
    const header = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([ACDMRTUXB])\d*$/.exec(tokens[index++]);
    if (!header) {
      throw new Error("Invalid Git raw diff header");
    }
    const status = header[1] as FileChangeStatus;
    const firstPath = tokens[index++];
    if (!firstPath) {
      throw new Error("Missing Git raw diff path");
    }
    if (status === "R" || status === "C") {
      const newPath = tokens[index++];
      if (!newPath) {
        throw new Error("Missing Git raw diff destination path");
      }
      changes.push({ status, path: newPath, oldPath: firstPath });
    } else {
      changes.push({ status, path: firstPath });
    }
  }
  const counts = parseNumstatTokens(tokens, index);
  return changes.map((change) => {
    const stat = counts.get(change.path);
    return { ...change, additions: stat?.additions, deletions: stat?.deletions };
  });
}

/** NUL porcelain 한 항목의 인덱스/작업트리 상태와 원본 경로를 보존하는 공통 구조다. */
export interface PorcelainEntry {
  xy: string;
  path: string;
  oldPath?: string;
}

/**
 * porcelain v1의 NUL 경계를 읽어 공백·개행 경로와 rename/copy 원본을 손실 없이 반환한다.
 * - 표시 계층도 원래 XY를 사용하게 해 미추적 파일과 staged 추가를 구별할 수 있다.
 * @param raw `git status --porcelain -z` 또는 공유 snapshot의 호환 출력
 * @returns Git 출력 순서의 상태 항목. rename/copy 원본은 독립 항목으로 만들지 않는다.
 */
export function parsePorcelainEntries(raw: string): PorcelainEntry[] {
  const tokens = raw.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const xy = token.slice(0, 2);
    const oldPath = /[RC]/.test(xy) ? tokens[++index] : undefined;
    entries.push({ xy, path: token.slice(3), ...(oldPath === undefined ? {} : { oldPath }) });
  }
  return entries;
}

/**
 * `git status --porcelain -z --untracked-files=all` 출력을 스테이징/미스테이징 두 그룹으로 나눈다.
 * - XY 두 글자에서 X(인덱스)=스테이징, Y(작업트리)=미스테이징. 한 파일이 양쪽에 모두 나올 수 있다
 *   (예: "MM" → 스테이징된 수정 + 추가 미스테이징 수정).
 * - 미추적("??")은 미스테이징 그룹에 A(추가)로 넣는다.
 * - 충돌(U 계열, AA/DD)은 미스테이징 그룹에 U 로 넣는다(별도 충돌 뷰가 해결을 담당).
 * - 이름변경/복사(R/C)는 다음 토큰이 원본 경로다.
 * @param raw git status 의 원문 출력
 */
export function parsePorcelainGroups(raw: string): {
  staged: FileChange[];
  unstaged: FileChange[];
} {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  for (const { xy, path: filePath, oldPath } of parsePorcelainEntries(raw)) {
    const [x, y] = xy;

    if (x === "?" && y === "?") {
      unstaged.push({ status: "A", path: filePath });
      continue;
    }
    if (x === "U" || y === "U" || xy === "AA" || xy === "DD") {
      unstaged.push({ status: "U", path: filePath, oldPath });
      continue;
    }
    if (x !== " " && x !== "?") {
      staged.push({ status: mapStatusCode(x), path: filePath, oldPath });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ status: mapStatusCode(y), path: filePath, oldPath });
    }
  }
  return { staged, unstaged };
}

/**
 * porcelain v2의 branch 헤더와 변경 존재 여부를 동일한 status 출력에서 읽는다.
 * - 실제 파일 레코드를 만나면 바로 반환해 이름변경의 원본 경로를 헤더로 오인하지 않는다.
 * - 최초 커밋 전 `(initial)`은 HEAD 없음으로 처리하고 알 수 없는 확장 헤더는 무시한다.
 * @param raw `git status --porcelain=v2 --branch -z`의 NUL 구분 출력
 * @returns 그래프 가상 커밋 생성에 필요한 HEAD OID와 변경 존재 여부
 */
export function parsePorcelainSummaryZ(raw: string): { head?: string; hasChanges: boolean } {
  let head: string | undefined;
  for (const token of raw.split("\0")) {
    if (!token) continue;
    if (!token.startsWith("# ")) return { head, hasChanges: true };
    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice("# branch.oid ".length);
      head = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : undefined;
    }
  }
  return { head, hasChanges: false };
}

/**
 * porcelain 상태 한 글자를 표시용 상태 코드로 변환한다(알 수 없으면 수정 M).
 * @param code 상태 한 글자(예: "M", "A", "D", "R", "C", "T")
 */
function mapStatusCode(code: string): FileChangeStatus {
  return "AMDRCT".includes(code) ? (code as FileChangeStatus) : "M";
}

/** numstat 한 항목의 추가/삭제 라인 수. */
export interface NumstatCount {
  additions: number;
  deletions: number;
  /**
   * git 이 "-" 로 표시한 항목이면 true. binary 파일이거나 `core.bigFileThreshold` 를 넘어
   * 내용을 비교하지 않은 대용량 파일이다(라인 수는 호환을 위해 0 으로 둔다).
   */
  binary?: true;
}

/**
 * `git diff --numstat` 또는 `git diff --numstat -z` 출력을 경로별 {추가, 삭제} 라인 수 맵으로 파싱한다.
 * - 바이너리(또는 크기 상한 초과) 파일은 "-"로 표시되며 0 으로 처리하고 binary 표시를 붙인다.
 * - `-z` 출력은 한글/공백/특수문자 경로가 quote 되지 않아 status path 와 안정적으로 매칭된다.
 * - NUL 경로는 원문을 보존하고, 줄 단위 이름변경 표기("old => new", "{a => b}/c")만 정규화한다.
 * @param raw git diff --numstat 원문 출력
 */
export function parseNumstat(raw: string): Map<string, NumstatCount> {
  return raw.includes("\0") ? parseNumstatZ(raw) : parseNumstatLines(raw);
}

/**
 * numstat 의 추가/삭제 칸을 라인 수 항목으로 바꾼다.
 * @param added 추가 칸 원문("-" 가능)
 * @param deleted 삭제 칸 원문("-" 가능)
 */
function numstatCount(added: string, deleted: string): NumstatCount {
  const count: NumstatCount = {
    additions: added === "-" ? 0 : Number(added) || 0,
    deletions: deleted === "-" ? 0 : Number(deleted) || 0,
  };
  if (added === "-" && deleted === "-") {
    count.binary = true;
  }
  return count;
}

/** 줄 단위 numstat 출력을 파싱한다. */
function parseNumstatLines(raw: string): Map<string, NumstatCount> {
  const map = new Map<string, NumstatCount>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const path = normalizeRenamePath(parts.slice(2).join("\t"));
    map.set(path, numstatCount(parts[0], parts[1]));
  }
  return map;
}

/**
 * NUL 구분 numstat 출력을 파싱한다.
 * - 일반 파일: `<add>\t<del>\t<path>\0`
 * - rename/copy: `<add>\t<del>\t\0<old>\0<new>\0` 이므로 새 경로를 사용한다.
 */
function parseNumstatZ(raw: string): Map<string, NumstatCount> {
  return parseNumstatTokens(raw.split("\0"));
}

/**
 * NUL 토큰의 지정 위치부터 numstat을 읽어 raw+numstat과 단독 numstat의 파싱을 공유한다.
 * @param tokens NUL로 구분한 원문 토큰(경로의 공백과 특수문자를 그대로 유지)
 * @param startIndex numstat 첫 레코드의 토큰 위치
 * @returns 새 경로 기준의 라인 통계 맵
 */
function parseNumstatTokens(tokens: string[], startIndex = 0): Map<string, NumstatCount> {
  const map = new Map<string, NumstatCount>();
  for (let index = startIndex; index < tokens.length; index++) {
    const header = tokens[index];
    if (!header) {
      continue;
    }
    const parts = header.split("\t");
    if (parts.length < 3) {
      continue;
    }
    let filePath = parts.slice(2).join("\t");
    if (!filePath) {
      index += 2;
      filePath = tokens[index] || "";
    }
    if (filePath) {
      map.set(filePath, numstatCount(parts[0], parts[1]));
    }
  }
  return map;
}

/**
 * numstat 의 이름변경 표기를 새 경로로 정규화한다.
 * - "src/{a => b}/c.ts" → "src/b/c.ts", "old.ts => new.ts" → "new.ts"
 * @param raw 경로 토큰(이름변경 표기 가능)
 */
function normalizeRenamePath(raw: string): string {
  const expanded = raw.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/\/{2,}/g, "/");
  const arrow = expanded.indexOf(" => ");
  return arrow >= 0 ? expanded.slice(arrow + 4).trim() : expanded.trim();
}
