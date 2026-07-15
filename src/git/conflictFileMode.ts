// 수동 충돌 Result를 stage 0으로 기록할 때 Git과 같은 regular-file mode를 선택한다.
// - core.filemode 정책과 unmerged source mode만 다루고, blob/content mutation은 호출 서비스에 맡긴다.
import { gitRegularFileMode, type ConflictIndexIdentity } from "./conflictContentIdentity";
import { runGit } from "./gitExec";

/** Git index에 기록할 수 있는 일반 blob mode다. */
export type ConflictRegularFileMode = "100644" | "100755";

/**
 * 작업트리 실행 비트를 신뢰하는 저장소인지 확인한 뒤 수동 Result의 Git mode를 계산한다.
 * - core.filemode=true이면 Git처럼 owner execute 비트만 사용한다.
 * - false이면 chmod 차이를 무시하고 Current, Incoming, Base 순서의 기존 regular stage mode를 보존한다.
 * @param repoRoot core.filemode를 조회할 저장소 루트
 * @param entries 표시 당시와 일치함을 검증한 unmerged stage 1/2/3
 * @param workingMode Result 일반 파일의 lstat mode
 * @returns update-index --cacheinfo에 전달할 100644 또는 100755
 */
export async function resolveConflictRegularFileMode(
  repoRoot: string,
  entries: ReadonlyMap<1 | 2 | 3, ConflictIndexIdentity>,
  workingMode: number | undefined
): Promise<ConflictRegularFileMode> {
  const configured = (await runGit(["config", "--bool", "core.filemode"], repoRoot)
    .catch(() => "true")).trim();
  if (configured !== "false") return gitRegularFileMode(workingMode);
  for (const stage of [2, 3, 1] as const) {
    const mode = entries.get(stage)?.mode;
    if (mode === "100644" || mode === "100755") return mode;
  }
  return "100644";
}
