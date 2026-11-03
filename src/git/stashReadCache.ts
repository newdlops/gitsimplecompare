// stash 객체의 불변 미추적 경로만 저장소·OID 단위로 재사용한다. 표시 번호는 캐시 identity가 아니다.
import { LruCache } from "../utils/lruCache";
import { runStash } from "./stashExec";
import { clearStashListSnapshots } from "./stashListSnapshot";

const completed = new LruCache<string, ReadonlySet<string>>(32, 8 * 1024 * 1024,
  (key, paths) => key.length * 2 + [...paths].reduce((bytes, file) => bytes + file.length * 2 + 64, 0));
const pending = new Map<string, Promise<ReadonlySet<string>>>();
let generation = 0;

/** 확장 종료 때 완료 값을 비우고 이미 시작한 조회가 예전 결과를 다시 저장하지 못하게 한다. */
export function clearStashReadCache(): void { generation++; completed.clear(); pending.clear(); clearStashListSnapshots(); }

/**
 * 고정된 stash의 미추적 파일 집합을 한 번만 읽는다. 실패는 캐시하지 않고 다음 호출이 다시 시도한다.
 * @param repoRoot 조회할 저장소 @param hash 선택 검증이 완료된 전체 stash OID
 * @returns 읽기 전용 경로 집합. 소비자는 집합을 수정하지 않는다.
 */
export function readStashUntrackedPaths(repoRoot: string, hash: string): Promise<ReadonlySet<string>> {
  const key = JSON.stringify([repoRoot, hash]);
  const cached = completed.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const startedGeneration = generation;
  const read = runStash(["show", "--only-untracked", "--name-only", "-z", hash], repoRoot)
    .then(output => {
      const paths = new Set(output.split("\0").filter(Boolean));
      if (generation === startedGeneration) completed.set(key, paths);
      return paths;
    }).finally(() => { if (pending.get(key) === read) pending.delete(key); });
  pending.set(key, read);
  return read;
}
