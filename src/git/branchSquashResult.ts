// Native squash commit의 직접 부모를 확인해 외부 후속 commit을 작업 결과로 소유하지 않는다.
import { runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * 현재 결과 OID와 부모를 한 Native 조회로 읽고, 시작 OID 바로 위의 단일 commit만 반환한다.
 * - 단순 조상 검사는 그 뒤에 생긴 외부 commit/merge까지 허용하므로 squash 결과 판정에 쓰지 않는다.
 * - isolated 경로는 이 증명으로 별도 merge-base 조회를 생략한다. 원본 ref 변경 직전 검사는 유지한다.
 * @param repoRoot commit을 만든 현재 작업트리 또는 소유한 임시 worktree
 * @param beforeHead squash 시작 시 고정한 전체 commit OID
 * @returns 직접 부모가 beforeHead인 전체 결과 OID. 누락/손상된 출력과 Git 실패는 전파한다.
 */
export async function readBranchSquashResult(repoRoot: string, beforeHead: string): Promise<string> {
  if (!OID.test(beforeHead)) throw new Error("A fixed starting commit is required to verify the branch squash result.");
  const raw = await runGit([
    "-c", "log.showSignature=false", "log", "-1", "--no-decorate", "--format=%H%x00%P", "HEAD", "--",
  ], repoRoot);
  const [head, parent, extra] = raw.trimEnd().split("\0");
  if (extra !== undefined || !OID.test(head || "") || head.length !== beforeHead.length || parent !== beforeHead || head === beforeHead) {
    logInfo("branch squash result rejected", { repoRoot, beforeHead, resultHead: head, parents: parent });
    throw new Error("Cannot verify the branch squash result: expected one commit directly based on " +
      `${beforeHead.slice(0, 10)}. The current files and recovery state were preserved.`);
  }
  return head;
}
