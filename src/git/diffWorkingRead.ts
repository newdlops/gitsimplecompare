// 전체/단일/다중 파일의 staged·unstaged diff와 미추적 synthetic diff를 같은 규칙으로 읽는다.
// - 선택 파일은 argv 크기 안에서 묶어 읽으며 전체 조회와 파일 변경 작업은 호출부가 결정한다.
import * as fs from "node:fs";
import * as path from "node:path";
import { runGitLiteralPaths as runGit } from "./gitExec";
import { argvChunks } from "./pathspecExec";
import type { DiffFile, DiffStage } from "./diffHunkService";
import { mapWithConcurrency } from "../utils/mapWithConcurrency";

const MAX_SYNTHETIC_UNTRACKED_DIFF_BYTES = 5 * 1024 * 1024;

/**
 * 선택 범위의 최신 hunk를 읽되 파일 수에 비례한 Git 프로세스 실행을 피한다.
 * - 각 묶음은 staged/unstaged/미추적 세 조회만 실행하며 다음 묶음은 순서대로 처리한다.
 * - 겹치는 조회 범위는 stage/path별로 합치되 파일 종류 변경의 삭제·추가 diff는 모두 보존한다.
 * @param repoRoot 저장소 루트 @param paths undefined면 전체, 빈 목록이면 조회하지 않는다.
 * @param signal 더 이상 필요 없는 Git·파일 읽기를 중단할 소비자 신호
 * @returns 기존 Git header와 파일별 hunk ID를 보존한 최신 diff 목록. 완료 결과는 캐시하지 않는다.
 */
export async function readWorkingDiff(repoRoot: string, paths?: readonly string[], signal?: AbortSignal): Promise<DiffFile[]> {
  signal?.throwIfAborted();
  const batches = paths === undefined ? [undefined] : argvChunks([...new Set(paths)]);
  const files = new Map<string, DiffFile[]>();
  for (const batch of batches) {
    signal?.throwIfAborted();
    const scope = batch ? ["--", ...batch] : [];
    const [staged, unstaged, untracked] = await Promise.all([
      runGit(["diff", "--cached", "--no-color", ...scope], repoRoot, { signal }),
      runGit(["diff", "--no-color", ...scope], repoRoot, { signal }),
      runGit(["ls-files", "--others", "--exclude-standard", "-z", ...scope], repoRoot, { signal })
        .catch(() => { signal?.throwIfAborted(); return ""; }),
    ]);
    signal?.throwIfAborted();
    const unstagedFiles = parseDiff(unstaged, "unstaged");
    const untrackedFiles = await parseUntrackedFiles(repoRoot, untracked,
      new Set(unstagedFiles.map(file => file.path)), signal);
    const batchFiles = new Map<string, DiffFile[]>();
    for (const file of [...parseDiff(staged, "staged"), ...unstagedFiles, ...untrackedFiles]) {
      const key = `${file.stage}\0${file.path}`;
      const sections = batchFiles.get(key);
      if (sections) sections.push(file);
      else batchFiles.set(key, [file]);
    }
    // 파일 종류 변경은 같은 경로의 D/A 두 구간이 필요하므로 묶음 전체를 교체한다.
    for (const [key, sections] of batchFiles) files.set(key, sections);
  }
  return [...files.values()].flat();
}

/** `git diff` 원문을 기존 header·본문·파일별 hunk ID를 보존하는 DiffFile 배열로 파싱한다. */
function parseDiff(raw: string, stage: DiffStage): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let headerLines: string[] = [];
  let hunkLines: string[] | undefined;
  let hunkIndex = 0;

  /** 현재 hunk의 구분 개행만 제거하고 본문을 파일별 ID와 함께 보존한다. */
  const flushHunk = (): void => {
    if (current && hunkLines) {
      while (hunkLines[hunkLines.length - 1] === "") hunkLines.pop();
      current.hunks.push({ id: `${current.stage}:${current.path}#${hunkIndex++}`, text: hunkLines.join("\n") });
      hunkLines = undefined;
    }
  };
  /** 단일/다중 조회가 동일한 fingerprint를 만들도록 header 뒤 구분 개행을 정리한다. */
  const flushFile = (): void => {
    flushHunk();
    if (current) {
      while (headerLines[headerLines.length - 1] === "") headerLines.pop();
      current.header = headerLines.join("\n");
      files.push(current);
    }
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const filePath = match ? match[2] : line.slice("diff --git ".length);
      current = { stage, path: filePath, header: "", hunks: [], binary: false };
      headerLines = [line]; hunkLines = undefined; hunkIndex = 0;
    } else if (current && line.startsWith("@@")) {
      flushHunk(); hunkLines = [line];
    } else if (hunkLines) hunkLines.push(line);
    else if (current) {
      headerLines.push(line);
      if (line.startsWith("Binary files")) current.binary = true;
    }
  }
  flushFile();
  return files;
}

