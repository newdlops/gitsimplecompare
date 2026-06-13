// push 실패 원인 분류 유틸.
// - UI 레이어가 git stderr 문자열을 직접 해석하지 않도록 non-fast-forward 계열 오류만 여기서 판별한다.
import { GitError } from "./gitExec";

/**
 * push 가 non-fast-forward 로 거절되어 force push 가 필요할 수 있는 상황인지 확인한다.
 * - 이 확장은 force push UI 를 제공하지 않으므로, 호출부는 이 경우 별도 안내만 보여준다.
 * @param error git push 중 발생한 오류
 */
export function isForcePushRequiredError(error: unknown): boolean {
  const text = gitErrorText(error);
  return (
    /non-fast-forward/i.test(text) ||
    /fetch first/i.test(text) ||
    /tip of your current branch is behind/i.test(text) ||
    /Updates were rejected because/i.test(text)
  );
}

/**
 * GitError 또는 일반 Error 에서 사용자에게 보여줄 수 있는 원문 텍스트를 만든다.
 * @param error git 또는 런타임 오류
 */
export function gitErrorText(error: unknown): string {
  if (error instanceof GitError) {
    return [error.stderr, error.message].filter(Boolean).join("\n").trim();
  }
  return error instanceof Error ? error.message : String(error);
}
