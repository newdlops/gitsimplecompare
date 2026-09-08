// PR preview의 mutable 조회 세대와 immutable commit 상세를 구분한다.
import type { GhExecute } from "./ghRunner";
import { readGitHub } from "./githubReadCache";
import type { PullRequestInfo } from "./pullRequestInfo";
import type { PullRequestPreviewCommit } from "./pullRequestPreviewCommits";
import { normalizePreviewStatus } from "./pullRequestPreviewFiles";

const generations = new Map<string, number>();

/** 명시적인 새로고침 때 mutable PR 응답만 새 세대로 읽고 immutable OID cache는 유지한다. */
export function invalidatePreviewRemote(root: string): void { generations.set(root, (generations.get(root) ?? 0) + 1); }

/** 같은 PR head·갱신 시각의 조회를 공유하면서 모든 CLI에 panel의 취소 신호를 전달한다. */
export function previewReadRunner(root: string, pr?: PullRequestInfo, signal?: AbortSignal): GhExecute {
  const version = JSON.stringify([pr?.number, pr?.headHash, pr?.updatedAt, generations.get(root) ?? 0]);
  return (args, cwd, options) => readGitHub(args, cwd, { ...options, signal, version, ttlMs: 30_000 });
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid
    commits(first: 100, after: $cursor) {
      nodes { commit { oid messageHeadline committedDate author { name } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
interface CommitNode { oid: string; messageHeadline?: string; committedDate?: string; author?: { name?: string }; }
interface SummaryPage { headRefOid?: string; title?: string; body?: string;
  commits?: { nodes?: Array<{ commit?: CommitNode }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }; }
/** 미리보기 첫 요청으로 함께 얻는 저장소·본문·첫 커밋 페이지다. */
export interface PreviewBootstrap { repository: string; title: string; body: string; firstPage: SummaryPage; }
const BOOTSTRAP_QUERY = QUERY.replace("{ pullRequest(number: $number) {", "{ nameWithOwner pullRequest(number: $number) { title body");

/**
 * 저장소 문맥·제목·본문·첫 커밋 페이지를 한 요청으로 읽어 초기 네트워크 왕복을 줄인다.
 * @param pr Graph에서 선택한 head snapshot. 변경됐으면 파일 조회 전에 실패한다.
 * @returns 첫 head가 검증된 원격 데이터. 커밋 후속 페이지와 파일은 이후 병렬로 읽는다.
 */
export async function fetchPreviewBootstrap(root: string, pr: PullRequestInfo, runner: GhExecute): Promise<PreviewBootstrap> {
  const out = await runner(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-F", `number=${pr.number}`, "-f", `query=${BOOTSTRAP_QUERY}`], root, { operation: "pr-preview-bootstrap" });
  const repository = (JSON.parse(out) as { data?: { repository?: { nameWithOwner?: string; pullRequest?: SummaryPage } } }).data?.repository;
  if (!repository?.nameWithOwner || !repository.pullRequest) throw new Error("GitHub pull request preview is not available.");
  const value = repository.pullRequest;
  if (!pr.headHash || value.headRefOid !== pr.headHash) throw new Error("The pull request head changed. Refresh pull requests before opening its preview.");
  return { repository: repository.nameWithOwner, title: value.title || pr.title, body: value.body ?? "", firstPage: value };
}

/**
 * 커밋 patch 없이 제목·작성자·OID만 페이지 단위로 읽어 초기 preview를 빠르게 만든다.
 * @param pr 표시 중인 head OID. 페이지마다 같아야 이력이 섞이지 않는다.
 * @param runner panel 수명과 cache를 결합한 read 실행기
 * @param initial bootstrap에서 이미 읽은 첫 connection. 있으면 첫 요청을 반복하지 않는다.
 * @returns 원래 순서의 커밋 요약. 파일은 사용자가 선택할 때 별도로 읽는다.
 */
export async function fetchPreviewCommitSummaries(root: string, pr: PullRequestInfo, runner: GhExecute, initial?: SummaryPage): Promise<PullRequestPreviewCommit[]> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  const commits = new Map<string, PullRequestPreviewCommit>();
  do {
    let value = initial;
    initial = undefined;
    if (!value) {
      const out = await runner(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
        "-F", `number=${pr.number}`, ...(cursor ? ["-f", `cursor=${cursor}`] : []), "-f", `query=${QUERY}`], root,
        { operation: "pr-preview-commit-summaries" });
      value = (JSON.parse(out) as { data?: { repository?: { pullRequest?: SummaryPage } } }).data?.repository?.pullRequest;
    }
    if (!pr.headHash || value?.headRefOid !== pr.headHash) throw new Error("The pull request head changed. Refresh pull requests before opening its preview.");
    if (!value.commits?.nodes || typeof value.commits.pageInfo?.hasNextPage !== "boolean") throw new Error("GitHub returned incomplete commit summaries.");
    for (const { commit } of value.commits.nodes) {
      if (!commit?.oid) throw new Error("GitHub returned an invalid commit summary.");
      commits.set(commit.oid, { hash: commit.oid, shortHash: commit.oid.slice(0, 7), title: commit.messageHeadline || commit.oid.slice(0, 12),
        author: commit.author?.name, dateIso: commit.committedDate, files: [], filesLoaded: false });
    }
    if (!value.commits.pageInfo.hasNextPage) break;
    cursor = value.commits.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("GitHub commit pagination did not advance.");
    seen.add(cursor);
  } while (cursor);
  return [...commits.values()];
}

/**
 * 선택한 commit의 파일/patch를 OID cache로 읽고 대형 commit의 후속 파일 페이지도 합친다.
 * @param repository 해당 preview에서 확인한 owner/name
 * @returns 파일이 없는 성공과 조회 실패를 구분하는 commit 상세
 */
export async function fetchRemotePreviewCommit(root: string, repository: string, hash: string, signal?: AbortSignal): Promise<PullRequestPreviewCommit> {
  if (!/^[a-f\d]{40,64}$/i.test(hash)) throw new Error("Invalid commit OID.");
  const result: PullRequestPreviewCommit = { hash, shortHash: hash.slice(0, 7), title: hash.slice(0, 12), files: [], filesLoaded: true };
  for (let page = 1; ; page++) {
    const out = await readGitHub(["api", `repos/${repository}/commits/${hash}?per_page=100&page=${page}`], root,
      { operation: "pr-preview-commit-files", signal, version: "commit", ttlMs: 120_000 });
    const value = JSON.parse(out) as { sha?: string; files?: Array<{ filename: string; previous_filename?: string; status?: string; additions?: number; deletions?: number; patch?: string }> };
    if (value.sha !== hash || !Array.isArray(value.files)) throw new Error("GitHub returned incomplete commit files.");
    result.files.push(...value.files.map(file => ({ path: file.filename, oldPath: file.previous_filename,
      status: normalizePreviewStatus(file.status), additions: file.additions ?? 0, deletions: file.deletions ?? 0, patch: file.patch, comments: [] })));
    if (value.files.length < 100) return result;
    if (page >= 30) throw new Error("GitHub commit file limit reached. Open this commit on GitHub to inspect all files.");
  }
}
