// 같은 Native fingerprint의 ref/HEAD만 사용해 상세 수치를 추측하지 않는 identity snapshot을 만든다.
import type { Commit, LocalBranchIdentity } from "../graph/graphTypes";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PSEUDO_REFS = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "REBASE_HEAD", "REVERT_HEAD", "CHERRY_PICK_HEAD", "AUTO_MERGE", "BISECT_HEAD"]);

/** 전체 ref와 현재 symbolic checkout을 같은 fingerprint에서 확인한 최소 정보다. */
export interface GraphReferenceIdentity {
  head: string;
  branchRef: string;
  branches: LocalBranchIdentity[];
  /** Git decoration과 같은 표시 이름별 실제 tip. 새로 생기거나 이동한 ref도 조기 게시에서 걸러낸다. */
  refs: ReadonlyMap<string, string>;
}

/**
 * Native fingerprint의 로컬 ref/OID와 worktree HEAD가 일치할 때만 최소 identity를 반환한다.
 * @param fingerprint 이미 읽은 HEAD·symbolic ref·전체 ref 목록. worktree 본문은 다시 ref로 해석하지 않는다.
 * @returns unambiguous 로컬 checkout 또는 undefined. 날짜/제목/ahead/behind는 만들지 않는다.
 */
export function graphReferenceIdentity(fingerprint: string): GraphReferenceIdentity | undefined {
  const [head, branchRef, ...lines] = fingerprint.split("\n");
  if (!OID.test(head) || !branchRef?.startsWith("refs/heads/")) return undefined;
  const refs = new Map<string, string>(); let complete = false;
  for (const line of lines) {
    if (line === "--worktrees--") { complete = true; break; }
    const match = /^(refs\/.+) ([a-f0-9]+)$/i.exec(line);
    if (!match || !OID.test(match[2]) || refs.has(match[1])) return undefined;
    refs.set(match[1], match[2]);
  }
  if (!complete || refs.get(branchRef) !== head) return undefined;
  const branches: LocalBranchIdentity[] = [];
  for (const [ref, hash] of refs) {
    if (!ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length);
    if (!name || PSEUDO_REFS.has(name)) return undefined;
    // rich for-each-ref의 short name과 decoration 이름이 달라질 수 있는 모호한 이름은 기존 경로에 맡긴다.
    const aliases = [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
    if (aliases.filter(alias => refs.has(alias)).length !== 1) return undefined;
    branches.push({ name, hash, current: ref === branchRef });
  }
  const displayed = new Map<string, string>();
  for (const [ref, hash] of refs) {
    const name = ref.startsWith("refs/tags/") ? `tag:${ref.slice("refs/tags/".length)}` : ref.replace(/^refs\/(?:heads|remotes)\//, "");
    if (displayed.has(name) && displayed.get(name) !== hash) return undefined;
    displayed.set(name, hash);
  }
  return { head, branchRef, branches, refs: displayed };
}

/**
 * 뒤늦게 도착한 상세가 같은 전체 로컬 tip과 checkout에 속하는지 확인한다.
 * @param identity 첫 게시에 사용한 Native identity @param branches 새 상세 조회의 identity 필드
 * @returns 추가·삭제·이동·같은 OID checkout까지 일치할 때만 true
 */
export function matchesGraphReferenceIdentity(identity: GraphReferenceIdentity, branches: readonly LocalBranchIdentity[]): boolean {
  if (identity.branches.length !== branches.length) return false;
  const expected = new Map(identity.branches.map(branch => [branch.name, branch])), seen = new Set<string>();
  return branches.every(branch => {
    const previous = expected.get(branch.name);
    if (!previous || seen.has(branch.name)) return false;
    seen.add(branch.name);
    return previous.hash === branch.hash && previous.current === branch.current;
  });
}

/**
 * 새 log가 Native HEAD→full ref와 페이지 안의 모든 로컬 배지까지 같은지 확인한다.
 * @param identity fingerprint 증거 @param page 원본 log 페이지 @param headRef 같은 log에서 읽은 symbolic HEAD 증거
 * @returns HEAD가 페이지 밖이거나 checkout/ref가 다르면 false. 별도 Git 실행은 하지 않는다.
 */
export function matchesGraphPageIdentity(identity: GraphReferenceIdentity, page: readonly Commit[], headRef?: string): boolean {
  if (headRef !== identity.branchRef) return false;
  const heads = page.filter(commit => commit.refs.includes("HEAD"));
  if (heads.length !== 1 || heads[0].hash !== identity.head) return false;
  const byHash = new Map(page.map(commit => [commit.hash, commit]));
  if (byHash.size !== page.length) return false;
  for (const commit of page) for (const ref of commit.refs) {
    if (ref !== "HEAD" && identity.refs.get(ref) !== commit.hash) return false;
  }
  return identity.branches.every(branch => !byHash.has(branch.hash) || byHash.get(branch.hash)!.refs.includes(branch.name));
}