/** 미추적 파일의 순서를 유지하며 최대 4개 I/O로 new-file diff를 만든다. 취소 뒤 새 읽기는 시작하지 않는다. */
async function parseUntrackedFiles(repoRoot: string, raw: string, skipPaths: Set<string>, signal?: AbortSignal): Promise<DiffFile[]> {
  const paths = raw.split("\0").filter(item => item.length > 0 && !skipPaths.has(item));
  return mapWithConcurrency(paths, 4, relPath => untrackedFileToDiff(repoRoot, relPath, signal), signal);
}

/**
 * 미추적 파일을 `/dev/null → working file` synthetic diff로 읽는다.
 * - 5MiB 초과·binary·읽기 실패는 전체 파일 선택용 binary 항목으로 남겨 목록 누락을 피한다.
 * @param repoRoot 저장소 루트 @param relPath 상대 파일 경로 @param signal 파일 I/O 취소 신호
 * @returns 파일 mode·마지막 개행 여부를 보존한 새로운 DiffFile
 */
async function untrackedFileToDiff(repoRoot: string, relPath: string, signal?: AbortSignal): Promise<DiffFile> {
  signal?.throwIfAborted();
  const fullPath = path.join(repoRoot, relPath);
  const header = newFileHeader(relPath, await fileMode(fullPath));
  try {
    const stats = await fs.promises.stat(fullPath);
    signal?.throwIfAborted();
    if (stats.size > MAX_SYNTHETIC_UNTRACKED_DIFF_BYTES) return { stage: "unstaged", path: relPath, header, hunks: [], binary: true };
    const buffer = await fs.promises.readFile(fullPath, { signal });
    signal?.throwIfAborted();
    if (buffer.includes(0)) return { stage: "unstaged", path: relPath, header, hunks: [], binary: true };
    const hunk = newFileHunk(buffer.toString("utf8"));
    return { stage: "unstaged", path: relPath, header, hunks: hunk ? [{ id: `unstaged:${relPath}#0`, text: hunk }] : [], binary: false };
  } catch {
    signal?.throwIfAborted();
    return { stage: "unstaged", path: relPath, header, hunks: [], binary: true };
  }
}

/** @param relPath 상대 파일 경로 @param mode Git 파일 mode @returns 새 파일 apply에 필요한 diff header */
function newFileHeader(relPath: string, mode: string): string {
  return [`diff --git a/${relPath} b/${relPath}`, `new file mode ${mode}`, "index 0000000..0000000", "--- /dev/null", `+++ b/${relPath}`].join("\n");
}

/** @param fullPath 작업 파일 절대 경로 @returns 실행 비트가 있으면 100755, 없거나 읽기 실패면 기존 기본값 100644 */
async function fileMode(fullPath: string): Promise<string> {
  try { return (await fs.promises.stat(fullPath)).mode & 0o111 ? "100755" : "100644"; }
  catch { return "100644"; }
}

/** @param content 새 파일 UTF-8 본문 @returns 마지막 개행·줄 수를 보존한 추가 hunk, 빈 파일이면 undefined */
function newFileHunk(content: string): string | undefined {
  if (!content.length) return undefined;
  const finalNewline = content.endsWith("\n"), lines = content.split("\n");
  if (finalNewline) lines.pop();
  const body = lines.map(line => `+${line}`);
  if (!finalNewline) body.push("\\ No newline at end of file");
  const range = lines.length === 1 ? "1" : `1,${lines.length}`;
  return `@@ -0,0 +${range} @@\n${body.join("\n")}`;
}
