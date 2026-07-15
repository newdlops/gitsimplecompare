// Git blob/작업트리 바이트가 UI에서 손실 없이 표시 가능한 UTF-8 text인지 판별한다.

/** NUL과 잘못된 UTF-8을 binary로 분류하면서 유효 text만 원문으로 반환한다. */
export function decodeUtf8(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}
