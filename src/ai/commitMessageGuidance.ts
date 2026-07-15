// AI가 만드는 모든 git 커밋 메시지에 공통으로 적용할 품질 규칙.
// - 단독 메시지와 커밋 플랜이 같은 원본 규칙을 사용해 subject/body 품질이 서로 달라지지 않게 한다.
// - VS Code나 CLI 설정에 의존하지 않는 순수 함수로 유지해 각 프롬프트 빌더에서 재사용한다.

/**
 * 단독 커밋과 플랜 내부 커밋 메시지가 공유할 프롬프트 규칙을 만든다.
 * - 첫 줄은 git log에서 빠르게 읽히도록 짧고 명령형으로 제한한다.
 * - 변경 이유나 비자명한 동작을 설명할 가치가 있을 때는 짧은 본문을 허용한다.
 * @param responseLanguage AI가 커밋 메시지를 작성할 언어. 공백이면 English로 보정한다.
 * @returns 프롬프트의 Rules 구획에 바로 펼칠 수 있는 bullet 문자열 배열
 */
export function commitMessageGuidelines(responseLanguage: string): string[] {
  const language = responseLanguage.trim() || "English";
  return [
    "- Prefer Conventional Commits when the intent is clear.",
    "- Use an imperative, concise first line under 72 characters.",
    "- Add a short body only when it clarifies non-obvious behavior.",
    `- Write commit messages in ${language}.`,
  ];
}
