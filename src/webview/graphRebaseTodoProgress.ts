// 실제 git rebase 상태를 그래프 progress 카드 메시지로 변환한다.
// - 브랜치/PR rebase merge 처럼 Graph interactive rebase 가 아닌 작업도 같은 progress UI 를 재사용한다.
import type { RebaseTodoProgress } from "../git/rebaseTodoProgress";
import type { GraphRebaseProgress, ToWebviewMessage } from "./graphProtocol";

export interface RebaseTodoProgressMessageInput {
  action: GraphRebaseProgress["action"];
  phase: GraphRebaseProgress["phase"];
  title: string;
  detail: string;
  progress?: RebaseTodoProgress;
  active: boolean;
}

/**
 * rebase todo 진행률을 그래프 웹뷰 progress 메시지로 만든다.
 * @param input 카드 제목/상태와 git todo 진행률
 * @returns graphRebaseProgress 웹뷰 메시지
 */
export function graphRebaseTodoProgressMessage(
  input: RebaseTodoProgressMessageInput
): ToWebviewMessage {
  const progress = input.progress;
  return {
    type: "graphRebaseProgress",
    progress: {
      phase: input.phase,
      action: input.action,
      title: input.title,
      detail: input.detail,
      hash: progress?.currentHash,
      step: progress?.done,
      total: progress?.total,
      todos: progress?.items.map((item) => ({
        role: item.role,
        index: item.index,
        action: item.action,
        hash: item.hash,
        subject: item.subject,
      })),
      omittedTodoCount: progress?.omittedItemCount,
      active: input.active,
    },
  };
}
