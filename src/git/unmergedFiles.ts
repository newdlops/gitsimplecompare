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
  repoRoot: string, rel: string, indexEnv: Record<string, string> = {}, signal?: AbortSignal
): Promise<Map<1 | 2 | 3, UnmergedStageEntry>> {
  const raw = await runGit(["ls-files", "--unmerged", "-z", "--", rel], repoRoot,
    { env: { GIT_LITERAL_PATHSPECS: "1", ...indexEnv }, signal });
  return parseUnmergedStages(raw, new Set([rel])).get(rel)!;
}

/**
 * 같은 표시 갱신의 literal 경로들을 한 index 조회로 읽는다. 호출 사이의 캐시는 두지 않는다.
 * @param repoRoot 저장소 루트 @param rels 경로 검증을 마친 소규모 표시 요청 묶음
 * @param signal 모든 소비자가 닫혔을 때 공통 읽기만 취소하는 신호
 * @returns 요청 경로별 stage map. 이미 해결된 파일은 빈 map이며 다른 파일은 포함하지 않는다.
 */
export async function readUnmergedStageMaps(
  repoRoot: string, rels: readonly string[], signal?: AbortSignal
): Promise<ReadonlyMap<string, Map<1 | 2 | 3, UnmergedStageEntry>>> {
  const paths = new Set(rels);
  if (!paths.size) return new Map();
  const raw = await runGit(["ls-files", "--unmerged", "-z", "--", ...paths], repoRoot,
    { env: { GIT_LITERAL_PATHSPECS: "1" }, signal });
  return parseUnmergedStages(raw, paths);
}

/** NUL 경계를 보존해 요청한 정확한 경로의 stage만 구분하고 해결된 경로의 빈 map도 유지한다. */
function parseUnmergedStages(raw: string, paths: ReadonlySet<string>): Map<string, Map<1 | 2 | 3, UnmergedStageEntry>> {
  const files = new Map([...paths].map(rel => [rel, new Map<1 | 2 | 3, UnmergedStageEntry>()]));
  for (const record of raw.split("\0")) {
    const match = /^(\d+) ([0-9a-f]{4,64}) ([123])\t/.exec(record);
    if (!match) continue;
    const entries = files.get(record.slice(record.indexOf("\t") + 1));
    if (!entries) continue;
    const stage = Number(match[3]) as 1 | 2 | 3;
    entries.set(stage, { stage, mode: match[1], oid: match[2] });
  }
  return files;
}

/**
 * 작업트리/미추적 파일을 검색하지 않고 stage 1/2/3에 남은 충돌 경로를 반환한다.
 * - 동일 경로의 여러 stage는 하나로 합치고 NUL 구분으로 특수 문자 파일명을 보존한다.
 * - 매번 실제 index를 읽어 Resolve/Continue 직후의 변경도 즉시 반영한다.
 * @param repoRoot 저장소 루트 또는 linked worktree 루트
 * @returns Git index 순서의 중복 없는 충돌 경로
 */
export async function listUnmergedFiles(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(["ls-files", "--unmerged", "-z"], repoRoot, { signal });
  const paths = out.split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid unmerged index entry.");
    return entry.slice(separator + 1);
  });
  return [...new Set(paths)];
}
