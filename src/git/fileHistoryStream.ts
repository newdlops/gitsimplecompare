// 같은 native git log의 완결된 앞부분만 먼저 전달한다. 부분 출력은 저장 캐시로 쓰지 않는다.
import { StringDecoder } from "node:string_decoder";
import type { FileHistoryEntry } from "./fileHistoryService";

/** UTF-8/NUL 경계를 보존하며 한 번만 빠른 표시 snapshot을 만드는 스트림 파서다. */
export class FileHistoryStream {
  private readonly decoder = new StringDecoder("utf8");
  private raw = "";
  private bytes = 0;
  private published = false;

  /** 기존 완성 파서와 표시 observer를 주입해 rename·통계 파싱 규칙을 공유한다. */
  constructor(private readonly parse: (raw: string) => FileHistoryEntry[],
    private readonly onProgress: (entries: FileHistoryEntry[]) => void) {}

  /**
   * stdout을 이어 붙이고 다음 레코드가 시작된 커밋만 한 번 먼저 게시한다.
   * @param chunk UTF-8 문자나 NUL 토큰 중간에서도 끊길 수 있는 Git stdout
   * @throws 기존 runGit과 같은 128MiB 출력 상한 초과. 실행기는 실제 close까지 정리한다.
   */
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > 128 * 1024 * 1024) throw new RangeError("Git history stdout exceeded maxBuffer.");
    this.raw += this.decoder.write(chunk);
    // 큰 메시지는 반복 파싱을 피하고 완료 때 한 번만 읽어 메모리·CPU 증가를 막는다.
    if (this.published || this.bytes > 1024 * 1024) return;
    const entries = this.parse(this.raw).slice(0, -1);
    if (!entries.length) return;
    this.published = true;
    try { this.onProgress(entries); } catch { /* 표시 실패는 Git 최종 성공과 분리한다. */ }
  }

  /** 실제 process close 성공 뒤 마지막 레코드까지 포함한 원래 전체 이력을 반환한다. */
  finish(): FileHistoryEntry[] {
    this.raw += this.decoder.end();
    return this.parse(this.raw);
  }
}
