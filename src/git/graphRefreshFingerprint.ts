// Graph 새로고침이 실제 Git 상태 변경인지 판별하는 순수/조회 helper 모듈.
// - watcher의 같은 delete 관측을 시간 창 없이 의미적으로 합쳐 불필요한 graph 재로드를 막는다.
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { runGit, type RunGitOptions } from "./gitExec";
import { parseWorktreePorcelain, type WorktreeInfo } from "./worktreeService";
import { parseRemoteBranchTips, type GraphRemoteBranchTip } from "./graphBranchCatalog";

const REF_SEPARATOR = "\x1f";

/** Git graph에 영향을 주는 상태를 순서와 무관하게 표현한 짧은 식별자다. */
export type GraphRefreshFingerprint = string;

/** 문자열 항목을 정렬·중복 제거해 안정적인 fingerprint 입력으로 바꾼다. */
function normalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/** HEAD, ref, tag, worktree 출력에서 순서 독립적인 Graph fingerprint를 만든다. */
export function createGraphRefreshFingerprint(parts: { head: string; symbolicHead: string; refs: string[]; worktrees: string[] }): GraphRefreshFingerprint {
  return [parts.head.trim(), parts.symbolicHead.trim(), ...normalized(parts.refs), "--worktrees--", ...normalized(parts.worktrees)].join("\n");
}

/** 테스트에서 실제 프로세스 실행 수와 fallback을 관찰할 수 있는 Git 조회 경계다. */
export type GraphFingerprintRunner = (args: string[], repoRoot: string, options?: Pick<RunGitOptions, "signal">) => Promise<string>;

/** 새로고침 판정과 첫 로드가 같은 Git 조회의 worktree·원격 ref를 공유하는 snapshot이다. */
export interface GraphRefreshSnapshot {
  fingerprint: GraphRefreshFingerprint;
  worktrees: readonly WorktreeInfo[];
  remoteTips?: readonly GraphRemoteBranchTip[];
}

/**
 * 현재 저장소의 Graph 의미 상태를 읽되 worktree 목록에 있는 HEAD/branch를 재사용한다.
 * - Git 실행 자체가 느린 환경에서 같은 정보를 위한 rev-parse/symbolic-ref 프로세스 두 개를 줄인다.
 * - worktree를 식별할 수 없거나 unborn/bare 상태이면 기존 HEAD 조회로 돌아가 오류 의미를 유지한다.
 * @param repoRoot 조회할 저장소 또는 linked worktree의 루트. 심볼릭 링크 경로도 허용한다.
 * @param runner 두 기본 조회와 필요한 경우의 HEAD fallback을 실행하는 경계
 * @param signal 더 이상 필요하지 않은 Git 조회를 종료하는 호출 수명 신호
 * @returns 기존 네 가지 출력으로 만든 것과 같은 Graph fingerprint
 */
export async function readGraphRefreshFingerprint(
  repoRoot: string, runner: GraphFingerprintRunner = runGit, signal?: AbortSignal
): Promise<GraphRefreshFingerprint> {
  return (await readGraphRefreshSnapshot(repoRoot, runner, signal)).fingerprint;
}

/**
 * fingerprint와 그 판정에 사용한 worktree·원격 ref를 함께 반환해 같은 reload의 재조회를 줄인다.
 * @param repoRoot Git 저장소 루트, runner 실제 Git 실행 경계, signal 취소된 조회의 자식 프로세스 종료 신호
 * @returns 의미 fingerprint와 같은 시점에 Git에서 읽은 worktree 목록·원격 tip
 */
