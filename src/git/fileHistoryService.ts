// 열린 파일 기준 커밋 히스토리를 조회하는 git 서비스.
// - UI/명령 레이어와 분리해 저장소 루트 + 상대 경로만으로 재사용할 수 있게 한다.
// - 커밋별 diff 프로세스를 만들지 않고 `git log` 한 번에서 메타데이터/raw/numstat 을 함께 읽는다.
import type { FileChangeStatus } from "./gitTypes";
import { runGit } from "./gitExec";

/** root commit 의 부모처럼 사용할 Git empty tree 객체 해시. */
export const EMPTY_TREE_REF = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 커밋 메시지와 경로에 우연히 나타날 가능성을 낮춘 git log 레코드 표식. */
const HISTORY_RECORD_MARKER = "\x1eGSC_FILE_HISTORY_COMMIT_V1\x1e";

/**
 * 메타데이터 필드를 NUL 로 구분하는 pretty format.
 * - Git 커밋 메시지는 NUL 을 허용하지 않으므로 subject/body 안의 제어 문자에도 안전하다.
 * - 맨 앞 레코드 표식은 상태 기반 파서가 raw/numstat 과 다음 커밋 시작을 구분하게 한다.
 */
const HISTORY_LOG_FORMAT =
  "--format=%x00%x1eGSC_FILE_HISTORY_COMMIT_V1%x1e%x00" +
  "%H%x00%h%x00%P%x00%an%x00%aI%x00%ar%x00%s%x00%B%x00";

/** 파일 히스토리 한 커밋이 웹뷰/명령 레이어에 제공하는 정보. */
export interface FileHistoryEntry {
  /** 전체 커밋 해시 */
  hash: string;
  /** 짧은 커밋 해시 */
  shortHash: string;
  /** diff 왼쪽 기준 ref. 일반 커밋은 첫 부모, root commit 은 empty tree 이다. */
  baseRef: string;
  /** 커밋 제목 */
  title: string;
  /** 커밋 전체 메시지(subject + body) */
  message: string;
  /** 작성자 이름 */
  author: string;
  /** ISO strict 형식 작성 시각 */
  dateIso: string;
  /** Git 이 계산한 상대 시각 */
  relativeDate: string;
  /** 해당 커밋에서의 파일 상태 */
  status: FileChangeStatus;
  /** 해당 커밋 오른쪽(커밋 시점) 파일 경로 */
  path: string;
  /** rename/copy 의 왼쪽(부모 시점) 파일 경로 */
  oldPath?: string;
  /** 추가 라인 수 */
  additions?: number;
  /** 삭제 라인 수 */
  deletions?: number;
}

interface LogCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  dateIso: string;
  relativeDate: string;
  title: string;
  message: string;
}

interface CommitFileChange {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
}

interface LineCounts {
  additions: number;
  deletions: number;
}

interface ParsedHistoryRecord {
  commit: LogCommit;
  changes: CommitFileChange[];
  counts: Map<string, LineCounts>;
}

interface ParsedDiffPayload {
  changes: CommitFileChange[];
  counts: Map<string, LineCounts>;
  nextIndex: number;
}

/**
 * 저장소 루트 하나에 묶인 파일 히스토리 조회 서비스.
 */
export class FileHistoryService {
  /**
   * 서비스가 실행할 저장소 루트를 고정한다.
   * @param repoRoot git 명령을 실행할 저장소 루트 절대 경로
   */
  constructor(private readonly repoRoot: string) {}

  /**
   * 특정 파일의 관련 커밋을 최신순으로 조회한다.
   * - `git log --follow` 로 rename 이전 커밋을 포함한다.
   * - raw 상태와 numstat 을 같은 log 프로세스에서 받아 커밋 수에 비례한 프로세스 생성을 막는다.
   * @param relPath 저장소 루트 기준 상대 경로
   * @param limit 최대 커밋 수. 오래된 파일에서 UI refresh 가 무거워지지 않게 제한한다.
   * @returns 메타데이터와 해당 커밋의 파일 상태/라인 통계를 결합한 히스토리
   */
  async listFileHistory(
    relPath: string,
    limit = 60
  ): Promise<FileHistoryEntry[]> {
    const normalizedPath = normalizeGitPath(relPath);
    if (!normalizedPath) {
      return [];
    }
    const raw = await runGit(
      [
        "log",
        "--follow",
        "--raw",
        "--numstat",
        "-z",
        "-M",
        `--max-count=${Math.max(1, limit)}`,
        "--date=relative",
        HISTORY_LOG_FORMAT,
        "--",
        literalGitPathspec(normalizedPath),
      ],
      this.repoRoot
    );
    return parseFileHistoryLog(raw, normalizedPath);
  }
}

