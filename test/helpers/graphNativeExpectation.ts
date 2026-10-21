import assert from "node:assert/strict";
import { runGit } from "../../src/git/gitExec";
import { GitLogService } from "../../src/git/gitLogService";

/**
 * 패널 cache와 독립된 서비스에 현재 Native branch/tip을 공급해 최종 표시의 비교 기준을 만든다.
 * @param root 소유 임시 저장소 @param limit 패널이 실제로 로드한 commit 수
 * @returns 새 Git log와 완료한 local-only metadata. 실패한 marker 조회를 빈 정상 결과로 받아들이지 않는다.
 */
export async function readNativeGraphExpectation(root: string, limit: number) {
  const service = new GitLogService(root);
  const [local, output] = await Promise.all([
    service.getLocalBranchSnapshot(),
    runGit(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(symref)", "refs/remotes/"], root),
  ]);
  assert.deepEqual(local.invalidRefs, [], "The owned fixture must have no invalid local refs");
  const remote = output.trim().split("\n").filter(Boolean).flatMap(line => {
    const [name, hash, symbolic] = line.split("\0"); return symbolic ? [] : [{ name, hash }];
  });
  service.seedGraphBranchTips(local.branches, remote);
  const commits = await service.getCommitPage(limit, 0, [], true);
  assert.ok((service as any).localOnlyBranchCache.peek(), "Fresh marker verification must finish successfully");
  return commits;
}
