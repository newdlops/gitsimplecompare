// 그래프 표시와 독립적으로 저장된 시작 계획과 실제 native rebase의 소유권을 확인한다.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { readRebaseSessionState } from "./rebaseSessionState";

/**
 * 시작 전 checkout과 native orig-head/head-name이 일치할 때만 새 세션을 연결한다.
 * @param repoRoot 그래프 계획을 실행한 작업트리
 * @returns rebase가 이미 끝났으면 undefined, 검증한 활성 작업이면 해당 식별자
 */
export async function bindStartedRebase(repoRoot: string): Promise<GitOperationIdentity | undefined> {
  const operation = await captureGitOperation(repoRoot);
  if (operation.operation !== "rebase") return undefined;
  const state = await readRebaseSessionState(repoRoot);
  const checkout = state?.plan.checkout;
  if (checkout?.gitDir === operation.gitDir) {
    for (const directory of ["rebase-merge", "rebase-apply"]) {
      try {
        const [head, branch] = await Promise.all([
          readFile(path.join(operation.gitDir, directory, "orig-head"), "utf8"),
          readFile(path.join(operation.gitDir, directory, "head-name"), "utf8"),
        ]);
        if (head.trim() === checkout.head && branch.trim() === checkout.branch) {
          await assertGitOperation(repoRoot, operation);
          return operation;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error("The native rebase does not match the saved graph plan. The previous plan was not attached to this operation.");
}
