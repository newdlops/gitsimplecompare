// 같은 조회의 Git 설정을 NUL 경계로 파싱해 반복 config 실행 없이 재사용한다.
import { GitError, runGit, type RunGitOptions } from "./gitExec";

/** Git이 출력한 순서와 원문을 보존하는 한 번의 설정 조회 결과다. 호출 사이에는 캐시하지 않는다. */
export class GitConfigSnapshot {
  private readonly values = new Map<string, string[]>();

  /**
   * config --null --get-regexp의 첫 줄바꿈만 key/value 경계로 소비한다.
   * @param raw NUL 구분 설정 원문. 값 안의 줄바꿈·공백·중복 키는 보존한다.
   */
  constructor(readonly raw: string) {
    for (const record of raw.split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\n");
      const key = normalizedKey(separator < 0 ? record : record.slice(0, separator));
      const value = separator < 0 ? "" : record.slice(separator + 1);
      const values = this.values.get(key) ?? [];
      values.push(value);
      this.values.set(key, values);
    }
  }

  /** @param key 설정 이름 @returns Git config --get처럼 마지막 값. 없는 키는 undefined */
  get(key: string): string | undefined { return this.values.get(normalizedKey(key))?.at(-1); }

  /** @param key 설정 이름 @returns 원래 순서를 보존한 모든 값의 복사본 */
  getAll(key: string): string[] { return [...(this.values.get(normalizedKey(key)) ?? [])]; }

  /** @returns subsection 대소문자를 보존한 정규화된 설정 키의 새 배열. 내부 맵은 노출하지 않는다. */
  keys(): string[] { return [...this.values.keys()]; }
}

/**
 * subsection 이름의 대소문자는 유지하고 section/변수 이름만 Git의 비교 규칙에 맞춘다.
 * @param key section[.subsection].variable 이름 @returns 조회용 키
 */
function normalizedKey(key: string): string {
  const first = key.indexOf("."), last = key.lastIndexOf(".");
  return first < 0 ? key.toLowerCase()
    : key.slice(0, first).toLowerCase() + key.slice(first, last) + key.slice(last).toLowerCase();
}

/**
 * 같은 시점의 유효 설정을 한 Git 실행으로 읽고 값 없음과 실제 실행 오류를 구분한다.
 * @param root 저장소 루트 @param pattern Git 설정 키 정규식 @param options 취소 등 실행 옵션
 * @param runner 공통 Git 실행기 또는 테스트 대역 @returns 값과 원문을 함께 보존한 새 snapshot
 */
export async function readGitConfigSnapshot(
  root: string, pattern: string, options: RunGitOptions = {}, runner = runGit
): Promise<GitConfigSnapshot> {
  const raw = await runner(["config", "--null", "--get-regexp", pattern], root, options)
    .catch(error => { if (error instanceof GitError && error.code === 1) return ""; throw error; });
  return new GitConfigSnapshot(raw);
}
