// Undo의 index 출처 검증을 같은 Native 바이트로 계산하되 전체 출력 문자열/경로 배열은 보관하지 않는다.
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { runGitStreamResult, type GitStreamReader, type RunGitOptions } from "./gitExec";

/** 기존 저장된 Undo state와 동일한 UTF-8 해시 및 unmerged 판정이다. */
export interface IndexStateFingerprint { index: string; unmerged: boolean }
type Runner = (args: string[], root: string, create: () => GitStreamReader<IndexStateFingerprint>, options?: RunGitOptions) => Promise<IndexStateFingerprint>;
const HEADER_LIMIT = 80;
const VALID_HEADER = /^[0-7]{6} (?:[a-f0-9]{40}|[a-f0-9]{64}) [0-3]$/;

/**
 * mode/OID/stage 헤더만 잠시 보관하고 파일명은 NUL까지 건너뛰는 제한된 파서다.
 * UTF-8 decoder는 기존 Buffer.toString의 대체 문자와 chunk 사이 다중 바이트 문자까지 보존한다.
 */
class IndexFingerprintReader {
  private readonly hash = createHash("sha256");
  private readonly decoder = new StringDecoder("utf8");
  private header = "";
  private readingPath = false;
  private pathHasContent = false;
  private unmerged = false;

  /** @param chunk Native stdout 조각. 해시는 기존 UTF-8 텍스트 기준이며 원본 Buffer를 보관하지 않는다. */
  write(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    this.hash.update(text); this.consume(text);
  }

  /** 이미 해시에 사용한 같은 UTF-8 조각에서 헤더만 검사해 별도의 Buffer→문자열 변환을 피한다. */
  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      if (this.readingPath) {
        const end = text.indexOf("\0", offset);
        this.pathHasContent ||= (end < 0 ? text.length : end) > offset;
        if (end < 0) return;
        if (!this.pathHasContent) throw invalidIndexOutput();
        this.readingPath = false; this.pathHasContent = false; offset = end + 1;
      } else {
        const tab = text.indexOf("\t", offset), nul = text.indexOf("\0", offset), end = tab < 0 ? text.length : tab;
        if ((nul >= 0 && nul < end) || this.header.length + end - offset > HEADER_LIMIT) throw invalidIndexOutput();
        this.header += text.slice(offset, end);
        if (tab < 0) return;
        if (!VALID_HEADER.test(this.header)) throw invalidIndexOutput();
        this.unmerged ||= this.header.charCodeAt(this.header.length - 1) !== 48;
        this.header = ""; this.readingPath = true; offset = tab + 1;
      }
    }
  }

  /** Native 성공/close 뒤에만 완성된 해시를 반환하며 부분 레코드는 유효 snapshot으로 저장하지 않는다. */
  finish(): IndexStateFingerprint {
    const tail = this.decoder.end(); this.hash.update(tail); this.consume(tail);
    if (this.header || this.readingPath) throw invalidIndexOutput();
    return { index: this.hash.digest("hex"), unmerged: this.unmerged };
  }
}

/**
 * 매 호출 현재 index의 stage 목록을 새로 읽고 원래 Undo fingerprint 계약으로 요약한다.
 * @param root 실제 저장소/linked worktree @param runner 테스트의 chunk/실패 경계 또는 공통 소유 실행기
 * @param options 기존 실행 취소·시간 제한·안전한 읽기 재시도 정책. 실패 시 decoder/hash 상태도 새로 만든다.
 * @returns 전체 Native 성공 뒤의 해시와 stage 1/2/3 존재 여부. 조회/파싱 실패는 그대로 전파한다.
 */
export function readIndexStateFingerprint(root: string, runner: Runner = runGitStreamResult,
  options?: RunGitOptions): Promise<IndexStateFingerprint> {
  return runner(["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"], root, () => {
    const reader = new IndexFingerprintReader();
    return { onData: chunk => reader.write(chunk), finish: () => reader.finish() };
  }, options);
}

/** 잘린 출력이나 예상하지 않은 헤더로 복구 검증을 우회하지 않게 한다. */
function invalidIndexOutput(): Error { return new Error("Cannot verify the Git index: incomplete or invalid stage output."); }
