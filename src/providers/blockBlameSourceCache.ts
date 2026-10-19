// 언어 심볼은 문서 내용에 묶고 Git HEAD/index 캐시와 분리해 저장소 새로고침의 중복 언어 요청을 줄인다.
import type * as vscode from "vscode";
import type { SourceBlock } from "../git/blockBlameModel";
import { readSourceBlocks } from "./blockBlameCodeLensPresentation";

interface SourceEntry {
  version: number;
  language: string;
  expiresAt: number;
  promise: Promise<SourceBlock[]>;
}

/** 활성 파일 중심으로 최대 64개 문서의 심볼 결과와 진행 중 요청을 공유한다. */
export class BlockBlameSourceCache {
  private readonly entries = new Map<string, SourceEntry>();

  /**
   * URI/문서 버전/언어가 같은 심볼만 재사용한다. 소비자 취소는 다른 소비자의 언어 요청을 중단하지 않는다.
   * @param document 심볼 범위를 읽을 저장 문서, signal 이 소비자의 대기 취소 신호
   * @returns 선언 순서의 블록 목록. 빈 결과는 초기 언어 서버 재시도를 위해 완료 후 보관하지 않는다.
   */
  read(document: vscode.TextDocument, signal?: AbortSignal): Promise<SourceBlock[]> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = document.uri.toString();
    let entry = this.entries.get(key);
    if (!entry || entry.version !== document.version || entry.language !== document.languageId || entry.expiresAt <= Date.now()) {
      entry = { version: document.version, language: document.languageId, expiresAt: Date.now() + 60_000, promise: undefined! };
      const current = entry;
      entry.promise = readSourceBlocks(document).then(blocks => {
        current.expiresAt = Date.now() + (blocks.length ? 60_000 : 0);
        return blocks;
      }, error => { if (this.entries.get(key) === current) this.entries.delete(key); throw error; });
      this.entries.delete(key); this.entries.set(key, entry);
      while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    }
    return waitForSource(entry.promise, signal);
  }

  /** 편집·언어 변경·닫기 때 문서 결과를 버리며 이전 API 완료 값이 새 세대에 들어가지 않게 한다. */
  invalidate(key: string): void { this.entries.delete(key); }

  /** 확장 종료 때 보관한 문서별 심볼 참조를 모두 해제한다. */
  clear(): void { this.entries.clear(); }
}

/** 언어 API는 취소할 수 없어 공유 promise를 유지하고 이 소비자의 대기 리스너만 해제한다. */
function waitForSource<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
