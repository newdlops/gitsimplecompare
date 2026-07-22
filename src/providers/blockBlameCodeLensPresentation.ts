// 언어 심볼을 소스 블록으로 바꾸고 블록 blame 요약을 VS Code CodeLens로 표현한다.
// - 컨트롤러의 캐시/이벤트 생애주기와 분리해 DocumentSymbol 및 Code Vision 표시 규칙만 둔다.
// - 선언문 위 전용 행의 label 전체에 명령과 tooltip을 제공해 다른 인레이와 겹치지 않게 한다.
import * as vscode from "vscode";
import {
  groupLineSeparatedDeclarations,
  shouldShowBlockCodeVision,
  type BlockBlameRequest,
  type BlockBlameSummary,
  type LineSeparatedDeclaration,
  type SourceBlock,
  type SourceBlockKind,
} from "../git/blockBlameModel";

/** Code Vision label 이 실행하는 line-by-line blame 명령 id. */
export const SHOW_BLOCK_BLAME_COMMAND = "gitSimpleCompare.showBlockBlame";

/** DocumentSymbol 과 SymbolInformation 에서 공통으로 필요한 범위 묶음. */
interface SymbolRanges {
  /** 심볼 전체 블록 범위 */
  range: vscode.Range;
  /** 심볼 이름을 가리키는 선언 범위 */
  selectionRange: vscode.Range;
}

/** VS Code Range를 문서 안의 1-based 라인 범위로 보정한 결과. */
interface SymbolLines {
  /** 심볼 전체의 시작 라인 */
  startLine: number;
  /** 심볼 전체의 포함 끝 라인 */
  endLine: number;
  /** 이름이나 선언 토큰이 있는 라인 */
  declarationLine: number;
}

/**
 * 언어 확장의 DocumentSymbol 결과를 지원 블록 목록으로 평탄화한다.
 * @param document 심볼을 조회할 텍스트 문서
 * @returns 선언 위치로 정렬되고 중복이 제거된 소스 블록
 */
export async function readSourceBlocks(
  document: vscode.TextDocument
): Promise<SourceBlock[]> {
  const symbols = await vscode.commands.executeCommand<
    Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
  >("vscode.executeDocumentSymbolProvider", document.uri);
  if (!symbols || symbols.length === 0) {
    return [];
  }

  const blocks: SourceBlock[] = [];
  const declarations: LineSeparatedDeclaration[] = [];
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      appendDocumentSymbolBlocks(
        symbol,
        document,
        blocks,
        declarations,
        0
      );
    } else {
      if (symbol.location.uri.toString() !== document.uri.toString()) {
        continue;
      }
      const ranges = {
        range: symbol.location.range,
        selectionRange: symbol.location.range,
      };
      const declaration = symbol.containerName
        ? undefined
        : looseDeclarationFromSymbol(
            symbol.name,
            symbol.kind,
            ranges,
            document
          );
      const block = declaration
        ? undefined
        : sourceBlockFromSymbol(symbol.name, symbol.kind, ranges, document);
      if (declaration) {
        declarations.push(declaration);
      } else if (block) {
        blocks.push(block);
      }
    }
  }
  blocks.push(
    ...groupLineSeparatedDeclarations(
      declarations,
      documentLineTexts(document),
      blocks.map((block) => block.startLine)
    )
  );
  return deduplicateBlocks(blocks);
}

/**
 * 블록 요약 하나를 선언문 위에 표시되는 클릭 가능한 CodeLens로 변환한다.
 * @param document Code Vision이 표시될 문서
 * @param summary 집계된 블록 blame 요약
 * @returns 주요 작업자가 없거나 위치가 잘못됐으면 undefined
 */
export function createBlockBlameCodeLens(
  document: vscode.TextDocument,
  summary: BlockBlameSummary
): vscode.CodeLens | undefined {
  const primary = summary.primaryContributor;
  if (!primary) {
    return undefined;
  }
  const line = summary.block.declarationLine - 1;
  if (line < 0 || line >= document.lineCount) {
    return undefined;
  }
  const tooltip = blockBlameTooltip(summary);
  const command: vscode.Command = {
    command: SHOW_BLOCK_BLAME_COMMAND,
    title: blockBlameCodeVisionLabel(summary),
    tooltip,
    arguments: [blockBlameRequest(document, summary.block)],
  };
  return new vscode.CodeLens(document.lineAt(line).range, command);
}

