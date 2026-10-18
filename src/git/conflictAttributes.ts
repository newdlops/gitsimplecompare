// 충돌 표시용 diff attributes를 읽는다. 묶음 조회는 stdin NUL 형식으로 특수 파일명도 보존한다.
import { runGit, runGitWithInput } from "./gitExec";

const ENV = { GIT_LITERAL_PATHSPECS: "1" };

/** 한 literal 경로의 현재 -diff 여부를 읽는다. 조회 오류는 기존 표시 정책처럼 text 기본값으로 둔다. */
export async function readConflictDiffAttribute(root: string, rel: string, signal?: AbortSignal): Promise<boolean> {
  const raw = await runGit(["check-attr", "-z", "diff", "--", rel], root, { env: ENV, signal })
    .catch(() => { signal?.throwIfAborted(); return ""; });
  return raw.split("\0")[2] === "unset";
}

/**
 * 같은 갱신의 여러 파일 속성을 하나의 Git 실행으로 읽고 결과를 경로별로 구분한다.
 * @param rels 미리 검증된 저장소 상대 경로. 공백·줄바꿈·pathspec magic도 파일명 그대로 전달한다.
 * @returns -diff 경로는 true이며 나머지는 false다. 작업트리 속성 파일은 매번 새로 확인한다.
 */
export async function readConflictDiffAttributes(root: string, rels: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, boolean>> {
  signal?.throwIfAborted();
  const result = new Map(rels.map(rel => [rel, false]));
  if (!rels.length) return result;
  const raw = await runGitWithInput(["check-attr", "-z", "--stdin", "diff"], root, rels.join("\0") + "\0", { env: ENV, signal })
    .catch(() => { signal?.throwIfAborted(); return ""; });
  const fields = raw.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 1] === "diff" && result.has(fields[index])) result.set(fields[index], fields[index + 2] === "unset");
  }
  return result;
}
