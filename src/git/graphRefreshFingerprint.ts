// Graph 새로고침이 실제 Git 상태 변경인지 판별하는 순수/조회 helper 모듈.
// - watcher의 같은 delete 관측을 시간 창 없이 의미적으로 합쳐 불필요한 graph 재로드를 막는다.
import { runGit } from "./gitExec";

/** Git graph에 영향을 주는 상태를 순서와 무관하게 표현한 짧은 식별자다. */
export type GraphRefreshFingerprint = string;

/** 문자열 항목을 정렬·중복 제거해 안정적인 fingerprint 입력으로 바꾼다. */
function normalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/** HEAD, ref, tag, worktree 출력에서 순서 독립적인 Graph fingerprint를 만든다. */
export function createGraphRefreshFingerprint(parts: { head: string; symbolicHead: string; refs: string[]; worktrees: string[] }): GraphRefreshFingerprint {
  return [parts.head.trim(), parts.symbolicHead.trim(), ...normalized(parts.refs), "--worktrees--", ...normalized(parts.worktrees)].join("\n");
}

/** 현재 저장소의 Graph 의미 상태를 한 번 읽어 fingerprint로 반환한다. */
export async function readGraphRefreshFingerprint(repoRoot: string): Promise<GraphRefreshFingerprint> {
  const [head, symbolicHead, refs, worktrees] = await Promise.all([
    runGit(["rev-parse", "HEAD"], repoRoot),
    runGit(["symbolic-ref", "-q", "HEAD"], repoRoot).catch(() => "DETACHED"),
    runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"], repoRoot),
    runGit(["worktree", "list", "--porcelain"], repoRoot),
  ]);
  return createGraphRefreshFingerprint({ head, symbolicHead, refs: refs.split("\n"), worktrees: worktrees.split("\n\n") });
}
