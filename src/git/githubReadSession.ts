// 하나의 PR 조회에서 저장소·인증 경계와 실행 환경을 고정하고 늦은 이전 문맥 응답을 거절한다.
import type { GhExecute } from "./ghRunner";
import { captureGitHubReadContext, snapshotGitHubEnvironment } from "./githubReadContext";
import { captureGitHubRemoteContext } from "./githubRemoteContext";
import { logInfo } from "../ui/outputLog";
import { gitHubRepositoryScopes, type GitHubRepositoryScope } from "./githubRepositoryScope";
import type { GitHubCredentialLease } from "./githubCredential";
import type { GitHubPullRequestSnapshots, GitHubSnapshotIdentity } from "./githubPullRequestSnapshots";

export interface GitHubReadSessionState {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  context?: string;
  scope?: GitHubRepositoryScope;
  candidate?: unknown;
  transport?: "cli" | "http";
  credential?: Promise<GitHubCredentialLease>;
  credentialKey?: string;
  generation?: number;
  preparation?: Promise<void>;
  snapshots?: GitHubPullRequestSnapshots;
}
const sessions = new WeakMap<GhExecute, GitHubReadSessionState>();
const snapshotHints = new WeakMap<GhExecute, GitHubPullRequestSnapshots>();

/** body 접근 없이 다음 상세의 앵커 전용 query가 유용한지 판단한다. 인증 권한으로 사용하지 않는다. */
export function gitHubFileSnapshotHint(execute: GhExecute, repository: string, number: number): boolean {
  return snapshotHints.get(execute)?.hasFiles(repository, number) ?? false;
}

/** 성공한 현재 페이지가 고정한 canonical 저장소·실제 인증만 불변 캐시의 identity로 반환한다. */
export function gitHubSnapshotIdentity(execute: GhExecute, repository: string): GitHubSnapshotIdentity | undefined {
  const state = sessions.get(execute), scope = state?.scope;
  if (!scope || !state?.credentialKey || !state.snapshots
    || scope.name.toLowerCase() !== repository.toLowerCase() && repository !== "{owner}/{repo}") return undefined;
  return { host: scope.host, repository: scope.name, credentialKey: state.credentialKey };
}

/** 완전한 도메인 조회가 끝난 뒤에만 bootstrap scope를 다음 논리 조회에 게시한다. */
export async function completeGitHubReadSession(execute: GhExecute, signal?: AbortSignal): Promise<void> {
  const state = sessions.get(execute);
  if (!state?.candidate) return;
  await assertGitHubReadContext(state.root, state.env, ["repo"], state.context, "read-scope", "complete", signal);
  signal?.throwIfAborted();
  gitHubRepositoryScopes.learn(state.root, state.context, state.candidate);
}

/** 캐시를 사용하는 서비스가 현재 인증의 성공한 응답 이후에만 불투명 identity를 읽게 한다. */
export function gitHubReadSessionState(execute: GhExecute): GitHubReadSessionState | undefined { return sessions.get(execute); }

/** 오래된 원격·인증 응답을 일반 네트워크 실패나 사용자 취소와 구분한다. */
export class GitHubReadContextChangedError extends Error {
  constructor() {
    super("GitHub repository or authentication changed while loading. Refresh to try again.");
    this.name = "GitHubReadContextChangedError";
  }
}

/**
 * 대기 큐 진입 때의 문맥과 실제 실행 전후의 문맥을 비교해 잘못된 캐시 key로 결과를 게시하지 않는다.
 * @param expected 최초 키. 관찰 불가능한 요청은 처음부터 캐시하지 않고 비교도 생략한다.
 * @param stage 민감한 인자 대신 OUTPUT에 남길 실행 단계
 * @throws 설정·인증이 바뀌거나 재관찰할 수 없으면 재시도 가능한 문맥 변경 오류
 */
export async function assertGitHubReadContext(root: string, env: NodeJS.ProcessEnv, args: readonly string[],
  expected: string | undefined, operation: string, stage: string, signal?: AbortSignal): Promise<void> {
  if (expected === undefined) return;
  if (await captureGitHubRequestContext(root, env, args, signal) !== expected) {
    logInfo("GitHub read context changed", { repoRoot: root, operation, stage });
    throw new GitHubReadContextChangedError();
  }
}

/**
 * 저장소를 해석하는 요청은 Git include 원본까지, 명시적 API 경로는 인증 파일만 관찰한다.
 * @param root 실행 루트, env 고정 환경, args gh 인자, signal 설정 probe 소비자의 취소 신호
 * @returns 비교 가능한 불투명 키. Git이 없는 fixture/설정 관찰 실패는 기존 파일 관찰로 보완한다.
 */
export async function captureGitHubRequestContext(root: string, env: NodeJS.ProcessEnv, args: readonly string[],
  signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const repository = args[0] === "repo" || args.some(arg => arg.includes("{owner}") || arg.includes("{repo}"));
  if (repository) {
    try {
      const value = await captureGitHubRemoteContext(root, env, signal);
      return value === undefined ? undefined : `repository:${value}`;
    } catch { signal?.throwIfAborted(); }
  }
  const value = await captureGitHubReadContext(root, env, args);
  signal?.throwIfAborted();
  return value === undefined ? undefined : `files:${value}`;
}

/**
 * PR 목록·상세의 여러 페이지가 같은 환경과 저장소 설정을 사용하게 하는 읽기 전용 실행기를 만든다.
 * @param root 조회 전체의 저장소, execute 실제 공유 조회 또는 테스트 실행기
 * @returns 첫 페이지의 문맥을 후속 페이지와 비교하는 실행기. 페이지마다 환경을 새로 읽지 않는다.
 */
export function createGitHubReadSession(root: string, execute: GhExecute): GhExecute {
  const env = snapshotGitHubEnvironment();
  let context: Promise<string | undefined> | undefined;
  const state: GitHubReadSessionState = { root, env };
  const session: GhExecute = async (args, cwd, options) => {
    const deadline = options.deadline ?? Date.now() + 30_000;
    options.signal?.throwIfAborted();
    if (cwd !== root) throw new Error("GitHub read session repository does not match.");
    const expected = await (context ??= captureGitHubRequestContext(root, env, ["repo"], options.signal));
    if (!state.transport) { state.context = expected; state.scope = gitHubRepositoryScopes.get(root, expected); }
    await assertGitHubReadContext(root, env, ["repo"], expected, options.operation, "beforePage", options.signal);
    options.signal?.throwIfAborted();
    const value = await execute(args, cwd, { ...options, env, readSession: state, deadline });
    options.signal?.throwIfAborted();
    await assertGitHubReadContext(root, env, ["repo"], expected, options.operation, "afterPage", options.signal);
    options.signal?.throwIfAborted();
    if (state.snapshots) snapshotHints.set(execute, state.snapshots);
    try {
      const result = JSON.parse(value);
      if (!result.errors?.length) {
        const repository = result.data?.repository ?? (args[0] === "repo" ? result : undefined);
        if (repository?.url && repository?.nameWithOwner) state.candidate = repository;
      }
    } catch { /* 응답 JSON·완전성 검사는 원래 서비스가 소유하며 scope는 추측하지 않는다. */ }
    return value;
  };
  sessions.set(session, state);
  return session;
}
