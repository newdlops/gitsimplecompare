// 충돌 유무는 작업 파일 diff 대신 Git index의 unmerged stage만 읽어 판단한다.
import { runGit } from "./gitExec";

/** unmerged index 한 stage의 원본 mode/OID다. */
export interface UnmergedStageEntry { stage: 1 | 2 | 3; mode: string; oid: string }

/**
 * 한 literal 경로의 stage 1/2/3을 NUL 형식으로 읽고 다른 경로는 포함하지 않는다.
 * @param indexEnv 잠근 index transaction에서 사용할 선택적 GIT_INDEX_FILE 환경
 * @returns stage별 mode/OID. 해결된 경로는 빈 Map이다.
 */
export async function readUnmergedStages(
  repoRoot: string, rel: string, indexEnv: Record<string, string> = {}
): Promise<Map<1 | 2 | 3, UnmergedStageEntry>> {
  const raw = await runGit(["ls-files", "--unmerged", "-z", "--", rel], repoRoot,
    { GIT_LITERAL_PATHSPECS: "1", ...indexEnv });
  const entries = new Map<1 | 2 | 3, UnmergedStageEntry>();
  for (const record of raw.split("\0")) {
    const match = /^(\d+) ([0-9a-f]{4,64}) ([123])\t/.exec(record);
    if (!match || record.slice(record.indexOf("\t") + 1) !== rel) continue;
    const stage = Number(match[3]) as 1 | 2 | 3;
    entries.set(stage, { stage, mode: match[1], oid: match[2] });
  }
  return entries;
}

/**
 * 작업트리/미추적 파일을 검색하지 않고 stage 1/2/3에 남은 충돌 경로를 반환한다.
 * - 동일 경로의 여러 stage는 하나로 합치고 NUL 구분으로 특수 문자 파일명을 보존한다.
 * - 매번 실제 index를 읽어 Resolve/Continue 직후의 변경도 즉시 반영한다.
 * @param repoRoot 저장소 루트 또는 linked worktree 루트
 * @returns Git index 순서의 중복 없는 충돌 경로
 */
export async function listUnmergedFiles(repoRoot: string): Promise<string[]> {
  const out = await runGit(["ls-files", "--unmerged", "-z"], repoRoot);
  const paths = out.split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid unmerged index entry.");
    return entry.slice(separator + 1);
  });
  return [...new Set(paths)];
}