/**
 * 계층형 DocumentSymbol 과 모든 자식을 깊이 우선으로 순회해 지원 블록만 추가한다.
 * @param symbol 현재 언어 심볼
 * @param document 선언 라인 길이를 읽을 문서
 * @param target 결과를 누적할 배열
 * @param declarations 빈 줄 기준으로 나중에 묶을 최상위 선언 배열
 * @param depth 작은 중첩 callable을 부모 단위로 묶기 위한 0-based 계층 깊이
 */
function appendDocumentSymbolBlocks(
  symbol: vscode.DocumentSymbol,
  document: vscode.TextDocument,
  target: SourceBlock[],
  declarations: LineSeparatedDeclaration[],
  depth: number
): void {
  const ranges = {
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  };
  const declaration = depth === 0
    ? looseDeclarationFromSymbol(
        symbol.name,
        symbol.kind,
        ranges,
        document
      )
    : undefined;
  const block = declaration
    ? undefined
    : sourceBlockFromSymbol(symbol.name, symbol.kind, ranges, document);
  if (declaration) {
    declarations.push(declaration);
    return;
  }
  if (block && shouldShowBlockCodeVision(block, depth)) {
    target.push(block);
  }
  for (const child of symbol.children) {
    appendDocumentSymbolBlocks(
      child,
      document,
      target,
      declarations,
      depth + 1
    );
  }
}

/**
 * 런타임 심볼 객체가 children/selectionRange 를 가진 DocumentSymbol 인지 판별한다.
 * @param symbol DocumentSymbol 또는 flat SymbolInformation
 * @returns 계층형 DocumentSymbol 이면 true
 */
function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return "children" in symbol && "selectionRange" in symbol;
}

/**
 * VS Code 심볼과 범위를 직렬화 가능한 1-based SourceBlock 으로 바꾼다.
 * @param name 언어 provider 가 반환한 심볼 이름
 * @param symbolKind VS Code SymbolKind
 * @param ranges 전체/선언 범위
 * @param document 심볼 범위를 실제 문서 라인 안으로 보정할 문서
 * @returns 지원하지 않는 심볼이면 undefined, 아니면 정규화 전 블록
 */
function sourceBlockFromSymbol(
  name: string,
  symbolKind: vscode.SymbolKind,
  ranges: SymbolRanges,
  document: vscode.TextDocument
): SourceBlock | undefined {
  const kind = sourceBlockKind(symbolKind);
  const lines = symbolLines(ranges, document);
  if (!kind || !lines) {
    return undefined;
  }
  const trimmedName = name.trim() || "(anonymous)";
  return {
    id: `${kind}:${lines.startLine}:${lines.endLine}:${lines.declarationLine}:${trimmedName}`,
    name: trimmedName,
    kind,
    ...lines,
  };
}

/**
 * 최상위 variable/constant/object와 `type` 선언을 빈 줄 그룹 후보로 바꾼다.
 * @param name 언어 provider가 반환한 심볼 이름
 * @param symbolKind VS Code SymbolKind
 * @param ranges 전체/선언 범위
 * @param document 선언 텍스트와 안전한 라인 범위를 읽을 문서
 * @returns 묶을 선언이면 범위, 함수나 클래스 같은 독립 블록이면 undefined
 */
function looseDeclarationFromSymbol(
  name: string,
  symbolKind: vscode.SymbolKind,
  ranges: SymbolRanges,
  document: vscode.TextDocument
): LineSeparatedDeclaration | undefined {
  const lines = symbolLines(ranges, document);
  if (!lines) {
    return undefined;
  }
  const declarationText = document.lineAt(lines.declarationLine - 1).text;
  if (!isLooseDeclarationKind(symbolKind, declarationText)) {
    return undefined;
  }
  return {
    name: name.trim() || "(anonymous)",
    startLine: lines.startLine,
    endLine: lines.endLine,
  };
}

/**
 * 심볼 범위를 문서 안의 1-based inclusive 라인 범위로 보정한다.
 * @param ranges VS Code provider가 반환한 전체/선언 Range
 * @param document 실제 라인 상한과 끝 라인 텍스트를 제공할 문서
 * @returns 빈 문서면 undefined, 아니면 보정된 라인 범위
 */
