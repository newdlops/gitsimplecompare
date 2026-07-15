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
  guidance?: string[];
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
      guidance: combinedGuidance(input.guidance, progress ? guidanceLines(input.phase) : undefined),
      active: input.active,
    },
  };
}

/**
 * rebase 진행 상태를 해석할 때 필요한 짧은 안내를 만든다.
 * @param phase 현재 진행 카드 단계
 */
function guidanceLines(phase: GraphRebaseProgress["phase"]): string[] {
  if (phase === "conflicts") {
    return [
      "Applied rows are already replayed in the new history.",
      "Current / Ours is the new base plus commits already replayed.",
      "Incoming / Theirs is stage 3 from the replayed commit or an active nested rebase operation.",
      "Result resolves this step; pending rows may still change the file.",
    ];
  }
  if (phase === "paused") {
    return [
      "Applied rows are already replayed.",
      "Current is the paused todo item.",
      "Pending rows will replay after Continue.",
    ];
  }
  return [];
}

/**
 * 진단 안내와 기본 todo 안내를 중복 없이 합친다.
 * @param first  진단에서 온 구체 안내
 * @param second 상태별 기본 안내
 */
function combinedGuidance(
  first: string[] | undefined,
  second: string[] | undefined
): string[] | undefined {
  const lines = [...(first || []), ...(second || [])];
  return lines.length ? [...new Set(lines)] : undefined;
}
