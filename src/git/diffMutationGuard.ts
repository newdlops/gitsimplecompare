// hunk 변경 작업이 오래된 diff 위에서 실행되지 않도록 보호하는 guard.
// - git lock 대기 뒤에는 현재 diff 와 충돌 상태를 다시 확인한 다음에만 변경 작업을 재시도한다.
import type { DiffFile, HunkSelection } from "./diffHunkService";
import { runGit } from "./gitExec";

export interface DiffFileProvider {
  repoRoot: string;
  getFileWorkingDiff(relPath: string): Promise<DiffFile[]>;
}

export interface DiffMutationGuard {
  assertSafe(): Promise<void>;
  beforeRetry(): Promise<void>;
}

/**
 * hunk 변경 적용 전/lock 재시도 전 현재 저장소 상태가 선택 당시와 같은지 확인하는 guard 를 만든다.
 * @param provider 현재 diff 를 다시 읽을 수 있는 서비스
 * @param files 사용자가 선택할 때 기준이 된 diff 파일 목록
 * @param selections 실제로 적용할 선택 목록
 */
export function createDiffMutationGuard(
  provider: DiffFileProvider,
  files: DiffFile[],
  selections: HunkSelection[]
): DiffMutationGuard {
  const expected = selectedFileMap(files, selections);
  const paths = [...new Set(selections.map((selection) => selection.path))];
  const assertSafe = async (): Promise<void> => {
    await assertNoConflicts(provider.repoRoot);
    const currentFiles = (
      await Promise.all(paths.map((path) => provider.getFileWorkingDiff(path)))
    ).flat();
    const current = new Map(
      currentFiles.map((file) => [fileKey(file.stage, file.path), fingerprint(file)])
    );
    for (const [key, value] of expected) {
      if (current.get(key) !== value) {
        throw new Error(
          "다른 Git 작업으로 변경 내용이 바뀌어 작업을 중단했습니다. 새로고침 후 다시 시도하세요."
        );
      }
    }
  };
  return { assertSafe, beforeRetry: assertSafe };
}

/** 선택 대상 파일만 fingerprint 로 저장한다. */
function selectedFileMap(
  files: DiffFile[],
  selections: HunkSelection[]
): Map<string, string> {
  const keys = new Set(
    selections.map((selection) => fileKey(selection.stage, selection.path))
  );
  const map = new Map<string, string>();
  for (const file of files) {
    const key = fileKey(file.stage, file.path);
    if (keys.has(key)) {
      map.set(key, fingerprint(file));
    }
  }
  return map;
}

/** 충돌 파일이 있으면 변경 작업을 시작하지 않도록 오류를 낸다. */
async function assertNoConflicts(repoRoot: string): Promise<void> {
  const out = await runGit(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    repoRoot
  );
  const conflicts = out.split("\0").filter((item) => item.length > 0);
  if (!conflicts.length) {
    return;
  }
  throw new Error(
    `충돌 상태인 파일이 있어 변경 작업을 중단했습니다: ${conflicts
      .slice(0, 5)
      .join(", ")}${conflicts.length > 5 ? " ..." : ""}`
  );
}

/** 같은 stage/path 의 파일을 찾기 위한 key 를 만든다. */
function fileKey(stage: string, path: string): string {
  return `${stage}\0${path}`;
}

/** hunk line id 가 안전하게 재사용 가능한지 비교하기 위한 파일 fingerprint 를 만든다. */
function fingerprint(file: DiffFile): string {
  return JSON.stringify({
    stage: file.stage,
    path: file.path,
    header: file.header,
    binary: file.binary,
    hunks: file.hunks.map((hunk) => [hunk.id, hunk.text]),
  });
}
