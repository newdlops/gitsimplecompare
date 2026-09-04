// Graph가 사용할 로컬 브랜치 상태를 읽고 손상 ref를 격리하는 Git 서비스 모듈.
// - 정상 저장소는 기존 단일 for-each-ref 빠른 경로를 유지한다.
// - object가 사라진 ref 하나가 전체 Graph를 막을 때만 raw ref + batch-check 폴백을 사용한다.
import type {
  GraphInvalidRef,
  GraphLocalBranchSnapshot,
  LocalBranchStatus,
} from "../graph/graphTypes";
import { runGit, runGitWithInput } from "./gitExec";
import { parseTrack } from "./gitLogRefs";

const FS = "\x1f";

/** Graph 로컬 브랜치 조회를 테스트에서 대체할 수 있는 stdout 실행 함수다. */
export type GraphLocalBranchRunner = (
  args: string[],
  repoRoot: string
) => Promise<string>;

/** 여러 ref tip을 한 프로세스에서 검증하도록 stdin 실행 경계를 대체하는 함수다. */
export type GraphLocalBranchInputRunner = (
  args: string[],
  repoRoot: string,
  input: string
) => Promise<string>;

/** object 접근 없이 읽을 수 있는 로컬 브랜치 후보 레코드다. */
interface RawLocalBranchRef {
  fullRef: string;
  name: string;
  hash: string;
  current: boolean;
  upstream?: string;
  upstreamFull?: string;
}

/** valid commit tip의 날짜와 제목을 fallback 브랜치 행에 복원하는 메타데이터다. */
interface CommitMetadata {
  dateIso: string;
  subject: string;
}

/** 정상 경로에서 사용하는 rich for-each-ref 출력 포맷을 만든다. */
function richBranchFormat(): string {
  return [
    "%(HEAD)",
    "%(refname:short)",
    "%(objectname)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(committerdate:iso8601-strict)",
    "%(subject)",
  ].join(FS);
}

/** object metadata를 열지 않는 fallback ref 출력 포맷을 만든다. */
function rawBranchFormat(): string {
  return [
    "%(refname)",
    "%(refname:short)",
    "%(objectname)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(upstream)",
  ].join(FS);
}

/**
 * 로컬 브랜치 상태를 읽고, 누락 object를 가리키는 ref는 정상 브랜치와 분리한다.
 * - 첫 명령이 성공하면 추가 프로세스를 만들지 않는다.
 * - 첫 명령이 실패해도 raw ref에 손상이 확인되지 않으면 원래 오류를 다시 던져 권한/저장소 오류를 숨기지 않는다.
 * @param repoRoot Git 저장소 또는 linked worktree 루트
 * @param runner 일반 git stdout 실행 함수
 * @param inputRunner stdin을 받는 batch git 실행 함수
 * @returns 정상 브랜치와 Graph에서 제외할 손상 ref 목록
 */
export async function readGraphLocalBranchSnapshot(
  repoRoot: string,
  runner: GraphLocalBranchRunner = runGit,
  inputRunner: GraphLocalBranchInputRunner = runGitWithInput
): Promise<GraphLocalBranchSnapshot> {
  const format = richBranchFormat();
  try {
    const output = await runner(
      ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"],
      repoRoot
    );
    return { branches: parseRichLocalBranches(output), invalidRefs: [] };
  } catch (primaryError) {
    const rawOutput = await runner(
      ["for-each-ref", `--format=${rawBranchFormat()}`, "refs/heads", "refs/remotes"],
      repoRoot
    ).catch(() => { throw primaryError; });
    const { localRefs, knownRefs } = parseRawLocalRefs(rawOutput);
    const validity = await verifyLocalRefTips(localRefs, repoRoot, inputRunner)
      .catch(() => { throw primaryError; });
    const invalidRefs = invalidLocalRefs(localRefs, validity);
    if (invalidRefs.length === 0) throw primaryError;
    const validRefs = localRefs.filter((_ref, index) => validity[index]);
    const metadata = await readCommitMetadata(validRefs, repoRoot, runner).catch(
      () => new Map<string, CommitMetadata>()
    );
    return {
      branches: fallbackBranchStatuses(validRefs, knownRefs, metadata),
      invalidRefs,
    };
  }
}

