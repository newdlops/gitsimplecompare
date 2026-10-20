// Start의 worktree 검증과 native 작업 판별을 같은 짧은 scope에서 읽고 확인 대화상자 너머로 데이터를 재사용하지 않는다.
import { detectOperation, type MergeOperation } from "./conflictService";
import { withGitStatePathScope } from "./gitStatePathScope";
import { captureRebaseCheckout, assertRebaseCheckoutMatches, type RebaseCheckoutIdentity } from "./rebasePlanSafety";
import { logInfo } from "../ui/outputLog";

/** 새 실행이 가능한 snapshot과 기존 native 작업을 채택할 경우를 타입으로 구분한다. */
export type RebaseStartContext = { operation: "none"; checkout: RebaseCheckoutIdentity }
  | { operation: Exclude<MergeOperation, "none"> };

/**
 * 첫 최신 checkout 조회가 검증한 Git directory를 같은 읽기 범위의 작업 판별에도 사용한다.
 * - 기존 rebase는 HEAD가 detached일 수 있으므로 checkout 오류보다 active 작업 판별을 우선한다.
 * - UI의 확인 전 호출은 여기서 scope가 끝난다. 실제 쓰기는 Start가 이후 다시 최신 checkout을 검증한다.
 * @param repoRoot 실제 작업트리 @param expected UI/이전 준비 단계가 고정한 선택적 계획 기준
 * @returns native 작업이 있으면 종류만, 없으면 검증한 checkout. 조회 오류/계획 변경은 쓰기 전에 전파한다.
 */
export function readRebaseStartContext(repoRoot: string, expected?: RebaseCheckoutIdentity): Promise<RebaseStartContext> {
  return withGitStatePathScope(repoRoot, async () => {
    const initial = await captureRebaseCheckout(repoRoot).then(
      checkout => ({ ok: true as const, checkout }), (error: unknown) => ({ ok: false as const, error })
    );
    const operation = await detectOperation(repoRoot);
    if (operation !== "none") {
      logInfo("rebase start observed active operation", { repoRoot, operation });
      return { operation };
    }
    if (!initial.ok) throw initial.error;
    const checkout = expected ?? initial.checkout;
    assertRebaseCheckoutMatches(initial.checkout, checkout);
    logInfo("rebase initial checkout verified", { repoRoot });
    return { operation: "none", checkout };
  });
}
