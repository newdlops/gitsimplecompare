// PR 전용 격리 index의 경로를 원본 바이트로 제한 수집한다. 사용자 index에는 쓰지 않는다.
import { runGitStreamResult, type GitStreamReader } from "./gitExec";

export const REPLAY_WORKTREE_PATH_LIMIT = 50_000;
export const REPLAY_WORKTREE_BYTE_LIMIT = 8 * 1024 * 1024;
const RECORD_LIMIT = 16 * 1024;

/** Native NUL 경로 입력. undefined는 지원 범위·용량 초과이며 부분 목록을 사용하지 않는다. */
export interface ReplayWorktreePaths { input: Buffer; count: number }

/**
 * stage 또는 S-tag 레코드를 제한 수집하며 UTF-8로 왕복하지 않아 특수·비 UTF-8 파일명을 보존한다.
 * @param kind stage는 모든 일반 stage-0 파일, skipped는 현재 S-tag 경로만 수집한다.
 * @param byteLimit 전체 선택 경로의 바이트 상한 @param entryLimit 선택 경로 개수 상한
 */
export class ReplayWorktreePathReader implements GitStreamReader<ReplayWorktreePaths | undefined> {
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private paths: Buffer[] = [];
  private bytes = 0;
  private count = 0;
  private supported = true;

  constructor(private readonly kind: "stage" | "skipped", private readonly byteLimit = REPLAY_WORKTREE_BYTE_LIMIT,
    private readonly entryLimit = REPLAY_WORKTREE_PATH_LIMIT) {}

  /** Native stdout을 NUL 단위로 소비한다. 초과하면 부분 결과를 버리고 프로세스 close까지 비운다. */
  onData(chunk: Buffer): void {
    if (!this.supported) return;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(0, offset), stop = end < 0 ? chunk.length : end;
      if (this.partialBytes + stop - offset > RECORD_LIMIT) { this.discard(); return; }
      const segment = chunk.subarray(offset, stop);
      if (end < 0) {
        this.partial.push(Buffer.from(segment)); this.partialBytes += segment.length; return;
      }
      const record = this.partialBytes ? Buffer.concat([...this.partial, segment], this.partialBytes + segment.length) : segment;
      this.partial = []; this.partialBytes = 0;
      this.consume(record);
      if (!this.supported) return;
      offset = end + 1;
    }
  }

  /** 성공·close 뒤에만 완성된 입력을 반환한다. 잘린 Native 출력은 조용히 채택하지 않는다. */
  finish(): ReplayWorktreePaths | undefined {
    if (!this.supported) return undefined;
    if (this.partialBytes) throw invalidOutput();
    const input = Buffer.concat(this.paths, this.bytes), count = this.count;
    this.paths = [];
    return { input, count };
  }

  /** mode/stage만 ASCII로 검사하고 경로는 독립 Buffer로 복사해 큰 stdout 조각을 잡지 않는다. */
  private consume(record: Buffer): void {
    let start: number;
    if (this.kind === "stage") {
      const tab = record.indexOf(9);
      if (tab < 0 || tab > 80 || !/^[0-7]{6} (?:[a-f0-9]{40}|[a-f0-9]{64}) [0-3]$/.test(record.toString("latin1", 0, tab)))
        throw invalidOutput();
      const header = record.toString("latin1", 0, tab);
      if (!/^(?:100644|100755|120000) /.test(header) || !header.endsWith(" 0")) { this.discard(); return; }
      start = tab + 1;
    } else {
      if (record.length < 3 || record[1] !== 32 || !/^[A-Z?]$/.test(String.fromCharCode(record[0]))) throw invalidOutput();
      if (record[0] !== 83) return;
      start = 2;
    }
    if (start === record.length) throw invalidOutput();
    const length = record.length - start + 1;
    if (++this.count > this.entryLimit || this.bytes + length > this.byteLimit) { this.discard(); return; }
    const path = Buffer.allocUnsafe(length);
    record.copy(path, 0, start); path[length - 1] = 0;
    this.paths.push(path); this.bytes += length;
  }

  /** 지원하지 않는 index나 상한 초과는 전체 checkout으로 판단할 수 있게 수집 메모리를 즉시 놓는다. */
  private discard(): void { this.supported = false; this.paths = []; this.partial = []; this.partialBytes = 0; }
}

/** @param root 소유한 임시 worktree @returns 검증한 stage-0 일반 파일들의 제한된 NUL 입력 */
export function readReplayWorktreePaths(root: string): Promise<ReplayWorktreePaths | undefined> {
  return runGitStreamResult(["ls-files", "--stage", "-z"], root, () => new ReplayWorktreePathReader("stage"));
}

/** @param root 소유한 임시 worktree @returns 복구 때 아직 펼치지 않은 S-tag 경로만 제한 수집한 입력 */
export function readSkippedReplayWorktreePaths(root: string): Promise<ReplayWorktreePaths | undefined> {
  return runGitStreamResult(["ls-files", "--cached", "-t", "-z"], root, () => new ReplayWorktreePathReader("skipped"));
}

/** Native 성공이어도 부분·비정상 레코드를 index 쓰기 입력으로 사용하지 않는다. */
function invalidOutput(): Error { return new Error("Cannot prepare the PR worktree: incomplete or invalid index paths."); }
