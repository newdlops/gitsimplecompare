// 자동 squash/recovery가 이미 준비한 index를 같은 hook·서명 정책으로 commit한다.
import { runGit, withGitConfigOverrides } from "./gitExec";
import { logInfo } from "../ui/outputLog";

/** 호출자가 준비한 제목·본문과 임시 worktree의 checkout 여부다. */
export interface PreparedIndexCommitOptions {
  title: string;
  body: string;
  checkout?: boolean;
  allowEmpty?: boolean;
}

/**
 * 쓰지 않는 성공 diffstat/rename 요약을 계산하지 않고 원래 Native commit을 실행한다.
 * - --quiet는 summary 때문에 삭제된 promisor blob을 내려받는 것도 막는다. hook·서명·오류는 유지한다.
 * - checkout=false인 소유 임시 worktree는 파일이 없어 preload가 반복된다. 병렬 preload만 끄며
 *   Git의 최종 refresh/lstat와 호출자의 결과 tree·branch/index 안전 검증은 그대로 유지한다.
 * @param repoRoot caller가 준비한 index를 소유한 저장소 또는 임시 worktree
 * @param options 원래 commit 메시지, checkout 유무와 충돌 복구용 빈 commit 허용 여부
 * @returns 실제 Native commit이 완료하면 resolve하고 hook/서명/파일 오류는 그대로 전파한다.
 */
export async function commitPreparedIndex(repoRoot: string, options: PreparedIndexCommitOptions): Promise<void> {
  const checkout = options.checkout !== false, baseEnv = { GIT_EDITOR: "true", HUSKY: "0" };
  const started = Date.now();
  await runGit(["commit", "--quiet", "--no-verify", ...(options.allowEmpty ? ["--allow-empty"] : []),
    "-m", options.title, "-m", options.body], repoRoot,
  { env: checkout ? baseEnv : withGitConfigOverrides(baseEnv, { "core.preloadIndex": "false" }) });
  logInfo("prepared index commit completed", { repoRoot, checkout, allowEmpty: !!options.allowEmpty, elapsedMs: Date.now() - started });
}
