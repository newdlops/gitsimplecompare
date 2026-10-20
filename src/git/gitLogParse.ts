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
  return parseGitLogSnapshot(out, fullRefNames).page;
}

/** 같은 Native log 조회의 커밋과 HEAD가 실제 가리킨 full branch ref다. 페이지 밖/detached HEAD는 ref가 없다. */
export interface GitLogSnapshot { page: Commit[]; headRef?: string; }

/**
 * 기존 커밋 필드를 바꾸지 않고 Native decoration의 symbolic HEAD 증거만 별도로 보존한다.
 * @param out NUL 구분 Git log 출력 @param fullRefNames --decorate=full을 사용했을 때만 HEAD 증거를 채택한다.
 * @returns 커밋 배열과 HEAD→full ref. 같은 OID의 다른 checkout을 구분하며 추가 Git 조회를 하지 않는다.
 */
export function parseGitLogSnapshot(out: string, fullRefNames = false): GitLogSnapshot {
  const entries = out.split("\0").filter(entry => entry.length > 0);
  const page = entries.map(entry => parseGitLogCommit(entry, fullRefNames));
  const index = fullRefNames ? page.findIndex(commit => commit.refs.includes("HEAD")) : -1;
  if (index < 0) return { page };
  const decoration = entries[index].split(LOG_FIELD_SEPARATOR)[5] ?? "";
  const pointers = decoration.split(", ").filter(part => part.startsWith("HEAD -> refs/heads/"));
  return { page, ...(pointers.length === 1 ? { headRef: pointers[0].slice("HEAD -> ".length) } : {}) };
}