/**
 * 한 번의 `git log --raw --numstat -z` 출력을 UI용 파일 히스토리로 변환한다.
 * - 최신 커밋부터 rename 의 oldPath 를 다음 레코드 경로로 넘겨 과거 경로를 추적한다.
 * - Git 출력만 입력으로 받는 순수 함수여서 프로세스 없이 경계 조건을 테스트할 수 있다.
 * @param raw HISTORY_LOG_FORMAT 으로 받은 git log 원문
 * @param initialPath 조회를 시작한 현재 저장소 상대 경로
 * @returns 최신순 파일 히스토리 항목 배열
 */
export function parseFileHistoryLog(
  raw: string,
  initialPath: string
): FileHistoryEntry[] {
  const records = parseHistoryRecords(raw.split("\0"));
  const history: FileHistoryEntry[] = [];
  let pathAtCommit = normalizeGitPath(initialPath);

  for (const record of records) {
    const selected = selectCommitChange(record.changes, pathAtCommit) ?? {
      status: "M" as FileChangeStatus,
      path: pathAtCommit,
    };
    const stat = record.counts.get(selected.path);
    history.push({
      hash: record.commit.hash,
      shortHash: record.commit.shortHash,
      baseRef: record.commit.parents[0] || EMPTY_TREE_REF,
      title: record.commit.title,
      message: record.commit.message,
      author: record.commit.author,
      dateIso: record.commit.dateIso,
      relativeDate: record.commit.relativeDate,
      status: selected.status,
      path: selected.path,
      oldPath: selected.oldPath,
      additions: stat?.additions,
      deletions: stat?.deletions,
    });
    if (selected.status === "R" && selected.oldPath) {
      pathAtCommit = selected.oldPath;
    }
  }
  return history;
}

/**
 * NUL 토큰 스트림에서 커밋 표식을 찾고 고정 메타데이터와 diff payload 를 순서대로 읽는다.
 * - 경로가 우연히 레코드 표식과 같아도 raw/numstat 문법상 경로 위치에서는 표식으로 해석하지 않는다.
 * - 메시지는 고정 8번째 필드로 소비하므로 메시지 본문에 같은 표식이 있어도 레코드가 갈라지지 않는다.
 * @param tokens 전체 git log 출력을 NUL 로 나눈 토큰 배열
 * @returns 정상적으로 파싱된 커밋 레코드 배열
 */
function parseHistoryRecords(tokens: string[]): ParsedHistoryRecord[] {
  const records: ParsedHistoryRecord[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const markerIndex = tokens.indexOf(HISTORY_RECORD_MARKER, cursor);
    if (markerIndex < 0) {
      break;
    }
    const metadataStart = markerIndex + 1;
    const metadataEnd = metadataStart + 8;
    const commit = parseCommitMetadata(tokens.slice(metadataStart, metadataEnd));
    if (!commit) {
      cursor = metadataStart;
      continue;
    }
    const payload = parseDiffPayload(tokens, metadataEnd);
    records.push({
      commit,
      changes: payload.changes,
      counts: payload.counts,
    });
    cursor = payload.nextIndex;
  }
  return records;
}

/**
 * 고정 순서 pretty-format 필드를 커밋 메타데이터로 바꾼다.
 * @param fields hash, shortHash, parents, author, ISO date, relative date, subject, body 순서
 * @returns 필수 hash 가 있는 커밋 메타데이터, 필드가 잘못됐으면 undefined
 */
function parseCommitMetadata(fields: string[]): LogCommit | undefined {
  if (
    fields.length !== 8 ||
    !/^[0-9a-f]+$/.test(fields[0]) ||
    !/^[0-9a-f]+$/.test(fields[1])
  ) {
    return undefined;
  }
  const [
    hash,
    shortHash,
    parentText,
    author,
    dateIso,
    relativeDate,
    title,
    message,
  ] = fields;
  return {
    hash,
    shortHash,
    parents: parentText ? parentText.split(" ").filter(Boolean) : [],
    author,
    dateIso,
    relativeDate,
    title,
    message: message.trimEnd() || title,
  };
}

/**
 * 한 커밋의 raw 상태 토큰과 numstat 토큰을 상태 기반으로 순회해 분리한다.
 * - raw rename/copy 는 old/new 두 경로를 소비하고, numstat rename 도 빈 경로 뒤 두 토큰을 소비한다.
 * - 경로 토큰은 상태 헤더 직후에만 소비해 raw 헤더나 레코드 표식처럼 생긴 파일명도 보존한다.
 * @param tokens 전체 git log 의 NUL 토큰 배열
 * @param startIndex pretty metadata 다음 토큰 인덱스
 * @returns 파일 상태, 새 경로 기준 통계, 다음 커밋 표식 인덱스
 */
