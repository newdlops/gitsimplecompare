// 웹뷰 CSP nonce 생성 유틸.
// - 여러 웹뷰 패널이 같은 보안 규칙을 쓰므로 nonce 생성 로직을 한곳에서 공유한다.

/**
 * script/style 태그에 붙일 무작위 nonce 문자열을 만든다.
 * @returns 32자 영숫자 nonce
 */
export function nonceValue(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
