// 커밋 상세 drawer 를 빠르게 열기 위한 header-only 조회 모듈.
// - 변경 파일/브랜치 계산은 느릴 수 있으므로, UI 첫 반응에는 git show -s 결과만 사용한다.
import { CommitDetail } from "../graph/graphTypes";
import { runGit } from "./gitExec";
import { LOG_FIELD_SEPARATOR } from "./gitLogParse";

const FS = LOG_FIELD_SEPARATOR;

/**
 * 커밋 메시지/작성자/부모만 포함한 임시 CommitDetail 을 만든다.
 * - files/branches 는 이후 전체 detail 이 도착하면 교체된다.
 * @param repoRoot git 명령을 실행할 저장소 루트
 * @param hash 조회할 커밋 해시
 * @returns loading=true 가 붙은 요약 상세
 */
export async function getCommitDetailSummary(
  repoRoot: string,
  hash: string
): Promise<CommitDetail> {
  const headerFormat = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join(FS);
  const header = await runGit(
    ["show", "-s", `--pretty=format:${headerFormat}`, hash],
    repoRoot
  );
  const parts = header.split(FS);
  const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : [];
  return {
    hash: parts[0] || hash,
    parents,
    authorName: parts[2] ?? "",
    authorEmail: parts[3] ?? "",
    authorDateIso: parts[4] ?? "",
    message: parts.slice(5).join(FS).trimEnd(),
    branches: [],
    files: [],
    loading: true,
  };
}
