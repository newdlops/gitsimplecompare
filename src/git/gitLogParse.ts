// git log 출력 포맷과 Commit 파싱을 공유하는 모듈.
// - 페이지 로드와 특정 커밋 주변 window 로드가 같은 Commit 변환 규칙을 쓰게 한다.
import { Commit } from "../graph/graphTypes";
import { parseRefs } from "./gitLogRefs";

/** 로그 필드 구분자(제어문자 Unit Separator) */
export const LOG_FIELD_SEPARATOR = "\x1f";

/** git log pretty format 에 사용할 Commit 필드 목록을 만든다. */
export function gitLogPrettyFormat(): string {
  return ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s"].join(LOG_FIELD_SEPARATOR);
}

/**
 * 로그 한 항목(FS 로 구분된 문자열)을 Commit 으로 파싱한다.
 * @param entry git log 한 커밋 출력 @param fullRefNames 전체 ref 이름을 요청한 출력인지 여부
 */
export function parseGitLogCommit(entry: string, fullRefNames = false): Commit {
  const [hash, parentsStr, authorName, authorEmail, dateIso, decoration, subject] =
    entry.split(LOG_FIELD_SEPARATOR);
  return {
    hash,
    parents: parentsStr ? parentsStr.split(" ").filter(Boolean) : [],
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    dateIso: dateIso ?? "",
    refs: parseRefs(decoration ?? "", fullRefNames),
    subject: subject ?? "",
  };
}

/**
 * git log -z 출력을 Commit 배열로 변환한다.
 * @param out git log stdout @param fullRefNames 전체 ref 이름과 synthetic annotation을 구별할지 여부
 */
export function parseGitLogOutput(out: string, fullRefNames = false): Commit[] {
  return out
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => parseGitLogCommit(entry, fullRefNames));
}