function symbolLines(
  ranges: SymbolRanges,
  document: vscode.TextDocument
): SymbolLines | undefined {
  if (document.lineCount === 0) {
    return undefined;
  }
  const startZero = clamp(ranges.range.start.line, 0, document.lineCount - 1);
  const rawEndZero = clamp(
    ranges.range.end.line,
    startZero,
    document.lineCount - 1
  );
  const endZero = ranges.range.end.character === 0 && rawEndZero > startZero
    ? rawEndZero - 1
    : rawEndZero;
  const declarationZero = clamp(
    ranges.selectionRange.start.line,
    startZero,
    Math.max(startZero, endZero)
  );
  return {
    startLine: startZero + 1,
    endLine: Math.max(startZero, endZero) + 1,
    declarationLine: declarationZero + 1,
  };
}

/**
 * 최상위에서 빈 줄 기준으로 묶을 선언 종류인지 판별한다.
 * @param kind 언어 provider의 SymbolKind
 * @param declarationText type alias를 보완 탐지할 선언 라인 텍스트
 * @returns 전역 선언 묶음 후보이면 true
 */
function isLooseDeclarationKind(
  kind: vscode.SymbolKind,
  declarationText: string
): boolean {
  if (
    kind === vscode.SymbolKind.Variable ||
    kind === vscode.SymbolKind.Constant ||
    kind === vscode.SymbolKind.Object ||
    kind === vscode.SymbolKind.TypeParameter
  ) {
    return true;
  }
  return /^(?:(?:export|declare|default|pub|opaque)\s+)*type\s+/.test(
    declarationText.trim()
  );
}

/**
 * IntelliJ Code Vision 성격에 맞는 블록형 VS Code SymbolKind 만 도메인 종류로 매핑한다.
 * @param kind VS Code 언어 provider 의 심볼 종류
 * @returns 표시할 블록 종류, 필드/변수처럼 블록이 아니면 undefined
 */
function sourceBlockKind(kind: vscode.SymbolKind): SourceBlockKind | undefined {
  switch (kind) {
    case vscode.SymbolKind.Class:
      return "class";
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Method:
      return "method";
    case vscode.SymbolKind.Constructor:
      return "constructor";
    case vscode.SymbolKind.Struct:
      return "struct";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.Namespace:
      return "namespace";
    case vscode.SymbolKind.Module:
      return "module";
    default:
      return undefined;
  }
}

/**
 * 같은 provider 결과가 중복됐을 때 id 기준 하나만 남기고 선언 위치/큰 블록 순으로 정렬한다.
 * @param blocks 수집된 블록 배열
 * @returns 안정적으로 정렬된 중복 없는 배열
 */
function deduplicateBlocks(blocks: readonly SourceBlock[]): SourceBlock[] {
  const unique = new Map<string, SourceBlock>();
  for (const block of blocks) {
    unique.set(block.id, block);
  }
  return Array.from(unique.values()).sort(
    (left, right) =>
      left.declarationLine - right.declarationLine ||
      right.endLine - right.startLine - (left.endLine - left.startLine) ||
      left.name.localeCompare(right.name)
  );
}

/**
 * Code Vision 클릭 명령에 전달할 최소 직렬화 payload를 만든다.
 * @param document 현재 문서와 버전
 * @param block 클릭한 소스 블록
 * @returns URI/이름/라인 범위만 포함한 요청
 */
function blockBlameRequest(
  document: vscode.TextDocument,
  block: SourceBlock
): BlockBlameRequest {
  return {
    uri: document.uri.toString(),
    symbolName: block.name,
    kind: block.kind,
    startLine: block.startLine,
    endLine: block.endLine,
    documentVersion: document.version,
  };
}

/**
 * 이미지와 같은 `작성자 +추가인원  날짜 +추가커밋` Code Vision 문자열을 만든다.
 * @param summary 블록 blame 요약
 * @returns 선언문 위 전용 행에 표시할 한 줄 label
 */
