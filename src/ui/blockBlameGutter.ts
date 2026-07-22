// 현재 파일 전체의 git blame을 거터 옆 고정폭 작업자 열로 표현한다.
// - VS Code가 glyph gutter 폭과 텍스트를 직접 제어하는 API를 제공하지 않아 before decoration을 사용한다.
// - 모든 라인 앞에 같은 폭의 `작업자 · 날짜` 열을 두어 소스 시작 위치가 흐트러지지 않게 한다.
import * as vscode from "vscode";
import { isUncommittedBlameCommit } from "../git/blockBlameModel";
import type { GitBlameLine } from "../git/blameService";

const MAX_VISIBLE_AUTHOR_WIDTH = 18;
const MAX_HOVER_SUMMARY_LENGTH = 180;
const MIN_AUTHOR_COLUMN_WIDTH_CH = 23;
const MAX_AUTHOR_COLUMN_WIDTH_CH = 34;
const AUTHOR_COLUMN_HORIZONTAL_PADDING_CH = 2;
const EMPTY_AUTHOR_COLUMN_CONTENT = "\u00a0";

/** 한 blame 라인을 고정폭 작업자 열에 적용하기 위한 decoration과 작성자 식별자. */
interface BlockBlameColumnEntry {
  /** 열 폭 계산과 실제 renderOptions가 공유할 작업자·날짜 문자열 */
  label: string;
  /** 라인 시작 위치, hover, 눈에 보이는 작업자·날짜 문자열 */
  option: vscode.DecorationOptions;
  /** 서로 다른 작업자 수를 OUTPUT 로그에 집계할 정규화 키 */
  authorKey: string;
}

/** 작업자 열 적용 뒤 presenter 로그와 활성 상태가 사용할 집계 결과. */
export interface BlockBlameGutterResult {
  /** 실제 작업자·날짜 열이 표시된 문서 라인 수 */
  lineCount: number;
  /** 코드 시작 위치를 맞추기 위해 빈 열까지 적용한 파일 전체 라인 수 */
  columnLineCount: number;
  /** 현재 파일에 포함된 서로 다른 작업자 수 */
  authorCount: number;
}

/**
 * 블록 범위의 line-by-line blame을 거터에 이어지는 고정폭 텍스트 열로 표시한다.
 * - 작업자마다 아이콘을 만들지 않고 decoration 타입 하나만 사용한다.
 * - 새 블록 적용이나 dispose 때 타입을 폐기해 기존 열과 hover를 함께 제거한다.
 */
export class BlockBlameGutter implements vscode.Disposable {
  private decoration?: vscode.TextEditorDecorationType;
  private disposed = false;

  /**
   * 현재 표시를 교체하고 유효한 blame 라인 앞에 작업자 이름과 날짜 열을 적용한다.
   * - 새 decoration을 먼저 적용한 뒤 이전 타입을 폐기해 refresh 중 빈 화면이 생기지 않게 한다.
   * @param editor 고정폭 작업자 열을 표시할 텍스트 에디터
   * @param document 라인 범위를 검증하고 Range를 만들 대상 문서
   * @param blame 현재 파일 전체의 git blame 결과
   * @returns 적용한 라인 수와 서로 다른 작업자 수
   */
  apply(
    editor: vscode.TextEditor,
    document: vscode.TextDocument,
    blame: readonly GitBlameLine[]
  ): BlockBlameGutterResult {
    if (this.disposed) {
      return { lineCount: 0, columnLineCount: 0, authorCount: 0 };
    }
    const entries = blockBlameColumnEntries(document, blame);
    if (entries.length === 0) {
      return { lineCount: 0, columnLineCount: 0, authorCount: 0 };
    }

    const decoration = createBlockBlameColumnDecorationType(
      blockBlameColumnWidth(entries)
    );
    const columnOptions = wholeDocumentColumnOptions(document, entries);
    try {
      editor.setDecorations(decoration, columnOptions);
    } catch (error) {
      decoration.dispose();
      throw error;
    }
    const previous = this.decoration;
    this.decoration = decoration;
    previous?.dispose();
    return {
      lineCount: entries.length,
      columnLineCount: columnOptions.length,
      authorCount: new Set(entries.map((entry) => entry.authorKey)).size,
    };
  }

  /**
   * 현재 decoration 타입을 폐기해 모든 라인의 작업자·날짜 열을 즉시 제거한다.
   * @returns 반환값 없음
   */
  clear(): void {
    this.decoration?.dispose();
    this.decoration = undefined;
  }

