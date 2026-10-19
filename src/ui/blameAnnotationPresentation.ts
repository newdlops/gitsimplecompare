// blame 표시 설정과 날짜·이름 포맷을 Git 조회에서 분리해 설정 변경만으로 다시 읽지 않게 한다.
import * as vscode from "vscode";
import type { GitBlameLine } from "../git/blameService";

export const BLAME_ANNOTATION_CONFIG = "gitSimpleCompare.blameAnnotations";
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
/** 전체 이름/ISO 날짜 기본값을 유지하면서 독립적으로 조절할 annotation 표시 설정이다. */
export interface BlameAnnotationOptions {
  dateFormat: "YYYY-MM-DD" | "DD.MM.YYYY" | "MM/DD/YYYY" | "relative";
  authorName: "full" | "first" | "last";
  compact: boolean; highlightCommit: boolean; showCommitHash: boolean;
}

/**
 * 대상 파일의 resource 설정을 읽고 잘못된 enum 값은 기본값으로 보정한다.
 * @param uri 현재 편집기 리소스 @returns Git 실행 없이 적용할 표시 옵션
 */
export function readBlameAnnotationOptions(uri: vscode.Uri): BlameAnnotationOptions {
  const config = vscode.workspace.getConfiguration(BLAME_ANNOTATION_CONFIG, uri);
  const date = config.get<string>("dateFormat", "YYYY-MM-DD"), name = config.get<string>("authorName", "full");
  return {
    dateFormat: ["YYYY-MM-DD", "DD.MM.YYYY", "MM/DD/YYYY", "relative"].includes(date) ? date as BlameAnnotationOptions["dateFormat"] : "YYYY-MM-DD",
    authorName: ["full", "first", "last"].includes(name) ? name as BlameAnnotationOptions["authorName"] : "full",
    compact: config.get<boolean>("compact", false), highlightCommit: config.get<boolean>("highlightCommit", false),
    showCommitHash: config.get<boolean>("showCommitHash", false),
  };
}

/**
 * 표시 이름만 짧게 바꾸며 tooltip과 작성자 집계에는 원래 전체 identity를 유지한다.
 * @param fullName 정규화한 전체 작성자 @param style 이름 표시 방식 @returns 단어 경계를 보존한 표시 이름
 */
export function formatBlameAuthor(fullName: string, style: BlameAnnotationOptions["authorName"]): string {
  const words = fullName.trim().split(/\s+/);
  return style === "first" ? words[0] : style === "last" ? words.at(-1)! : fullName;
}

/**
 * UTC 절대 날짜 또는 현재 VS Code 언어의 상대 시각을 만든다. 잘못된 날짜는 명시적으로 설명한다.
 * @param seconds Unix 시각 @param format 표시 형식 @param now 상대 시각의 고정 기준(테스트 가능)
 * @returns 거터에 표시할 짧은 날짜 문자열
 */
export function formatBlameDate(seconds: number | undefined, format: BlameAnnotationOptions["dateFormat"], now = Date.now()): string {
  const date = seconds === undefined ? undefined : new Date(seconds * 1000);
  if (!date || !Number.isFinite(date.getTime())) return vscode.l10n.t("Unknown date");
  if (format === "relative") {
    const elapsed = (seconds! * 1000 - now) / 1000;
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
    const [unit, scale] = units.find(([, scale]) => Math.abs(elapsed) >= scale) || units.at(-1)!;
    return relativeFormatter().format(Math.trunc(elapsed / scale), unit);
  }
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return format === "DD.MM.YYYY" ? `${day}.${month}.${year}` : format === "MM/DD/YYYY" ? `${month}/${day}/${year}` : `${year}-${month}-${day}`;
}

/** 한 snapshot의 줄 수만큼 locale formatter를 만들지 않고 현재 표시 언어의 formatter를 재사용한다. */
function relativeFormatter(): Intl.RelativeTimeFormat {
  const locale = vscode.env.language || "en";
  let formatter = relativeFormatters.get(locale);
  if (!formatter) {
    try { formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }); }
    catch { formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" }); }
    if (relativeFormatters.size >= 8) relativeFormatters.delete(relativeFormatters.keys().next().value!);
    relativeFormatters.set(locale, formatter);
  }
  return formatter;
}

/** 유효한 커밋을 짧게 표시하되 0 해시인 작업트리 줄을 가짜 commit으로 표시하지 않는다. */
export function blameHashSuffix(line: GitBlameLine, options: BlameAnnotationOptions): string {
  return options.showCommitHash && !/^0+$/.test(line.commit) ? ` · ${line.commit.slice(0, 8)}` : "";
}
