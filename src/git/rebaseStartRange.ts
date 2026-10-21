// Start의 topology·todo coverage에 필요한 ASCII hash/parent만 읽고 커밋 본문을 호스트로 가져오지 않는다.
import { runGit } from "./gitExec";

/** coverage가 요구하는 최소 commit 식별 정보다. 사용자 메시지는 검증 자료로 파싱하지 않는다. */
export interface RebaseRangeCommit { hash: string; }
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MERGE_MESSAGE = "This interactive rebase plan contains merge commits. Choose a linear commit range; merge history is not supported by this editor.";

/**
 * 실제 현재 범위를 한 Native 조회로 읽으며 merge DAG와 불완전한 metadata를 쓰기 전에 거부한다.
 * - 사용자 subject/body를 구분자로 섞지 않아 제어 문자가 topology 검증을 바꿀 수 없게 한다.
 * - 조회 결과는 호출 간 캐시하지 않는다. 실행 직전 checkout 재검증은 서비스가 별도로 유지한다.
 * @param repoRoot 저장소 또는 linked worktree 루트 @param base root=false일 때 재작성 범위 직전 OID
 * @param root 전체 HEAD 조상을 읽을지 여부 @param runner 공통 실행 경계 또는 metadata 검증용 대역
 * @returns 오래된 순서의 완전한 hash 목록. 파일 diff·subject·body는 읽지 않는다.
 */
export async function readLinearRebaseRange(
  repoRoot: string, base: string, root: boolean,
  runner: (args: string[], cwd: string) => Promise<string> = runGit
): Promise<RebaseRangeCommit[]> {
  const raw = await runner(["rev-list", "--reverse", "--format=%H%x00%P", "--no-commit-header",
    root ? "HEAD" : `${base}..HEAD`, "--"], repoRoot);
  if (!raw) return [];
  if (!raw.endsWith("\n")) throw new Error("Invalid rebase range metadata.");
  const lines = raw.split(/\r?\n/); lines.pop();
  const commits: RebaseRangeCommit[] = [], seen = new Set<string>();
  for (const line of lines) {
    const fields = line.split("\0"), [hash, rawParents] = fields;
    const parents = rawParents ? rawParents.split(" ") : [];
    if (fields.length !== 2 || !OID.test(hash) || seen.has(hash) ||
        parents.some(parent => !OID.test(parent) || parent.length !== hash.length)) {
      throw new Error("Invalid rebase range metadata.");
    }
    if (parents.length > 1) throw new Error(MERGE_MESSAGE);
    seen.add(hash); commits.push({ hash });
  }
  return commits;
}
