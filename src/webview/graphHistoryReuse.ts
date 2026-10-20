import type { Commit } from "../graph/graphTypes";
import type { GraphRefreshContext } from "./graphRefreshCoordinator";

interface RefState { head: string; roots: Set<string>; branches: Map<string, string>; other: Map<string, string> }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/**
 * 자동/명령 갱신에서 metadata와 DAG의 동등성이 확인된 경우에만 이력을 재사용한다.
 * @param context 이전 성공 게시와 이번 Git snapshot @param commits 현재 읽은 실제 DAG
 * @returns 수동/첫 로드, metadata 불확실·변경, replace ref는 전체 Git log 경로를 사용한다.
 */
export function canReuseGraphSnapshot(context: GraphRefreshContext, commits: readonly Commit[]): boolean {
  return !["ready", "manual"].includes(context.cause) && !context.historyUncertain && !!context.historyIdentity &&
    context.previous?.historyIdentity === context.historyIdentity && !context.fingerprint.includes("\nrefs/replace/") &&
    canReuseGraphHistory(context.previous.fingerprint, context.fingerprint, commits);
}

/**
 * ref 이름·HEAD만 바뀌고 도달 가능한 커밋 집합은 같은지 이미 읽은 DAG로 증명한다.
 * - 새 tip이 미조회 커밋이거나 삭제한 tip의 이력을 보존한다고 증명하지 못하면 전체 log를 다시 읽는다.
 * - tag·stash·복구 ref 변화는 이 경로에서 해석하지 않고 Git의 전체 decoration 조회에 맡긴다.
 * @param previous 마지막 게시를 완료한 fingerprint @param next 작업 뒤 새 fingerprint
 * @param commits 현재 화면에 보존한 실제 커밋과 부모 관계
 * @returns 두 root 집합의 도달 가능성이 서로 포함됨을 확인했을 때만 true
 */
export function canReuseGraphHistory(previous: string | undefined, next: string, commits: readonly Commit[]): boolean {
  if (!previous || !commits.length) return false;
  const before = refState(previous), after = refState(next);
  if (!before || !after || before.other.size !== after.other.size ||
    [...before.other].some(([ref, hash]) => after.other.get(ref) !== hash)) return false;
  const byHash = new Map(commits.map(commit => [commit.hash, commit.parents]));
  if (before.head !== after.head && !byHash.has(after.head)) return false;
  const added = [...after.roots].filter(hash => !before.roots.has(hash));
  const removed = [...before.roots].filter(hash => !after.roots.has(hash));
  return covered(added, before.roots, byHash) && covered(removed, after.roots, byHash);
}

/** fingerprint에서 branch root와 해석을 Git에 맡길 나머지 ref를 분리한다. */
function refState(fingerprint: string): RefState | undefined {
  const [head, , ...lines] = fingerprint.split("\n");
  if (!OID.test(head)) return undefined;
  const roots = new Set([head]), branches = new Map<string, string>(), other = new Map<string, string>();
  let worktrees = false;
  for (const line of lines) {
    if (line === "--worktrees--") { worktrees = true; continue; }
    if (worktrees) { const head = /^HEAD ([a-f0-9]+)$/i.exec(line)?.[1]; if (head && OID.test(head) && !/^0+$/.test(head)) roots.add(head); continue; }
    const match = /^(refs\/\S+) ([a-f0-9]+)$/i.exec(line);
    if (!match || !OID.test(match[2])) return undefined;
    if (/^refs\/(?:heads|remotes)\//.test(match[1])) { roots.add(match[2]); branches.set(match[1], match[2]); }
    else other.set(match[1], match[2]);
  }
  return { head, roots, branches, other };
}

/** 읽은 부모만 순회하므로 경계 밖의 조상을 추측하지 않고 필요한 tip만 확인한다. */
function covered(targets: readonly string[], roots: Set<string>, parents: Map<string, string[]>): boolean {
  if (!targets.length) return true;
  const missing = new Set(targets), seen = new Set<string>(), pending = [...roots];
  while (pending.length && missing.size) {
    const hash = pending.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash); missing.delete(hash);
    for (const parent of parents.get(hash) ?? []) pending.push(parent);
  }
  return missing.size === 0;
}

/**
 * 재사용이 증명된 DAG에서 로컬·원격·symbolic HEAD 배지만 새 실제 tip으로 옮긴다.
 * @param commits 수정할 현재 커밋 행 @param previous 이전 fingerprint @param next 새 fingerprint
 * full ref에서 Git decoration 이름을 만들므로 동명 tag/branch의 ambiguous short name도 잘못 붙이지 않는다.
 */
export function syncGraphReferenceTips(commits: Commit[], previous: string, next: string): void {
  const before = refState(previous), after = refState(next);
  if (!before || !after) return;
  const name = (fullRef: string) => fullRef.replace(/^refs\/(?:heads|remotes)\//, "");
  const names = new Set([...before.branches.keys(), ...after.branches.keys()].map(name));
  const byHash = new Map<string, Commit>();
  for (const commit of commits) {
    commit.refs = commit.refs.filter(ref => ref !== "HEAD" && !names.has(ref));
    if (!byHash.has(commit.hash)) byHash.set(commit.hash, commit);
  }
  for (const [ref, hash] of after.branches) {
    const commit = byHash.get(hash), label = name(ref);
    if (commit && !commit.refs.includes(label)) commit.refs.push(label);
  }
  byHash.get(after.head)?.refs.unshift("HEAD");
}
