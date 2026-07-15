// 충돌 해결 중 같은 저장소의 index/worktree mutation이 서로 끼어들지 않게 조정한다.
// - Git 명령 자체는 실행하지 않고, 패널과 명령 레이어가 공유할 저장소 단위 lease만 제공한다.
import * as path from "node:path";

const activeRepositories = new Set<string>();

/** 저장소 경로 표기 차이를 줄이기 위해 mutation key를 절대 경로로 정규화한다. */
function repositoryKey(repoRoot: string): string {
  return path.resolve(repoRoot);
}

/**
 * 대상 저장소에서 다른 충돌 mutation이 진행 중인지 확인한다.
 * @param repoRoot 확인할 저장소 루트
 * @returns lease가 잡혀 있으면 true
 */
export function isConflictMutationActive(repoRoot: string): boolean {
  return activeRepositories.has(repositoryKey(repoRoot));
}

/**
 * 저장소 단위 충돌 mutation lease를 비차단 방식으로 얻는다.
 * @param repoRoot mutation을 시작할 저장소 루트
 * @returns 성공 시 반드시 한 번 호출할 release 함수, 이미 사용 중이면 undefined
 */
export function tryAcquireConflictMutation(
  repoRoot: string
): (() => void) | undefined {
  const key = repositoryKey(repoRoot);
  if (activeRepositories.has(key)) return undefined;
  activeRepositories.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRepositories.delete(key);
  };
}

/**
 * 저장소 lease의 획득/해제를 보장하면서 하나의 비동기 Git mutation을 실행한다.
 * @param repoRoot 대상 저장소 루트
 * @param action lease 안에서 실행할 작업
 * @returns action의 반환값
 */
export async function runConflictMutation<T>(
  repoRoot: string,
  action: () => Promise<T>
): Promise<T> {
  const release = tryAcquireConflictMutation(repoRoot);
  if (!release) throw new Error("Another conflict action is already running.");
  try {
    return await action();
  } finally {
    release();
  }
}
