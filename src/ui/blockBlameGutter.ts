// 현재 파일 전체의 git blame을 네이티브 editor 거터에 표시할 snapshot으로 변환한다.
// - 이 모듈은 VS Code 본문 decoration을 만들지 않고 라인 번호·라벨·tooltip 데이터만 관리한다.
// - 실제 거터 폭과 스크롤 동기화는 providers/nativeBlameOverlayPatch.ts의 renderer가 담당한다.
import * as vscode from "vscode";
import { isUncommittedBlameCommit } from "../git/blockBlameModel";
import type { GitBlameLine } from "../git/blameService";

const MAX_VISIBLE_AUTHOR_WIDTH = 18;
const MAX_HOVER_SUMMARY_LENGTH = 180;
const MIN_AUTHOR_COLUMN_WIDTH_CH = 23;
const MAX_AUTHOR_COLUMN_WIDTH_CH = 34;
const AUTHOR_COLUMN_HORIZONTAL_PADDING_CH = 2;

/** renderer가 한 논리 라인과 같은 top 좌표에 배치할 blame 표시 데이터. */
export interface BlockBlameGutterLine {
  /** Git/VS Code 문서가 공유하는 1-based 논리 라인 번호 */
  line: number;
  /** 거터에 눈으로 표시할 축약된 `작업자 · 날짜` 문자열 */
  label: string;
  /** label hover에서 보여 줄 전체 identity, revision, summary의 plain text */
  tooltip: string;
}

/** workbench renderer가 한 편집기의 blame 거터를 그리는 데 필요한 전체 snapshot. */
export interface BlockBlameGutterSnapshot {
  /** 대상 Monaco model을 정확히 고르기 위한 직렬화 file URI */
  uri: string;
  /** 오래된 비동기 결과를 구분하기 위한 VS Code TextDocument version */
  revision: number;
  /** 파일 안에서 실제 blame 정보가 존재하는 유효한 라인 목록 */
  lines: BlockBlameGutterLine[];
  /** 현재 편집기 글꼴로 pixel 폭을 계산할 때 사용할 문자 단위 권장 폭 */
  columnWidthCh: number;
}

/** snapshot 적용 뒤 presenter 로그와 활성 상태가 사용할 집계 결과. */
export interface BlockBlameGutterResult {
  /** 실제 작업자·날짜 라벨이 있는 문서 라인 수 */
  lineCount: number;
  /** 현재 파일에 포함된 서로 다른 작업자 수 */
  authorCount: number;
}

/** 표시용 라인과 OUTPUT 집계를 위한 작성자 식별자를 함께 보관하는 내부 항목. */
interface BlockBlameGutterEntry {
  /** renderer에 전달할 공개 라인 정보 */
  line: BlockBlameGutterLine;
  /** 이메일을 우선 사용해 정규화한 작성자 집계 키 */
  authorKey: string;
}

/**
 * Code Vision 클릭으로 열고 닫는 파일 단위 blame 거터 snapshot을 관리한다.
 * - 적용과 해제 이벤트만 공개해 Git 조회/명령 레이어가 renderer 구현에 의존하지 않게 한다.
 * - 본문 `before`/`after` attachment를 전혀 만들지 않아 코드 토큰 배치에 영향을 주지 않는다.
 */
