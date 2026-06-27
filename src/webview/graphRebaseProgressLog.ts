// rebase todo 진행률을 OUTPUT 로그용 객체로 변환하는 보조 모듈.
// - graphRebaseActions.ts 가 실행 흐름에 집중하도록 로그 상세 조립을 분리한다.
import {
  formatRebaseTodoProgress,
  readRebaseTodoProgress,
} from "../git/rebaseTodoProgress";

/**
 * rebase continue 전후의 done/todo 진행률을 OUTPUT 로그용 객체로 만든다.
 * @param repoRoot 저장소 루트
 */
export async function rebaseProgressLogDetail(
  repoRoot: string
): Promise<Record<string, unknown>> {
  const progress = await readRebaseTodoProgress(repoRoot).catch(() => undefined);
  if (!progress) {
    return { todoActive: false };
  }
  return {
    todoActive: true,
    todoDone: progress.done,
    todoRemaining: progress.remaining,
    todoTotal: progress.total,
    todoCurrent: progress.currentHash,
    todoCurrentAction: progress.items.find((item) => item.role === "current")?.action,
    todoCurrentSubject: progress.currentSubject,
    todoNext: progress.nextHash,
    todoNextAction: progress.items.find((item) => item.role === "remaining")?.action,
    todoNextSubject: progress.nextSubject,
    todoSummary: formatRebaseTodoProgress(progress),
  };
}
