// Git porcelain과 patch가 내보내는 C-style 경로를 원래 UTF-8 파일명으로 복원한다.

/**
 * 따옴표 경로의 octal byte와 제어 문자 escape를 해석한다. 일반 경로는 그대로 보존한다.
 * @param value Git의 filename/patch 헤더 값 @returns 파일 시스템에서 사용한 실제 경로
 */
export function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  const source = value.slice(1, -1);
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\") {
      const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8)); index += octal[0].length + 1; continue; }
      const next = source[index + 1];
      bytes.push(...Buffer.from(escapes[next] ?? next ?? "\\")); index += next ? 2 : 1;
    } else {
      const character = String.fromCodePoint(source.codePointAt(index)!);
      bytes.push(...Buffer.from(character)); index += character.length;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