/** rich for-each-ref의 각 행을 기존 LocalBranchStatus 계약으로 변환한다. */
export function parseRichLocalBranches(output: string): LocalBranchStatus[] {
  return output.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const [head, name, hash, upstream, track, dateIso, subject] = line.split(FS);
    if (!name || !hash) return [];
    const parsedTrack = parseTrack(track ?? "");
    return [{
      name,
      hash,
      upstream: upstream || undefined,
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      gone: parsedTrack.gone,
      current: head === "*",
      dateIso: dateIso ?? "",
      subject: subject ?? "",
    }];
  });
}

/** raw heads/remotes 출력에서 로컬 후보와 존재하는 전체 ref 이름 집합을 만든다. */
function parseRawLocalRefs(output: string): {
  localRefs: RawLocalBranchRef[];
  knownRefs: Set<string>;
} {
  const knownRefs = new Set<string>();
  const localRefs: RawLocalBranchRef[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [fullRef, name, hash, head, upstream, upstreamFull] = line.split(FS);
    if (!fullRef || !hash) continue;
    knownRefs.add(fullRef);
    if (!fullRef.startsWith("refs/heads/") || !name) continue;
    localRefs.push({
      fullRef,
      name,
      hash,
      current: head === "*",
      upstream: upstream || undefined,
      upstreamFull: upstreamFull || undefined,
    });
  }
  return { localRefs, knownRefs };
}

/** 각 local tip이 commit으로 해석되는지 cat-file 한 프로세스로 검증한다. */
async function verifyLocalRefTips(
  refs: readonly RawLocalBranchRef[],
  repoRoot: string,
  inputRunner: GraphLocalBranchInputRunner
): Promise<boolean[]> {
  if (refs.length === 0) return [];
  const input = `${refs.map((ref) => `${ref.hash}^{commit}`).join("\n")}\n`;
  const output = await inputRunner(
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    repoRoot,
    input
  );
  const lines = output.trimEnd().split("\n");
  return refs.map((_ref, index) => /\scommit$/.test(lines[index] ?? ""));
}

/** 검증에 실패한 raw local ref를 사용자 진단용 GraphInvalidRef로 변환한다. */
function invalidLocalRefs(
  refs: readonly RawLocalBranchRef[],
  validity: readonly boolean[]
): GraphInvalidRef[] {
  return refs.flatMap((ref, index) => validity[index]
    ? []
    : [{ name: ref.name, fullRef: ref.fullRef, hash: ref.hash, kind: "local" as const }]);
}

/** valid tip의 committer date와 subject를 한 번의 show 명령으로 읽는다. */
async function readCommitMetadata(
  refs: readonly RawLocalBranchRef[],
  repoRoot: string,
  runner: GraphLocalBranchRunner
): Promise<Map<string, CommitMetadata>> {
  const hashes = [...new Set(refs.map((ref) => ref.hash))];
  if (hashes.length === 0) return new Map();
  const output = await runner(
    ["show", "--no-patch", "--no-walk=sorted", `--format=%H${FS}%cI${FS}%s`, ...hashes],
    repoRoot
  );
  const result = new Map<string, CommitMetadata>();
  for (const line of output.split("\n")) {
    const [hash, dateIso, subject] = line.split(FS);
    if (hash) result.set(hash, { dateIso: dateIso ?? "", subject: subject ?? "" });
  }
  return result;
}

/** raw valid ref를 metadata가 일부 제한된 LocalBranchStatus로 만들고 최신 순으로 정렬한다. */
function fallbackBranchStatuses(
  refs: readonly RawLocalBranchRef[],
  knownRefs: ReadonlySet<string>,
  metadata: ReadonlyMap<string, CommitMetadata>
): LocalBranchStatus[] {
  return refs.map((ref) => {
    const commit = metadata.get(ref.hash);
    return {
      name: ref.name,
      hash: ref.hash,
      upstream: ref.upstream,
      ahead: 0,
      behind: 0,
      gone: !!ref.upstreamFull && !knownRefs.has(ref.upstreamFull),
      current: ref.current,
      dateIso: commit?.dateIso ?? "",
      subject: commit?.subject ?? "",
    };
  }).sort((left, right) => right.dateIso.localeCompare(left.dateIso));
}
