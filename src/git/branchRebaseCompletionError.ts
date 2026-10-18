// 성공한 native rebase의 후속 기록/복원 오류가 시작 실패 복구로 들어가지 않게 구분한다.

/** 후속 처리 실패 시 보존된 결과와 실제 남아 있는 복구 자료만 안내하는 입력이다. */
export interface BranchRebaseCompletionContext {
  branch: string;
  snapshotRef: string;
  afterHead?: string;
  preservedStashHash?: string;
}

/** rebase 성공 후 오류는 원래 HEAD로 되돌리는 시작 실패 복구의 대상이 아니다. */
export class BranchRebaseCompletionError extends Error {
  readonly undoBranch: string;

  /**
   * 원래 후속 오류와 보존 상태를 함께 전달하며 이미 복원/삭제한 stash는 안내하지 않는다.
   * @param cause native rebase가 성공한 뒤 발생한 기록·검증·stash 복원 오류
   * @param context 결과 브랜치, 선택적 완료 HEAD와 아직 보존 중인 stash/snapshot
   */
  constructor(cause: unknown, context: BranchRebaseCompletionContext) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Rebase command completed, but follow-up processing failed: ${reason}` +
      `\nThe branch result was kept${context.afterHead ? ` at ${context.afterHead}` : ""}.` +
      (context.preservedStashHash ? `\nLocal changes were preserved in stash ${context.preservedStashHash}.` : "") +
      `\nThe recovery snapshot was kept at ${context.snapshotRef}.`, { cause });
    this.name = "BranchRebaseCompletionError";
    this.undoBranch = context.branch;
  }
}
