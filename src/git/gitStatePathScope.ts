// 한 작업의 private 상태 파일 경로만 공유한다. Git identity/ref/index/설정 검증은 매 경계에서 그대로 수행한다.
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { resolveGitExecutable, runGit } from "./gitExec";
import { readRepositoryMetadata } from "./repositoryMetadata";

interface StatePathScope { root: string; alive: boolean; identity?: string; reusable?: boolean; paths: Map<string, Promise<string>>; }
const scopes = new AsyncLocalStorage<StatePathScope>();

/** 선택한 저장소가 교체된 오류는 선택적 pending 정리 실패로 무시하지 않고 쓰기 전에 전파한다. */
export class GitStatePathIdentityError extends Error {
  /** 복구 JSON을 다른 worktree에 기록하지 않았다는 의미를 유지하는 고정 오류를 만든다. */
  constructor() { super("Git repository metadata changed during the operation. Recovery state was left unchanged."); this.name = "GitStatePathIdentityError"; }
}

/**
 * 함수 한 번의 실행 동안만 확장 private 상태 경로를 공유하고 완료/실패 때 즉시 해제한다.
 * @param repoRoot 작업이 고정한 저장소 @param action 실제 작업. 병렬·다른 저장소 호출은 독립된 scope를 가진다.
 * @returns action의 원본 결과/오류. detached 후속 promise는 끝난 scope의 경로를 재사용하지 못한다.
 */
export async function withGitStatePathScope<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
  const root = path.resolve(repoRoot), parent = scopes.getStore();
  if (parent?.alive && parent.root === root) return action();
  const identity = await statePathIdentity(root);
  const scope: StatePathScope = { root, alive: true, identity, reusable: identity !== undefined, paths: new Map() };
  return scopes.run(scope, async () => {
    try { return await action(); }
    finally { scope.alive = false; scope.paths.clear(); }
  });
}

/**
 * Git이 결정한 worktree별 상태 파일 위치를 한 작업 안에서만 재사용한다.
 * - 각 접근에서 .git/commondir·실행 파일·상속 Git 환경을 확인한다. 교체되면 다른 저장소에 쓰기 전에 중단한다.
 * - scope 밖, bare, 증거 조회 실패는 원래 rev-parse 경로를 사용하며 HEAD/안전 검사는 생략하지 않는다.
 * @param repoRoot 고정된 작업트리 @param relativePath gitsimplecompare 아래의 확장 private 파일
 * @returns Git이 해석한 절대 경로. 실패한 조회는 저장하지 않아 다음 접근에서 재시도할 수 있다.
 */
export async function resolveGitStatePath(repoRoot: string, relativePath: string): Promise<string> {
  if (!/^gitsimplecompare\/[a-z0-9-]+\.json$/.test(relativePath)) throw new Error("Only private operation state paths can be shared.");
  return resolveScopedValue(repoRoot, relativePath, () => freshPath(repoRoot, relativePath));
}

/** Git이 검증한 metadata 디렉터리 위치만 재사용한다. HEAD/branch identity 조회는 이 함수를 사용하지 않는다. */
export function reuseGitOperationDirectory(repoRoot: string, read: () => Promise<string>): Promise<string> {
  return resolveScopedValue(repoRoot, "\0git-directory", read);
}

/**
 * 새 HEAD/branch 안전 조회가 함께 검증한 Git 디렉터리만 같은 작업의 후속 경로 조회에 제공한다.
 * @param repoRoot 실제 checkout을 읽은 저장소 @param directory 방금 Git이 반환하고 realpath한 위치
 * @returns metadata/실행 환경이 작업 시작과 같을 때만 기억한다. 다른 checkout으로 바뀌면 즉시 중단한다.
 */
export async function rememberGitOperationDirectory(repoRoot: string, directory: string): Promise<void> {
  const scope = scopes.getStore();
  if (!scope?.alive || scope.root !== path.resolve(repoRoot) || !scope.reusable) return;
  if (await statePathIdentity(repoRoot) !== scope.identity) throw new GitStatePathIdentityError();
  if (!scope.alive) return;
  const existing = scope.paths.get("\0git-directory");
  if (existing && await existing !== directory) throw new GitStatePathIdentityError();
  scope.paths.set("\0git-directory", Promise.resolve(directory));
}

/** 동일 실행 환경·metadata 증거의 범위에서 경로 promise만 합치고 실패 결과는 제거한다. */
async function resolveScopedValue(repoRoot: string, key: string, read: () => Promise<string>): Promise<string> {
  const scope = scopes.getStore();
  if (!scope?.alive || scope.root !== path.resolve(repoRoot)) return read();
  const identity = await statePathIdentity(repoRoot);
  if (!scope.alive) return read();
  if (scope.identity !== undefined && identity !== scope.identity) {
    throw new GitStatePathIdentityError();
  }
  if (scope.reusable === false || identity === undefined) { scope.reusable = false; return read(); }
  scope.identity = identity;
  scope.reusable = true;
  let pending = scope.paths.get(key);
  if (!pending) {
    pending = read().then(async file => {
      if (await statePathIdentity(repoRoot) !== identity) throw new GitStatePathIdentityError();
      return file;
    });
    scope.paths.set(key, pending);
    void pending.catch(() => { if (scope.paths.get(key) === pending) scope.paths.delete(key); });
  }
  return pending;
}

/** 설정 원문은 출력하지 않고 같은 Git 실행 환경과 metadata인지 작업 중에만 비교한다. */
async function statePathIdentity(repoRoot: string): Promise<string | undefined> {
  const metadata = await readRepositoryMetadata(repoRoot);
  if (!metadata) return undefined;
  const environment = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([resolveGitExecutable(repoRoot), environment, metadata.identity]);
}

/** 매번 Git 자체에 경로를 해석시키는 기존 경로다. 모든 실행은 공통 Git 진입점을 사용한다. */
async function freshPath(repoRoot: string, relativePath: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", relativePath], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}