  /**
   * 작업자 열을 영구 정리하고 이후 apply 호출이 새 decoration을 만들지 않게 한다.
   * @returns 반환값 없음
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
  }
}

/**
 * 소스 본문 앞에 거터 배경의 고정폭 author/date 열을 삽입할 decoration 타입을 만든다.
 * - width를 고정해 이름 길이가 달라도 실제 코드의 시작 열이 모든 라인에서 같게 유지된다.
 * - 흐린 CodeLens 전경색을 사용해 구문 강조보다 시각적 우선순위가 낮도록 한다.
 * @param widthCh 현재 파일에서 가장 긴 라벨에 맞춘 문자 단위 열 폭
 * @returns 현재 파일 전체가 공유할 TextEditorDecorationType
 */
function createBlockBlameColumnDecorationType(
  widthCh: number
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      backgroundColor: new vscode.ThemeColor("editorGutter.background"),
      width: `${widthCh}ch`,
      margin: "0 2ch 0 0",
      fontStyle: "normal",
      textDecoration:
        "none; display: inline-block; box-sizing: border-box; padding: 0 1ch; text-align: right; white-space: pre; overflow: hidden; text-overflow: ellipsis; opacity: 0.82",
    },
  });
}

/**
 * blame 결과를 라인 시작점의 고정폭 열 decoration 목록으로 변환한다.
 * - 문서 밖 라인은 버리고 중복 라인은 첫 레코드만 사용해 겹치는 가상 텍스트를 막는다.
 * @param document 실제 문서 라인 수와 Range를 제공할 대상
 * @param blame 현재 파일 전체의 라인별 blame 결과
 * @returns 문서 순서대로 정렬된 decoration과 작성자 키 목록
 */
function blockBlameColumnEntries(
  document: vscode.TextDocument,
  blame: readonly GitBlameLine[]
): BlockBlameColumnEntry[] {
  const seenLines = new Set<number>();
  const entries: BlockBlameColumnEntry[] = [];
  for (const line of blame) {
    if (
      line.line < 1 ||
      line.line > document.lineCount ||
      seenLines.has(line.line)
    ) {
      continue;
    }
    seenLines.add(line.line);
    const zeroBased = line.line - 1;
    const label = blockBlameColumnLabel(line);
    entries.push({
      label,
      authorKey: blameAuthorKey(line),
      option: {
        range: new vscode.Range(zeroBased, 0, zeroBased, 0),
        hoverMessage: blockBlameHover(line),
        renderOptions: {
          before: { contentText: label },
        },
      },
    });
  }
  return entries.sort(
    (left, right) => left.option.range.start.line - right.option.range.start.line
  );
}

/**
 * 파일의 모든 라인에 같은 폭의 앞쪽 열과 가능한 blame 내용을 적용한다.
 * - Git 결과가 빠진 라인에도 공백 attachment를 만들어 실제 코드 시작 열을 통일한다.
 * - 빈 문자열은 VS Code가 attachment 자체를 생략할 수 있어 non-breaking space를 사용한다.
 * @param document 전체 열을 확장할 현재 텍스트 문서
 * @param entries 작업자 이름과 날짜를 표시할 파일 전체 blame 라인
 * @returns 문서의 각 논리 라인에 하나씩 대응하는 decoration 목록
 */
function wholeDocumentColumnOptions(
  document: vscode.TextDocument,
  entries: readonly BlockBlameColumnEntry[]
): vscode.DecorationOptions[] {
  const entriesByLine = new Map(
    entries.map((entry) => [entry.option.range.start.line, entry] as const)
  );
  const options: vscode.DecorationOptions[] = [];
  for (let line = 0; line < document.lineCount; line++) {
    const entry = entriesByLine.get(line);
    if (entry) {
      options.push(entry.option);
      continue;
    }
    options.push({
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: {
        before: { contentText: EMPTY_AUTHOR_COLUMN_CONTENT },
      },
    });
  }
  return options;
}

/**
 * 현재 파일의 라벨 중 가장 긴 값에 맞춰 작업자 열 폭을 계산한다.
 * - 너무 짧은 이름에서도 날짜가 안정적으로 보이도록 최소 폭을 유지한다.
 * - 긴 이름 하나 때문에 소스 영역이 과도하게 밀리지 않도록 최대 폭을 제한한다.
 * @param entries 화면에 적용할 작업자·날짜 라벨 목록
 * @returns CSS `ch` 단위로 사용할 최소·최대 범위 안의 정수 폭
 */
function blockBlameColumnWidth(entries: readonly BlockBlameColumnEntry[]): number {
  const labelWidth = entries.reduce(
    (widest, entry) => Math.max(widest, displayColumnWidth(entry.label)),
    0
  );
  const paddedWidth = labelWidth + AUTHOR_COLUMN_HORIZONTAL_PADDING_CH;
  return Math.max(
    MIN_AUTHOR_COLUMN_WIDTH_CH,
    Math.min(MAX_AUTHOR_COLUMN_WIDTH_CH, paddedWidth)
  );
}

