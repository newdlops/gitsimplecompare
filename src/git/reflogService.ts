// git reflog 조회 전용 서비스.
// - 그래프 UI 에서 히스토리 복구 후보를 보여주고, 사용자가 브랜치를 만들어 수동 복구할 수 있게 한다.
import { runGit } from "./gitExec";

const FS = "\x1f";
const RS = "\0";

/** 그래프 UI 에 표시할 reflog 한 항목 */
export interface ReflogEntry {
  hash: string;
  selector: string;
  shortSelector: string;
  message: string;
  dateIso?: string;
}

/**
 * 저장소의 HEAD reflog 를 최신 항목부터 읽는다.
 * @param repoRoot 저장소 루트
 * @param limit    읽을 최대 reflog 항목 수
 * @returns reflog 항목 배열
 */
export async function readReflogEntries(
  repoRoot: string,
  limit = 80
): Promise<ReflogEntry[]> {
  const out = await runGit(
    [
      "reflog",
      "show",
      "--date=iso-strict",
      "--format=%H%x1f%gD%x1f%gd%x1f%gs%x00",
      "-n",
      String(limit),
      "HEAD",
    ],
    repoRoot
  );
  return out
    .split(RS)
    .map(parseReflogEntry)
    .filter((entry): entry is ReflogEntry => Boolean(entry));
}

/**
 * NUL 로 분리한 reflog 한 행을 구조화한다.
 * @param raw `hash FS selector FS shortSelector FS message` 형태의 원문
 */
function parseReflogEntry(raw: string): ReflogEntry | undefined {
  const [hash, selector, shortSelector, message] = raw.split(FS);
  if (!hash || !selector) {
    return undefined;
  }
  return {
    hash,
    selector,
    shortSelector: shortSelector || selector,
    message: message || "",
    dateIso: dateFromSelector(selector),
  };
}

/**
 * `HEAD@{2026-06-27T17:37:34+09:00}` selector 에서 날짜만 추출한다.
 * @param selector reflog selector 문자열
 */
function dateFromSelector(selector: string): string | undefined {
  const match = /@\{(.+)\}$/.exec(selector);
  return match?.[1];
}