export async function readGraphRefreshSnapshot(
  repoRoot: string, runner: GraphFingerprintRunner = runGit, signal?: AbortSignal
): Promise<GraphRefreshSnapshot> {
  signal?.throwIfAborted();
  const options = signal ? { signal } : undefined;
  const [refs, worktrees] = await Promise.all([
    runner(["for-each-ref", `--format=%(refname)${REF_SEPARATOR}%(objectname)${REF_SEPARATOR}%(refname:short)`, "refs/heads", "refs/remotes", "refs/tags"], repoRoot, options),
    runner(["worktree", "list", "--porcelain"], repoRoot, options),
  ]);
  signal?.throwIfAborted();
  const parsedWorktrees = parseWorktreePorcelain(worktrees);
  const current = await findCurrentWorktree(parsedWorktrees, repoRoot);
  let head: string, symbolicHead: string;
  if (current && hasHeadIdentity(current)) {
    head = current.head;
    symbolicHead = current.branchRef ?? "DETACHED";
  } else {
    [head, symbolicHead] = await Promise.all([
      runner(["rev-parse", "HEAD"], repoRoot, options),
      runner(["symbolic-ref", "-q", "HEAD"], repoRoot, options).catch(() => "DETACHED"),
    ]);
  }
  signal?.throwIfAborted();
  const refSnapshot = parseRefSnapshot(refs);
  return {
    fingerprint: createGraphRefreshFingerprint({ head, symbolicHead, refs: refSnapshot.refs, worktrees: worktrees.split("\n\n") }),
    worktrees: parsedWorktrees,
    ...(refSnapshot.remoteTips !== undefined ? { remoteTips: refSnapshot.remoteTips } : {}),
  };
}

/**
 * 추가 short-name 필드를 기존 fingerprint 형식으로 되돌리고 원격 catalog의 tip을 재사용한다.
 * @param output full ref·object ID·Git이 해석한 short name을 구분자로 나눈 for-each-ref 출력
 * @returns 기존 의미 ref 행과 원격 tip. 이전 형식·불완전 출력은 catalog 재조회를 유지한다.
 */
function parseRefSnapshot(output: string): { refs: string[]; remoteTips?: GraphRemoteBranchTip[] } {
  const rows = output.split("\n").filter(Boolean).map(line => ({ line, fields: line.split(REF_SEPARATOR) }));
  const complete = rows.every(({ fields }) => fields.length === 3 && fields[0].startsWith("refs/") && fields[1] && fields[2]);
  return {
    refs: rows.map(({ line, fields }) => fields.length === 3 ? `${fields[0]} ${fields[1]}` : line),
    ...(complete ? {
      remoteTips: parseRemoteBranchTips(rows.map(({ fields: [fullRef, hash, name] }) => [hash, name, fullRef].join(REF_SEPARATOR)).join("\n")),
    } : {}),
  };
}

/**
 * 직접 경로를 먼저 대조하고, symlink일 때만 실제 경로를 읽어 현재 worktree 항목을 찾는다.
 * @param worktrees 이미 파싱한 Git worktree 목록
 * @param repoRoot Git을 실행한 루트 경로
 * @returns 현재 worktree. 경로를 식별하지 못하면 undefined로 HEAD fallback을 요청한다.
 */
async function findCurrentWorktree(worktrees: readonly WorktreeInfo[], repoRoot: string): Promise<WorktreeInfo | undefined> {
  const root = path.resolve(repoRoot);
  const direct = worktrees.find((worktree) => path.resolve(worktree.path) === root);
  if (direct) return direct;
  const canonical = await realpath(repoRoot).catch(() => undefined);
  return canonical ? worktrees.find((worktree) => path.resolve(worktree.path) === canonical) : undefined;
}

/**
 * SHA-1/SHA-256의 유효한 커밋과 branch/detached 표시가 있어야 별도 HEAD 조회를 생략한다.
 * @param worktree 현재 루트와 일치한 worktree 항목
 * @returns bare·unborn·불완전 출력이면 false. 정상 HEAD를 검증할 기존 Git 조회를 유지한다.
 */
function hasHeadIdentity(worktree: WorktreeInfo): boolean {
  return !worktree.bare && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(worktree.head) &&
    !/^0+$/.test(worktree.head) && !!(worktree.branchRef || worktree.detached);
}

/**
 * 전체 Graph fingerprint에서 refs/remotes 행만 추려 remote catalog cache 버전을 만든다.
 * - HEAD/local/tag/worktree 변화는 원격 tracking ref 재조회 이유가 아니므로 버전에 포함하지 않는다.
 * @param fingerprint createGraphRefreshFingerprint가 만든 전체 의미 snapshot
 * @returns 순서 안정적인 짧은 remote ref 버전
 */
export function graphRemoteRefVersion(fingerprint: GraphRefreshFingerprint): string {
  const remoteLines = fingerprint.split("\n")
    .filter((line) => line.startsWith("refs/remotes/"))
    .sort();
  return fingerprintDigest(remoteLines.join("\n"));
}

/** 캐시 key와 OUTPUT 로그에 원문 ref 목록 대신 쓸 안정적인 FNV-1a digest를 만든다. */
function fingerprintDigest(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