export class BlockBlameGutter implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<
    BlockBlameGutterSnapshot | undefined
  >();
  /** 네이티브 overlay controller가 snapshot 교체와 해제를 구독하는 이벤트. */
  readonly onDidChangeGutter = this.changeEmitter.event;
  private currentSnapshot?: BlockBlameGutterSnapshot;
  private disposed = false;

  /**
   * 현재 renderer에 표시해야 할 마지막 snapshot을 반환한다.
   * @returns 활성 blame 거터가 없으면 undefined, 있으면 immutable 취급할 snapshot
   */
  snapshot(): BlockBlameGutterSnapshot | undefined {
    return this.currentSnapshot;
  }

  /**
   * Git blame 결과를 정규화하고 현재 파일의 네이티브 거터 snapshot으로 교체한다.
   * - 문서 밖 라인과 중복 레코드를 제거한 뒤 파일 순서로 정렬한다.
   * - 유효한 라인이 없으면 기존 snapshot을 건드리지 않아 refresh 실패 시 깜빡임을 막는다.
   * @param document URI, version, lineCount를 제공하는 현재 저장 문서
   * @param blame 현재 파일 전체의 Git blame 결과
   * @returns 적용한 유효 라인 수와 서로 다른 작성자 수
   */
  apply(
    document: vscode.TextDocument,
    blame: readonly GitBlameLine[]
  ): BlockBlameGutterResult {
    if (this.disposed) {
      return { lineCount: 0, authorCount: 0 };
    }
    const entries = blockBlameGutterEntries(document.lineCount, blame);
    if (entries.length === 0) {
      return { lineCount: 0, authorCount: 0 };
    }
    const snapshot: BlockBlameGutterSnapshot = {
      uri: document.uri.toString(),
      revision: document.version,
      lines: entries.map((entry) => entry.line),
      columnWidthCh: blockBlameColumnWidth(entries),
    };
    this.currentSnapshot = snapshot;
    this.changeEmitter.fire(snapshot);
    return {
      lineCount: entries.length,
      authorCount: new Set(entries.map((entry) => entry.authorKey)).size,
    };
  }

  /**
   * 현재 snapshot을 제거하고 renderer가 거터 폭과 DOM을 복원하도록 알린다.
   * - 이미 비어 있으면 중복 cleanup 이벤트를 만들지 않는다.
   * @returns 반환값 없음
   */
  clear(): void {
    if (!this.currentSnapshot) {
      return;
    }
    this.currentSnapshot = undefined;
    this.changeEmitter.fire(undefined);
  }

  /**
   * snapshot과 이벤트 listener를 영구 정리하고 이후 apply를 무시한다.
   * @returns 반환값 없음
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}

/**
 * blame 레코드를 renderer가 소비할 유효한 거터 라인 목록으로 변환한다.
 * - 같은 라인의 중복 Git 레코드는 먼저 나온 값을 유지해 DOM label이 겹치지 않게 한다.
 * @param documentLineCount 현재 문서의 전체 논리 라인 수
 * @param blame 현재 파일의 Git blame 레코드
 * @returns 문서 라인 순서로 정렬한 거터 entry 목록
 */
function blockBlameGutterEntries(
  documentLineCount: number,
  blame: readonly GitBlameLine[]
): BlockBlameGutterEntry[] {
  const seenLines = new Set<number>();
  const entries: BlockBlameGutterEntry[] = [];
  for (const blameLine of blame) {
    if (
      blameLine.line < 1 ||
      blameLine.line > documentLineCount ||
      seenLines.has(blameLine.line)
    ) {
      continue;
    }
    seenLines.add(blameLine.line);
    entries.push({
      authorKey: blameAuthorKey(blameLine),
      line: {
        line: blameLine.line,
        label: blockBlameGutterLabel(blameLine),
        tooltip: blockBlameTooltip(blameLine),
      },
    });
  }
  return entries.sort((left, right) => left.line.line - right.line.line);
}

/**
 * 현재 파일에서 가장 긴 라벨을 기준으로 거터 열의 권장 문자 폭을 계산한다.
 * - 짧은 이름에서도 날짜가 보이도록 최소 폭을 유지하고 긴 이름 하나가 본문을 과도하게 줄이지 않게 제한한다.
 * @param entries 거터에 표시할 정규화 entry 목록
 * @returns renderer가 실제 글꼴 폭과 곱할 최소·최대 범위의 문자 수
 */
function blockBlameColumnWidth(
  entries: readonly BlockBlameGutterEntry[]
): number {
  const labelWidth = entries.reduce(
    (widest, entry) =>
      Math.max(widest, displayColumnWidth(entry.line.label)),
    0
  );
  const paddedWidth = labelWidth + AUTHOR_COLUMN_HORIZONTAL_PADDING_CH;
  return Math.max(
    MIN_AUTHOR_COLUMN_WIDTH_CH,
    Math.min(MAX_AUTHOR_COLUMN_WIDTH_CH, paddedWidth)
  );
}

/**
 * 한 라인의 거터에 표시할 `작업자 · 날짜` 문자열을 만든다.
 * - 미커밋 라인은 확정 작성자 대신 작업트리 상태를 명시한다.
 * @param line 표시할 Git blame 라인
 * @returns 고정폭 거터 열에 들어갈 축약 label
 */
function blockBlameGutterLabel(line: GitBlameLine): string {
  const author = isUncommittedBlameCommit(line.commit)
    ? vscode.l10n.t("Working tree")
    : displayAuthor(line.authorName);
  return `${truncateToDisplayWidth(
    author,
    MAX_VISIBLE_AUTHOR_WIDTH
  )} · ${blameDate(line)}`;
}

/**
 * 이메일을 우선 사용해 파일 안의 서로 다른 작성자를 안정적으로 집계한다.
 * @param line 작성자 identity와 미커밋 상태를 가진 blame 라인
 * @returns 미커밋, 이메일, 이름 중 하나로 구성한 정규화 키
 */
