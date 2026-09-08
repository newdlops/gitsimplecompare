// rebase 계획용 커밋/파일 정보를 일괄 조회한다. 커밋 수만큼 Git 프로세스를 만들지 않는다.
import { runGit, runGitWithInput } from "./gitExec";
import type { RebaseCommit, RebaseCommitFile } from "./rebaseService";

/** 파일 diff 없이 범위 검증에 필요한 커밋 식별 정보만 담는 내부 레코드다. */
interface CommitRecord {
  hash: string;
  parent?: string;
  subject: string;
  body: string;
}

/**
 * rebase 범위의 커밋을 오래된 순서로 읽고 필요할 때만 파일 정보를 보강한다.
 * - 첫 log에서 확정한 OID를 diff-tree stdin으로 전달하므로 두 조회 사이 HEAD 이동에도 서로 섞이지 않는다.
 * - 시작 직전 coverage 검증은 includeFiles=false로 호출하되 실제 범위를 매번 새로 읽는다.
 * @param repoRoot 저장소 루트
 * @param base 대상 범위 직전 커밋. root=true이면 사용하지 않는다.
 * @param root HEAD의 전체 조상 범위를 읽을지 여부
 * @param includeFiles UI 표시용 파일 상태/라인 통계를 읽을지 여부
 * @returns 누락 없이 순서를 유지한 커밋 목록
 */
export async function readRebaseCommits(
  repoRoot: string,
  base: string,
  root: boolean,
  includeFiles = true
): Promise<RebaseCommit[]> {
  const records = parseCommitRecords(await runGit([
    "log", "--reverse", "--format=%H%x00%P%x00%s%x00%b", "-z",
    root ? "HEAD" : `${base}..HEAD`, "--",
  ], repoRoot));
  const files = includeFiles ? await readCommitFiles(repoRoot, records) : new Map<string, RebaseCommitFile[]>();
  return records.map(({ hash, subject, body }) => ({ hash, subject, body, files: files.get(hash) ?? [] }));
}

/**
 * 한 커밋의 파일 정보를 같은 batch 경로로 읽는다. root와 merge도 첫 부모 기준을 유지한다.
 * @param repoRoot 저장소 루트
 * @param hash edit 정지 지점의 확정된 커밋 OID
 * @returns 해당 커밋의 파일 상태/라인 통계
 */
export async function readRebaseCommitFiles(repoRoot: string, hash: string): Promise<RebaseCommitFile[]> {
  const records = parseCommitRecords(await runGit([
    "log", "-1", "--format=%H%x00%P%x00%s%x00%b", "-z", hash, "--",
  ], repoRoot));
  const files = await readCommitFiles(repoRoot, records);
  return files.get(records[0]?.hash) ?? [];
}

/**
 * NUL로 분리된 고정 네 필드를 파싱한다. 본문의 줄바꿈/제어 문자로 커밋을 잘못 나누지 않는다.
 * @param raw hash, parents, subject, body를 순서대로 출력한 log 결과
 * @returns 첫 부모를 포함한 커밋 메타데이터
 */
function parseCommitRecords(raw: string): CommitRecord[] {
  const tokens = raw.split("\0");
  const records: CommitRecord[] = [];
  for (let index = 0; index + 3 < tokens.length; index += 4) {
    const [hash, parents, subject, body] = tokens.slice(index, index + 4);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error("Invalid rebase commit metadata.");
    records.push({ hash, parent: parents.split(" ")[0] || undefined, subject, body: body.trim() });
  }
  return records;
}

/**
 * 모든 커밋의 raw 상태와 numstat을 단일 프로세스에서 읽는다.
 * - stdin의 `commit first-parent`는 merge의 다른 부모 diff를 제외하고 기존 첫 부모 비교를 유지한다.
 * - root는 --root로 빈 트리와 비교하므로 저장소의 SHA 형식에 의존하지 않는다.
 * @param repoRoot 저장소 루트
 * @param records 앞서 확정한 커밋/부모 OID 목록
 * @returns 커밋 OID별 파일 목록. 빈 커밋의 파일 목록은 비어 있다.
 */
async function readCommitFiles(repoRoot: string, records: CommitRecord[]): Promise<Map<string, RebaseCommitFile[]>> {
  if (!records.length) return new Map();
  const input = records.map(({ hash, parent }) => parent ? `${hash} ${parent}` : hash).join("\n") + "\n";
  const raw = await runGitWithInput([
    "diff-tree", "--stdin", "--root", "-r", "-M", "--raw", "--numstat", "-z", "--no-ext-diff",
  ], repoRoot, input);
  return parseCommitFileBatch(raw, new Set(records.map(record => record.hash)));
}

/**
 * raw/numstat의 경로 토큰을 문법에 따라 소비해 파일명과 커밋 경계를 구분한다.
 * - rename은 두 경로를 소비하고, 공백/탭/줄바꿈/해시 모양 파일명을 그대로 보존한다.
 * @param raw diff-tree의 NUL 구분 출력
 * @param expected 이번 batch에서 요청한 전체 커밋 OID 집합
 * @returns 파일 상태와 numstat이 합쳐진 커밋별 목록
 * @throws 예상 밖 출력은 빈 계획으로 숨기지 않고 조회 오류로 전달한다.
 */
function parseCommitFileBatch(raw: string, expected: Set<string>): Map<string, RebaseCommitFile[]> {
  const result = new Map<string, RebaseCommitFile[]>();
  const tokens = raw.split("\0");
  let files: RebaseCommitFile[] | undefined;
  let byPath = new Map<string, RebaseCommitFile>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (expected.has(token)) {
      files = [];
      result.set(token, files);
      byPath = new Map();
      continue;
    }
    if (!files) throw new Error("Missing rebase commit file header.");
    const status = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(token)?.[1];
    if (status) {
      const firstPath = tokens[++index];
      const renamed = status === "R" || status === "C";
      const filePath = renamed ? tokens[++index] : firstPath;
      if (!filePath || !firstPath) throw new Error("Missing rebase commit file path.");
      const file = { status, path: filePath, oldPath: renamed ? firstPath : undefined, additions: 0, deletions: 0 };
      files.push(file);
      byPath.set(filePath, file);
      continue;
    }
    const stat = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!stat) throw new Error("Invalid rebase commit file statistics.");
    const filePath = stat[3] || tokens[index += 2];
    const file = byPath.get(filePath);
    if (!file) throw new Error("Unmatched rebase commit file statistics.");
    file.additions = stat[1] === "-" ? 0 : Number(stat[1]);
    file.deletions = stat[2] === "-" ? 0 : Number(stat[2]);
  }
  return result;
}
