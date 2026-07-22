// git blame 출력을 읽어 에디터 decorator 가 소비하기 쉬운 라인 단위 모델로 변환한다.
// - git CLI 실행은 gitExec.runGit 만 사용해 git 접근 경계를 유지한다.
// - VS Code API 에 의존하지 않아 provider/명령 레이어 밖에서도 재사용할 수 있다.
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";

/** git blame 한 줄에 대응하는 커밋/작성자 메타데이터. */
export interface GitBlameLine {
  /** 파일 안의 1-based 라인 번호 */
  line: number;
  /** 해당 라인을 마지막으로 변경한 커밋 해시. 미커밋 라인은 0 해시일 수 있다. */
  commit: string;
  /** 작성자 이름 */
  authorName: string;
  /** 작성자 이메일(꺾쇠괄호 제거 후 값) */
  authorMail: string;
  /** 작성 시각(Unix epoch seconds). git 이 값을 주지 않으면 undefined */
  authorTime?: number;
  /** 작성자 타임존 오프셋(+0900 등) */
  authorTz?: string;
  /** 커밋 제목 */
  summary: string;
  /** blame 이 보고한 파일명(rename 추적 시 원래 파일일 수 있음) */
  filename: string;
  /** 해당 라인의 실제 텍스트 */
  content: string;
}

/** git blame 조회를 파일의 일부 라인으로 제한하는 inclusive 범위. */
export interface GitBlameRange {
  /** 1-based 시작 라인 */
  startLine: number;
  /** 1-based 끝 라인(포함) */
  endLine: number;
}

/**
 * 저장소 루트에 묶인 blame 조회 서비스.
 * - 컨트롤러는 저장소 탐지만 GitServiceRegistry 에 맡기고, 실제 blame 실행은 이 서비스가 담당한다.
 */
