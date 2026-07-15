// 충돌 편집기의 작업트리와 unmerged index snapshot 식별자를 만드는 순수 유틸리티다.
// - Git 접근이나 파일 IO 없이 전달받은 mode/OID/바이트만 직렬화해 서비스와 테스트에서 재사용한다.
import { createHash } from "node:crypto";

/** source fingerprint 계산에 필요한 index 항목의 최소 구조다. */
export interface ConflictIndexIdentity {
  mode: string;
  oid: string;
}

/**
 * 작업트리 kind, lstat mode와 전체 바이트를 해시해 외부 내용/실행 권한 변경을 함께 감지한다.
 * @param kind 파일, 심볼릭 링크처럼 읽은 작업트리 객체의 종류
 * @param mode lstat가 반환한 파일 종류와 권한 비트
 * @param buffer 화면에 표시하기 전의 전체 원본 바이트
 * @returns 패널 CAS 비교에 쓰는 opaque 작업트리 version
 */
export function hashWorkingResult(kind: string, mode: number, buffer: Buffer): string {
  const hash = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(mode.toString(8))
    .update("\0")
    .update(buffer)
    .digest("hex");
  return `worktree:${kind}:${hash}`;
}

/**
 * stage 존재 여부, mode, OID를 고정 순서로 직렬화해 화면 source snapshot을 식별한다.
 * @param entries `git ls-files --unmerged`에서 읽은 stage 1/2/3 항목
 * @returns 어느 stage 하나라도 바뀌면 달라지는 opaque source version
 */
export function unmergedSourceVersion(
  entries: ReadonlyMap<1 | 2 | 3, ConflictIndexIdentity>
): string {
  const stages = ([1, 2, 3] as const).map((stage) => {
    const entry = entries.get(stage);
    return entry ? `${stage}:${entry.mode}:${entry.oid}` : `${stage}:absent`;
  });
  return `unmerged:${stages.join("|")}`;
}

/**
 * 일반 파일의 lstat mode를 Git index가 추적하는 실행 가능/일반 blob mode로 정규화한다.
 * @param mode 작업트리 lstat mode. 새 파일처럼 없으면 일반 비실행 파일로 처리한다.
 * @returns update-index --cacheinfo에 전달할 100644 또는 100755
 */
export function gitRegularFileMode(mode: number | undefined): "100644" | "100755" {
  return mode !== undefined && (mode & 0o100) !== 0 ? "100755" : "100644";
}
