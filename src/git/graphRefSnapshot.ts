// 작은 직접 Graph 갱신은 동일 for-each-ref에서 브랜치 metadata도 읽어 후속 프로세스를 줄인다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import type { RunGitOptions } from "./gitExec";
import { parseRichLocalBranches } from "./graphLocalBranches";
import { isGitLifecycleError } from "./gitError";
import { logInfo } from "../ui/outputLog";

const FS = "\x1f", RS = "\x1e";
export const GRAPH_BRANCH_METADATA_REF_LIMIT = 256;
const BASE_FORMAT = ["%(refname)", "%(objectname)", "%(refname:short)"].join(FS);
type Runner = (args: string[], root: string, options?: Pick<RunGitOptions, "signal">) => Promise<string>;

/** 같은 조회의 전체 ref 원문과 검증한 local metadata다. currentRef는 HEAD 일치 확인에만 사용한다. */
export interface GraphRefRead { refs: string; localBranches?: LocalBranchStatus[]; currentRef?: string; }

/**
 * 이미 표시한 작은 목록만 합쳐 읽고, 큰 공통 upstream의 기존 일괄 계산 전략은 유지한다.
 * @param branches 직전 게시한 로컬 상태 @param referenceCount 직전 local/remote ref 수
 * @returns 작은 직접 갱신에만 true. 새로 늘어난 전체 ref 수는 실제 실행의 count로 다시 제한한다.
 */
export function canIncludeGraphBranchMetadata(branches: readonly LocalBranchStatus[], referenceCount: number): boolean {
  return branches.length > 0 && referenceCount <= GRAPH_BRANCH_METADATA_REF_LIMIT && referenceCount <= branches.length * 3 &&
    branches.filter(branch => branch.upstream).length < 128 && branches.reduce((sum, branch) => sum + branch.ahead + branch.behind, 0) < 10000;
}

/**
 * 자동 fingerprint는 가벼운 ref만, 작은 직접 갱신은 제한된 metadata를 같은 Git 결과에서 읽는다.
 * @param root 저장소 @param runner 공통 Git 실행기 @param signal 취소 수명 @param includeBranches 작은 목록의 직접 갱신 힌트
 * @returns 전체 ref와 같은 시점의 metadata. 한도·출력·ref 손상은 기존 가벼운 조회로 돌아간다.
 */
export async function readGraphRefSnapshot(root: string, runner: Runner, signal: AbortSignal | undefined, includeBranches: boolean): Promise<GraphRefRead> {
  const options = signal ? { signal } : undefined;
  if (includeBranches) {
    const metadata = ["%(HEAD)", "%(refname:short)", "%(objectname)", "%(upstream:short)", "%(upstream:track)",
      "%(committerdate:iso8601-strict)", "%(subject)", "%(objecttype)"].join(FS);
    const format = `${BASE_FORMAT}${RS}%(if:equals=refs/heads)%(refname:rstrip=-2)%(then)${metadata}%(end)`;
    try {
      // refname 순서만 사용해 count 바깥의 모든 commit을 날짜 정렬 때문에 열지 않는다.
      const output = await runner(["for-each-ref", `--count=${GRAPH_BRANCH_METADATA_REF_LIMIT + 1}`, `--format=${format}`], root, options);
      const parsed = parseCombinedSnapshot(output);
      if (parsed) return parsed;
      logInfo("graph branch metadata snapshot fallback", { repoRoot: root, reason: "limitOrIncompleteMetadata" });
    } catch (error) {
      signal?.throwIfAborted();
      if (isGitLifecycleError(error)) throw error;
      logInfo("graph branch metadata snapshot fallback", { repoRoot: root, reason: "metadataReadFailed" });
    }
  }
  return { refs: await runner(["for-each-ref", `--format=${BASE_FORMAT}`], root, options) };
}

/** 완전한 commit metadata만 기존 파서에 넘기고 같은 Git 날짜/이름 순서로 로컬 목록을 정렬한다. */
function parseCombinedSnapshot(output: string): GraphRefRead | undefined {
  const rows = output.split("\n").filter(Boolean);
  if (rows.length > GRAPH_BRANCH_METADATA_REF_LIMIT) return undefined;
  const refs: string[] = [], metadata: string[] = [];
  let currentRef: string | undefined;
  for (const row of rows) {
    const fields = row.split(RS);
    if (fields.length !== 2) return undefined;
    const header = fields[0].split(FS);
    if (header.length !== 3 || !header[0].startsWith("refs/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(header[1])) return undefined;
    refs.push(fields[0]);
    if (!header[0].startsWith("refs/heads/")) { if (fields[1]) return undefined; continue; }
    const values = fields[1].split(FS);
    if (values.length !== 8 || values[7] !== "commit" || values[1] !== header[0].slice("refs/heads/".length) || values[2] !== header[1]) return undefined;
    if (values[0] === "*") { if (currentRef) return undefined; currentRef = header[0]; }
    metadata.push(values.slice(0, -1).join(FS));
  }
  const localBranches = parseRichLocalBranches(metadata.join("\n"));
  if (localBranches.length !== metadata.length || localBranches.some(branch => !Number.isFinite(Date.parse(branch.dateIso)))) return undefined;
  localBranches.sort((left, right) => Date.parse(right.dateIso) - Date.parse(left.dateIso));
  return { refs: refs.join("\n"), localBranches, currentRef };
}
