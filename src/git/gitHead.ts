// git HEAD 조회를 공유하는 작은 helper 모듈.
// - graphPanel 같은 상위 레이어가 GitLogService 내부 private 메서드에 기대지 않게 한다.
import { runGit } from "./gitExec";

/**
 * 현재 저장소의 HEAD 커밋 해시를 반환한다.
 * - 아직 커밋이 없는 저장소나 detached/손상 상태처럼 HEAD 검증이 실패하면 undefined 를 반환한다.
 * @param repoRoot git 명령을 실행할 저장소 루트
 * @returns 현재 HEAD 해시 또는 조회 불가 시 undefined
 */
export async function getHeadHash(repoRoot: string): Promise<string | undefined> {
  try {
    const out = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}