/**
 * 한 라인에 눈으로 보일 `작업자 · 날짜` 문자열을 만든다.
 * - 미커밋 라인은 실제 작성자를 확정할 수 없으므로 작업트리로 표시한다.
 * - 날짜가 없는 레코드는 커밋 해시로 대체하지 않고 명시적으로 알 수 없음이라 표시한다.
 * @param line 표시할 Git blame 라인
 * @returns 고정폭 열에 들어갈 이름과 날짜만 포함한 문자열
 */
function blockBlameColumnLabel(line: GitBlameLine): string {
  const author = isUncommittedBlameCommit(line.commit)
    ? vscode.l10n.t("Working tree")
    : displayAuthor(line.authorName);
  return `${truncateToDisplayWidth(author, MAX_VISIBLE_AUTHOR_WIDTH)} · ${blameDate(line)}`;
}

/**
 * 이메일을 우선 사용해 동일 작업자를 집계할 안정적인 키를 만든다.
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
 * 작업자 열 hover에 전체 identity와 원본 blame 정보를 안전한 plain text로 쌓는다.
 * - 열 자체에는 요청대로 이름과 날짜만 표시하고 commit/요약은 hover로만 제공한다.
 * @param line Git blame 라인
 * @returns 명령 링크 없이 표시할 MarkdownString
 */
function blockBlameHover(line: GitBlameLine): vscode.MarkdownString {
  const author = displayAuthor(line.authorName);
  const identity = line.authorMail.trim()
    ? `${author} <${line.authorMail.trim()}>`
    : author;
  const revision = isUncommittedBlameCommit(line.commit)
    ? vscode.l10n.t("Working tree")
    : shortHash(line.commit);
  const values = [
    vscode.l10n.t("Line {0}", line.line),
    identity,
    `${revision} · ${blameDate(line)}`,
    truncate(line.summary.trim(), MAX_HOVER_SUMMARY_LENGTH),
  ].filter(Boolean);
  const hover = new vscode.MarkdownString();
  values.forEach((value, index) => {
    if (index > 0) {
      hover.appendMarkdown("  \n");
    }
    hover.appendText(value);
  });
  return hover;
}

/**
 * 비어 있거나 Git 기본값인 작성자 이름을 지역화된 대체값으로 보정한다.
 * @param value git blame의 authorName
 * @returns 고정폭 열과 hover에 사용할 작업자 이름
 */
function displayAuthor(value: string): string {
  const author = value.trim();
  return author && author !== "Unknown"
    ? author
    : vscode.l10n.t("Unknown author");
}

/**
 * blame 시각을 시간대에 흔들리지 않는 날짜로 변환한다.
 * @param line 선택적 Unix epoch seconds를 가진 blame 라인
 * @returns UTC 기준 YYYY-MM-DD 또는 지역화된 날짜 없음 문자열
 */
function blameDate(line: GitBlameLine): string {
  if (!line.authorTime) {
    return vscode.l10n.t("Unknown date");
  }
  const date = new Date(line.authorTime * 1000);
  return Number.isNaN(date.getTime())
    ? vscode.l10n.t("Unknown date")
    : date.toISOString().slice(0, 10);
}

/**
 * 전체 커밋 해시를 hover에서 구분하기 충분한 8자로 줄인다.
 * @param commit Git blame의 전체 커밋 hash
 * @returns 앞 8자리 hash
 */
function shortHash(commit: string): string {
  return commit.slice(0, 8);
}

/**
 * 고정폭 열에서 한글·CJK·emoji가 영문보다 넓게 보이는 점을 근사해 표시 폭을 계산한다.
 * - VS Code가 사용하는 실제 폰트의 wcwidth를 API로 얻을 수 없어 ASCII 밖 문자를 2칸으로 본다.
 * @param value 열에 표시할 작업자 또는 전체 라벨 문자열
 * @returns CSS `ch` 폭 계산에 사용할 근사 열 수
 */
function displayColumnWidth(value: string): number {
  return Array.from(value).reduce(
    (width, character) => width + characterDisplayWidth(character),
    0
  );
}

/**
 * 단일 Unicode 문자가 고정폭 열에서 차지할 근사 폭을 반환한다.
 * @param character 하나의 Unicode code point 문자열
 * @returns 기본 Latin 문자는 1, 그 밖의 문자는 2
 */
function characterDisplayWidth(character: string): number {
  return (character.codePointAt(0) ?? 0) <= 0xff ? 1 : 2;
}

/**
 * 작업자 이름을 표시 폭 기준으로 줄여 날짜가 고정폭 열 밖으로 밀리지 않게 한다.
 * @param value 원본 작업자 이름
 * @param maxWidth 허용할 최대 근사 표시 폭
 * @returns 원문 또는 마지막에 말줄임표를 붙인 이름
 */
function truncateToDisplayWidth(value: string, maxWidth: number): string {
  if (displayColumnWidth(value) <= maxWidth) {
    return value;
  }
  const ellipsis = "…";
  const contentWidth = Math.max(1, maxWidth - characterDisplayWidth(ellipsis));
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