function parseDiffPayload(
  tokens: string[],
  startIndex: number
): ParsedDiffPayload {
  const changes: CommitFileChange[] = [];
  const counts = new Map<string, LineCounts>();
  let index = startIndex;
  let readingNumstat = false;

  while (index < tokens.length) {
    if (tokens[index] === HISTORY_RECORD_MARKER) {
      break;
    }
    const status = readingNumstat ? undefined : parseRawStatus(tokens[index]);
    if (!readingNumstat && status) {
      if (status === "R" || status === "C") {
        const oldPath = tokens[index + 1];
        const newPath = tokens[index + 2];
        if (oldPath !== undefined && newPath !== undefined) {
          changes.push({ status, path: newPath, oldPath });
        }
        index += 3;
      } else {
        const filePath = tokens[index + 1];
        if (filePath !== undefined) {
          changes.push({ status, path: filePath });
        }
        index += 2;
      }
      continue;
    }

    const stat = parseNumstatHeader(tokens[index]);
    if (stat) {
      readingNumstat = true;
      let filePath = stat.path;
      if (!filePath) {
        filePath = tokens[index + 2] || "";
        index += 3;
      } else {
        index += 1;
      }
      if (filePath) {
        counts.set(filePath, {
          additions: stat.additions,
          deletions: stat.deletions,
        });
      }
      continue;
    }
    index += 1;
  }
  return { changes, counts, nextIndex: index };
}

/**
 * raw diff 헤더에서 상태 글자만 추출한다.
 * @param token `:oldmode newmode oldoid newoid M` 형태의 NUL 토큰
 * @returns 지원하는 파일 상태, raw 헤더가 아니면 undefined
 */
function parseRawStatus(token: string): FileChangeStatus | undefined {
  const header = token.replace(/^[\r\n]+/, "");
  const match = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(
    header
  );
  return match && isFileChangeStatus(match[1]) ? match[1] : undefined;
}

/**
 * numstat 헤더에서 추가/삭제 수와 일반 파일 경로를 읽는다.
 * - binary 파일의 `-`는 기존 표시 의미와 같이 0줄로 정규화한다.
 * - rename/copy 헤더는 path 가 비며 호출부가 뒤의 old/new NUL 토큰을 소비한다.
 * @param token `<add>\t<del>\t<path>` 형태의 NUL 토큰
 * @returns 파싱된 라인 통계와 경로, numstat 헤더가 아니면 undefined
 */
function parseNumstatHeader(
  token: string
): (LineCounts & { path: string }) | undefined {
  const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
  if (!match) {
    return undefined;
  }
  return {
    additions: match[1] === "-" ? 0 : Number(match[1]) || 0,
    deletions: match[2] === "-" ? 0 : Number(match[2]) || 0,
    path: match[3],
  };
}

/**
 * raw diff 상태가 공용 FileChangeStatus 범위에 속하는지 좁힌다.
 * @param value Git raw 헤더에서 얻은 상태 한 글자
 * @returns 공용 상태 타입으로 안전하게 사용할 수 있으면 true
 */
function isFileChangeStatus(value: string): value is FileChangeStatus {
  return ["A", "M", "D", "R", "C", "T", "U", "X", "B"].includes(value);
}

/**
 * 현재 log walk 경로와 가장 잘 맞는 raw 변경을 선택한다.
 * @param changes 한 커밋의 raw 파일 변경 배열
 * @param relPath 현재 커밋 시점에서 추적 중인 경로
 * @returns 현재/이전 경로가 일치하는 변경, 없으면 첫 변경
 */
function selectCommitChange(
  changes: CommitFileChange[],
  relPath: string
): CommitFileChange | undefined {
  return (
    changes.find(
      (change) => change.path === relPath || change.oldPath === relPath
    ) ?? changes[0]
  );
}

/**
 * git pathspec 으로 넘길 상대 경로를 POSIX 구분자로 정규화한다.
 * @param relPath 저장소 상대 경로
 * @returns 선행 slash 가 제거된 POSIX 형식 상대 경로
 */
function normalizeGitPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 파일명 안의 `*`, `?`, `[` 또는 `:(...)`를 Git pathspec 문법이 아닌 실제 문자로 취급하게 한다.
 * @param relPath 정규화된 저장소 상대 경로
 * @returns Git CLI에 그대로 전달할 literal pathspec
 */
function literalGitPathspec(relPath: string): string {
  return `:(literal)${relPath}`;
}
