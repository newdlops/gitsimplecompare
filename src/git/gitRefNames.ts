// git ref 이름을 명령 레이어에서 쓰기 쉬운 단위로 나누는 유틸.
// - GitLogService 의 액션 조립 코드에서 문자열 파싱 책임을 분리한다.
import type { LocalBranchStatus } from "../graph/graphTypes";

/**
 * origin/feature 형태의 원격 브랜치 ref 를 remote 이름과 브랜치 이름으로 나눈다.
 * @param ref 원격 브랜치 short name
 * @returns remote 이름과 remote 내부 브랜치 이름
 */
export function splitRemoteRef(ref: string): { remote: string; branch: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid remote branch: ${ref}`);
  }
  return {
    remote: ref.slice(0, slash),
    branch: ref.slice(slash + 1),
  };
}

/**
 * 원격 브랜치 short name 에서 checkout 에 사용할 로컬 브랜치명을 만든다.
 * @param ref origin/feature 형태의 원격 브랜치 short name
 * @returns remote prefix 를 제거한 로컬 브랜치 이름
 */
export function localNameFromRemoteRef(ref: string): string {
  return splitRemoteRef(ref).branch;
}

/**
 * 현재 로컬 HEAD 가 remote 에 아직 반영되지 않은 상태인지 판단한다.
 * @param branch 현재 브랜치 상태
 * @returns upstream 보다 앞서 있거나 upstream 기준점이 없으면 true
 */
export function isUnpushedLocalHead(branch: LocalBranchStatus): boolean {
  return branch.ahead > 0 || !branch.upstream || branch.gone;
}