function blameAuthorKey(line: GitBlameLine): string {
  if (isUncommittedBlameCommit(line.commit)) {
    return "uncommitted";
  }
  const mail = line.authorMail.trim().toLocaleLowerCase();
  return mail
    ? `mail:${mail}`
    : `name:${displayAuthor(line.authorName).toLocaleLowerCase()}`;
}

/**
 * 거터 label hover에 표시할 전체 identity, revision, 날짜, summary를 plain text로 만든다.
 * - DOM `title`과 접근성 label에서 같은 내용을 안전하게 재사용할 수 있도록 Markdown 명령은 넣지 않는다.
 * @param line Git blame 라인
 * @returns 줄바꿈으로 구분한 상세 tooltip 문자열
 */
function blockBlameTooltip(line: GitBlameLine): string {
  const author = displayAuthor(line.authorName);
  const identity = line.authorMail.trim()
    ? `${author} <${line.authorMail.trim()}>`
    : author;
  const revision = isUncommittedBlameCommit(line.commit)
    ? vscode.l10n.t("Working tree")
    : shortHash(line.commit);
  return [
    vscode.l10n.t("Line {0}", line.line),
    identity,
    `${revision} · ${blameDate(line)}`,
    truncate(line.summary.trim(), MAX_HOVER_SUMMARY_LENGTH),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 비어 있거나 Git 기본값인 작성자 이름을 지역화된 대체값으로 보정한다.
 * @param value git blame의 authorName
 * @returns 거터 label과 tooltip에 사용할 작성자 이름
 */
function displayAuthor(value: string): string {
  const author = value.trim();
  return author && author !== "Unknown"
    ? author
    : vscode.l10n.t("Unknown author");
}

/**
 * blame 시각을 시간대에 흔들리지 않는 UTC 날짜로 변환한다.
 * @param line 선택적 Unix epoch seconds를 가진 blame 라인
 * @returns YYYY-MM-DD 또는 지역화된 날짜 없음 문자열
 */
function blameDate(line: GitBlameLine): string {
  if (!line.authorTime) {
    return vscode.l10n.t("Unknown date");
  }
  const date = new Date(line.authorTime * 1_000);
  return Number.isNaN(date.getTime())
    ? vscode.l10n.t("Unknown date")
    : date.toISOString().slice(0, 10);
}

/**
 * 전체 커밋 해시를 tooltip에서 구분하기 충분한 8자로 줄인다.
 * @param commit Git blame의 전체 commit hash
 * @returns 앞 8자리 hash
 */
function shortHash(commit: string): string {
  return commit.slice(0, 8);
}

/**
 * 한글·CJK·emoji가 영문보다 넓게 보이는 점을 근사해 문자열 표시 폭을 계산한다.
 * @param value 폭을 계산할 작성자 또는 전체 label 문자열
 * @returns ASCII는 1, 그 밖의 code point는 2로 계산한 근사 폭
 */
function displayColumnWidth(value: string): number {
  return Array.from(value).reduce(
    (width, character) => width + characterDisplayWidth(character),
    0
  );
}

/**
 * 단일 Unicode code point가 고정폭 편집기 글꼴에서 차지할 근사 폭을 반환한다.
 * @param character 하나의 Unicode code point 문자열
 * @returns 기본 Latin 문자는 1, 그 밖의 문자는 2
 */
function characterDisplayWidth(character: string): number {
  return (character.codePointAt(0) ?? 0) <= 0xff ? 1 : 2;
}

/**
 * 작성자 이름을 표시 폭 기준으로 줄여 긴 label이 본문 공간을 과도하게 줄이지 않게 한다.
 * @param value 원본 작성자 이름
 * @param maxWidth 허용할 최대 근사 표시 폭
 * @returns 원문 또는 마지막에 말줄임표를 붙인 이름
 */
function truncateToDisplayWidth(value: string, maxWidth: number): string {
  if (displayColumnWidth(value) <= maxWidth) {
    return value;
  }
  const ellipsis = "…";
  const contentWidth = Math.max(
    1,
    maxWidth - characterDisplayWidth(ellipsis)
  );
  let usedWidth = 0;
  let result = "";
  for (const character of value) {
    const width = characterDisplayWidth(character);
    if (usedWidth + width > contentWidth) {
      break;
    }
    result += character;
    usedWidth += width;
  }
  return `${result}${ellipsis}`;
}

/**
 * 문자열을 Unicode code point 기준으로 줄여 한글이나 emoji 중간 분리를 피한다.
 * @param value 원본 표시 문자열
 * @param max 허용할 최대 글자 수
 * @returns 원문 또는 마지막 한 글자를 말줄임표로 바꾼 문자열
 */
function truncate(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max
    ? value
    : `${characters.slice(0, Math.max(1, max - 1)).join("")}…`;
}