export class GitBlameService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 파일의 라인별 blame 정보를 조회한다.
   * - `--line-porcelain` 을 사용해 라인마다 완전한 메타데이터를 받아 파싱한다.
   * - untracked 파일처럼 blame 이 불가능한 대상은 빈 배열로 반환해 UI 가 조용히 비우게 한다.
   * @param fsPath 저장소 상대 또는 절대 파일 경로
   * @param range 선택적 1-based inclusive 범위. 블록 상세 팝업이 필요한 라인만 읽을 때 사용한다.
   * @returns 1-based 라인 번호 순서의 blame 라인 목록
   */
  async getFileBlame(
    fsPath: string,
    range?: GitBlameRange
  ): Promise<GitBlameLine[]> {
    const rel = this.toRepoRelative(fsPath);
    const args = ["blame", "--line-porcelain"];
    const normalizedRange = normalizeBlameRange(range);
    if (normalizedRange) {
      args.push(
        "-L",
        `${normalizedRange.startLine},${normalizedRange.endLine}`
      );
    }
    args.push("--", rel);
    try {
      const out = await runGit(args, this.repoRoot);
      return parseBlamePorcelain(out);
    } catch (error) {
      if (error instanceof GitError && isExpectedBlameMiss(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * 절대 경로를 저장소 루트 기준 상대 경로로 바꾼다.
   * - git 인자는 POSIX 경로가 안정적이므로 플랫폼 구분자를 슬래시로 통일한다.
   * @param fsPath 저장소 상대 또는 절대 파일 경로
   * @returns git 명령에 넘길 저장소 상대 경로
   */
  private toRepoRelative(fsPath: string): string {
    const rel = path.isAbsolute(fsPath)
      ? path.relative(this.repoRoot, fsPath)
      : fsPath;
    return rel.split(path.sep).join("/");
  }
}

/**
 * 호출자가 넘긴 범위를 git `-L` 인자에 안전한 정수 범위로 보정한다.
 * @param range 선택적 blame 범위
 * @returns 값이 있으면 시작 이상 끝을 보장한 범위, 없으면 undefined
 */
function normalizeBlameRange(
  range: GitBlameRange | undefined
): GitBlameRange | undefined {
  if (!range) {
    return undefined;
  }
  const startLine = Math.max(1, Math.floor(range.startLine));
  const endLine = Math.max(startLine, Math.floor(range.endLine));
  return { startLine, endLine };
}

/**
 * `git blame --line-porcelain` 출력을 라인 모델로 변환한다.
 * - 각 레코드는 해시/원본라인/결과라인 헤더로 시작하고, 탭으로 시작하는 실제 소스 라인에서 끝난다.
 * @param output git blame porcelain 출력 전체
 * @returns 파싱된 blame 라인 목록
 */
export function parseBlamePorcelain(output: string): GitBlameLine[] {
  const result: GitBlameLine[] = [];
  let current: Partial<GitBlameLine> | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = {
        commit: header[1],
        line: Number(header[2]),
        authorName: "",
        authorMail: "",
        summary: "",
        filename: "",
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("\t")) {
      current.content = line.slice(1);
      result.push(normalizeBlameLine(current));
      current = undefined;
      continue;
    }
    readMetadataLine(current, line);
  }

  return result.sort((a, b) => a.line - b.line);
}

/**
 * porcelain 메타데이터 한 줄을 현재 blame 레코드에 반영한다.
 * - 필요한 필드만 읽고 나머지 committer/previous 등은 UI 표시와 무관하므로 무시한다.
 * @param target 현재 구성 중인 blame 레코드
 * @param line   `key value` 형태의 메타데이터 라인
 */
function readMetadataLine(target: Partial<GitBlameLine>, line: string): void {
  const sep = line.indexOf(" ");
  const key = sep >= 0 ? line.slice(0, sep) : line;
  const value = sep >= 0 ? line.slice(sep + 1) : "";
  switch (key) {
    case "author":
      target.authorName = value;
      break;
    case "author-mail":
      target.authorMail = stripMailBrackets(value);
      break;
    case "author-time":
      target.authorTime = Number(value) || undefined;
      break;
    case "author-tz":
      target.authorTz = value;
      break;
    case "summary":
      target.summary = value;
      break;
    case "filename":
      target.filename = value;
      break;
  }
}

/**
 * 부분적으로 채워진 레코드를 UI 가 안전하게 사용할 수 있는 완전한 객체로 보정한다.
 * @param line 파싱 중인 blame 라인
 * @returns 기본값이 채워진 blame 라인
 */
function normalizeBlameLine(line: Partial<GitBlameLine>): GitBlameLine {
  return {
    line: Math.max(1, line.line ?? 1),
    commit: line.commit ?? "",
    authorName: line.authorName || "Unknown",
    authorMail: line.authorMail || "",
    authorTime: line.authorTime,
    authorTz: line.authorTz,
    summary: line.summary || "",
    filename: line.filename || "",
    content: line.content || "",
  };
}

/**
 * git blame 이 정상적으로 실패할 수 있는 대상인지 확인한다.
 * - untracked/삭제/저장소 밖 파일은 UI 에 오류 알림을 띄울 이유가 없어 빈 결과로 처리한다.
 * @param error git 실행 실패 정보
 * @returns 사용자 오류로 보지 않아도 되는 blame miss 면 true
 */
function isExpectedBlameMiss(error: GitError): boolean {
  const text = `${error.message}\n${error.stderr}\n${error.stdout}`;
  return (
    /no such path/i.test(text) ||
    /no such file/i.test(text) ||
    /not in the working tree/i.test(text) ||
    /cannot stat path/i.test(text) ||
    /fatal: no such ref/i.test(text)
  );
}

/**
 * git 이 `<mail@example.com>` 형태로 주는 이메일에서 꺾쇠괄호를 제거한다.
 * @param value porcelain 의 author-mail 원문
 * @returns 표시/hover 에 사용할 이메일 문자열
 */
function stripMailBrackets(value: string): string {
  return value.replace(/^</, "").replace(/>$/, "");
}
