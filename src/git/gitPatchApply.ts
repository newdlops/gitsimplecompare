// git apply 기반 patch 적용 유틸.
// - DiffHunkService 는 hunk 선택/흐름 제어만 담당하고, 임시 patch 파일 처리는 여기서 맡는다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "./gitExec";

/**
 * patch 조각들을 index 또는 working tree 에 적용한다.
 * - 선택 라인으로 hunk 본문을 재구성하므로 `--recount` 로 header count 를 git 이 다시 검증하게 한다.
 * @param repoRoot 저장소 루트
 * @param parts 적용할 unified diff 조각들
 * @param reverse true 면 patch 를 반대로 적용한다
 * @param env 임시 index 등 git 환경 변수
 * @param cached true 면 index 에 적용하고 false 면 working tree 에 적용한다
 * @param beforeRetry git lock 대기 후 재시도 직전에 실행할 안전성 검사
 */
export async function applyPatch(
  repoRoot: string,
  parts: string[],
  reverse = false,
  env?: Record<string, string>,
  cached = true,
  beforeRetry?: () => Promise<void>
): Promise<void> {
  if (!parts.length) {
    return;
  }
  const patchFile = tempPatchPath();
  fs.writeFileSync(patchFile, parts.join("\n") + "\n", "utf8");
  try {
    await runGit(
      [
        "apply",
        "--recount",
        ...(cached ? ["--cached"] : []),
        ...(reverse ? ["--reverse"] : []),
        patchFile,
      ],
      repoRoot,
      { env, beforeRetry }
    );
  } finally {
    safeUnlink(patchFile);
  }
}

/** 임시 git index 파일 경로를 만든다. */
export function tempIndexPath(): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-split-index-${suffix}`);
}

/** 파일을 조용히 삭제한다(없어도 무시). */
export function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 무시 */
  }
}

/** 임시 패치 파일 경로를 만든다(난수 접미사). */
function tempPatchPath(): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-split-${suffix}.patch`);
}