function blockBlameCodeVisionLabel(summary: BlockBlameSummary): string {
  const primary = summary.primaryContributor;
  if (!primary) {
    return "";
  }
  const name = truncate(
    primary.uncommitted
      ? vscode.l10n.t("Not committed yet")
      : primary.name,
    28
  );
  const others = summary.contributors.length - 1;
  const authorSuffix = others > 0 ? ` +${others}` : "";
  const date = primary.uncommitted
    ? vscode.l10n.t("Working tree")
    : summary.latestAuthorTime !== undefined
      ? shortDate(summary.latestAuthorTime)
      : vscode.l10n.t("Unknown date");
  const commitSuffix = summary.commitCount > 1
    ? ` +${summary.commitCount - 1}`
    : "";
  return `$(account) ${name}${authorSuffix}   ${date}${commitSuffix}`;
}

/**
 * hover 시 블록 범위와 작성자 분포, 클릭 동작을 설명하는 plain text tooltip을 만든다.
 * @param summary 블록 blame 요약
 * @returns CodeLens command tooltip 문자열
 */
function blockBlameTooltip(summary: BlockBlameSummary): string {
  const block = summary.block;
  const lines = [
    `${block.name} · ${blockKindLabel(block.kind)} · ${vscode.l10n.t(
      "Lines {0}-{1}",
      block.startLine,
      block.endLine
    )}`,
    vscode.l10n.t("Main contributors"),
  ];
  for (const contributor of summary.contributors.slice(0, 6)) {
    const name = contributor.uncommitted
      ? vscode.l10n.t("Not committed yet")
      : contributor.name;
    const distribution = vscode.l10n.t(
      "{0} of {1} lines ({2}%)",
      contributor.lineCount,
      summary.countedLineCount,
      contributor.percentage
    );
    lines.push(`• ${name} — ${distribution}`);
  }
  if (summary.contributors.length > 6) {
    lines.push(
      vscode.l10n.t(
        "and {0} more contributors",
        summary.contributors.length - 6
      )
    );
  }
  lines.push(
    vscode.l10n.t("Commits: {0}", summary.commitCount),
    "",
    vscode.l10n.t("Click to show or hide line-by-line authors in the editor.")
  );
  return lines.join("\n");
}

/**
 * 블록 종류 코드를 현재 VS Code 표시 언어의 이름으로 바꾼다.
 * @param kind 소스 블록 종류
 * @returns tooltip 에 표시할 지역화된 종류 이름
 */
function blockKindLabel(kind: SourceBlockKind): string {
  switch (kind) {
    case "class":
      return vscode.l10n.t("Class");
    case "interface":
      return vscode.l10n.t("Interface");
    case "function":
      return vscode.l10n.t("Function");
    case "method":
      return vscode.l10n.t("Method");
    case "constructor":
      return vscode.l10n.t("Constructor");
    case "struct":
      return vscode.l10n.t("Struct");
    case "enum":
      return vscode.l10n.t("Enum");
    case "namespace":
      return vscode.l10n.t("Namespace");
    case "module":
      return vscode.l10n.t("Module");
    case "declarations":
      return vscode.l10n.t("Declaration group");
    default:
      return vscode.l10n.t("Block");
  }
}

/**
 * Code Vision이 너무 길어 코드 가독성을 해치지 않도록 작성자 이름을 줄인다.
 * @param value 표시 문자열
 * @param max 최대 길이
 * @returns 원문 또는 말줄임 문자열
 */
function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(1, max - 3))}...`;
}

/**
 * Unix epoch seconds를 이미지와 유사한 짧은 YYYY-MM-DD 날짜로 표시한다.
 * @param seconds Git blame author-time
 * @returns 시간대에 흔들리지 않는 날짜 문자열
 */
function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * 문서 라인들을 빈 줄 그룹 모델이 소비할 수 있는 문자열 배열로 복사한다.
 * @param document 현재 TextDocument
 * @returns 문서 순서와 같은 0-based 라인 텍스트 배열
 */
function documentLineTexts(document: vscode.TextDocument): string[] {
  return Array.from(
    { length: document.lineCount },
    (_, index) => document.lineAt(index).text
  );
}

/**
 * 숫자를 inclusive 최소/최대 범위에 제한한다.
 * @param value 제한할 숫자
 * @param minimum 최소값
 * @param maximum 최대값
 * @returns 범위 안 숫자
 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
