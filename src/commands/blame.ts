// git blame 표시 관련 명령 핸들러.
// - 명령 레이어는 VS Code command id 와 컨트롤러를 연결만 하고, 상태/decoration 로직은 provider 에 위임한다.
import type { CommandDeps } from "./shared";

/**
 * 활성 에디터의 git blame decorator 를 켜거나 끈다.
 * @param deps 명령 공용 의존성
 */
export async function toggleBlameDecorator(deps: CommandDeps): Promise<void> {
  await deps.blameDecorations.toggleDecorator();
}

/**
 * 활성 에디터 왼쪽 라인 영역의 git blame 텍스트 표시를 켜거나 끈다.
 * @param deps 명령 공용 의존성
 */
export async function toggleBlameLineVisible(deps: CommandDeps): Promise<void> {
  await deps.blameDecorations.toggleLineVisible();
}
