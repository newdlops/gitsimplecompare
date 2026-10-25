import { createHash } from "node:crypto";

/**
 * JSON으로 전달되는 snapshot을 객체 필드의 삽입 순서와 무관하게 비교하는 해시를 만든다.
 * @param value JSON 호환 데이터. 브랜치/커밋 배열 순서와 필드 값·타입은 그대로 보존한다.
 * @returns 원문을 노출하지 않는 SHA-256. Native 일치 판정 자체는 별도의 엄격 동등 비교로 수행한다.
 */
export function snapshotDigest(value: unknown): string {
  const json = JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return createHash("sha256").update(json).digest("hex");
}
