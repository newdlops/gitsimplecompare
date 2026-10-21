// 무효화된 local-only 결과 하나를 새 Native snapshot이 다시 입증할 때만 재사용한다.
import { createHash } from "node:crypto";
type BranchMap = Map<string, string[]>;
interface VerifiedResult { key: string; history: string; value: BranchMap; }
const MAX_ENTRIES = 4096, MAX_MEMBERSHIPS = 65536, MAX_ESTIMATED_BYTES = 4 * 1024 * 1024;

/**
 * shallow/graft·Git 환경·전체 ref·실행 경계를 묶되 현재 HEAD 선택은 계산 의미에서 제외한다.
 * @param history Native refresh와 함께 읽은 metadata/이력 경계 증거
 * @param fingerprint 같은 refresh의 전체 ref 증거 @param executable 실행 설정/PATH의 식별자
 * @returns 완전한 증거가 없으면 undefined. 사용자 경로나 ref 원문은 로그로 출력하지 않는다.
 */
export function localOnlyHistoryKey(history: string | undefined, fingerprint: string, executable: string): string | undefined {
  const lines = fingerprint.split("\n"), end = lines.indexOf("--worktrees--");
  if (!history || end < 2) return undefined;
  // 사용자 지정 GIT_REPLACE_REF_BASE도 포함하도록 일부 namespace만 추측해 고르지 않는다.
  return createHash("sha256").update(JSON.stringify([history, executable, lines.slice(2, end).sort()])).digest("hex");
}

/** 계산 데이터의 수명만 관리한다. Git 읽기·브랜치 의미·UI 게시 책임은 호출자가 소유한다. */
export class LocalOnlySnapshotReuse {
  private history?: string;
  private localReady = false;
  private remoteReady = false;
  private completed?: VerifiedResult;
  private candidate?: VerifiedResult;

  /** 새 refresh의 이력 증거를 받고 local/remote를 모두 다시 받기 전에는 후보를 승인하지 않는다. */
  begin(history: string | undefined): boolean {
    const changed = history !== this.history;
    this.history = history; this.localReady = false; this.remoteReady = false;
    if (changed || !history) { this.completed = undefined; this.candidate = undefined; }
    return changed;
  }

  /** 현재 refresh가 새 local metadata를 받았음을 기록한다. 값의 비교는 호출자의 snapshot key가 담당한다. */
  localRead(): void { this.localReady = true; }
  /** 성공한 새 remote tip snapshot만 증거로 기록한다. 빈 원격 목록도 성공한 조회다. */
  remoteRead(): void { this.remoteReady = true; }
  /** remote 실패/임시 unknown 동안에는 이전 원격 상태로 후보를 승인하지 않는다. */
  remoteUnavailable(): void { this.remoteReady = false; }

  /** 같은 세대에서 완료된 계산과 계산 당시의 immutable key만 보관한다. 부분 snapshot은 후보로 삼지 않는다. */
  complete(key: string, value: BranchMap): void {
    this.completed = this.history && this.localReady && this.remoteReady ? { key, history: this.history, value } : undefined;
    this.candidate = undefined;
  }

  /** mutation 때 결과를 즉시 유효하지 않게 만들고, 제한된 최근 결과 하나만 재검증 후보로 남긴다. */
  invalidate(): void {
    if (this.completed) this.candidate = retainable(this.completed) ? this.completed : undefined;
    this.completed = undefined;
  }

  /**
   * 새 local/remote/DAG가 모두 같은 경우에만 계산을 되살린다. 실패·부분 조회는 승인으로 취급하지 않는다.
   * @param key 현재 local hash/upstream/ahead/gone와 전체 remote tip의 의미 key
   * @returns 내부 읽기 전용 결과 또는 undefined. 반환 데이터의 clone은 기존 cache가 수행한다.
   */
  restore(key: string): BranchMap | undefined {
    if (!this.localReady || !this.remoteReady) return undefined;
    const previous = this.candidate; this.candidate = undefined;
    if (!previous || !this.history || previous.history !== this.history || previous.key !== key) return undefined;
    this.completed = previous;
    return previous.value;
  }

  /** 숨김·폐기는 재검증 전 후보를 버린다. 현재 검증된 완료 결과의 기존 cache 정책은 바꾸지 않는다. */
  cancel(): void { this.candidate = undefined; }
}

/** 큰 Graph 결과를 mutation 동안 붙잡지 않도록 행·membership·보수적인 예상 크기를 모두 제한한다. */
function retainable(result: VerifiedResult): boolean {
  if (result.value.size > MAX_ENTRIES) return false;
  let memberships = 0, bytes = 2 * (result.key.length + result.history.length);
  for (const [hash, names] of result.value) {
    memberships += names.length;
    if (memberships > MAX_MEMBERSHIPS) return false;
    bytes += 128 + 2 * hash.length;
    for (const name of names) bytes += 24 + 2 * name.length;
    if (bytes > MAX_ESTIMATED_BYTES) return false;
  }
  return true;
}
