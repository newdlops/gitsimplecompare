// 작업 변경을 hunk(diff 조각) 단위로 골라 여러 커밋으로 나누는 서비스 모듈.
// - `git diff`(unstaged) 를 파일/hunk 로 파싱하고, 선택한 hunk 만 패치로 만들어
//   `git apply --cached` 로 인덱스에 올린 뒤 커밋한다(부분 스테이징).
// - 깨끗한 인덱스를 전제로 해, 커밋에는 "선택한 hunk"만 정확히 담기게 한다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "./gitExec";

/** diff 한 조각(hunk). text 는 `@@ ... @@` 머리행 + 본문을 줄바꿈으로 이은 원문. */
export interface DiffHunk {
  id: string;
  text: string;
}

/** 변경 파일 한 건(헤더 + hunk 들). binary 파일은 hunk 가 없다. */
export interface DiffFile {
  path: string;
  header: string;
  hunks: DiffHunk[];
  binary: boolean;
}

/** 커밋에 포함할 선택 정보(파일별 선택된 hunk id 들, binary 통째 여부) */
export interface HunkSelection {
  path: string;
  hunkIds: string[];
  binary: boolean;
}

/**
 * 작업 변경의 hunk 단위 분할 커밋을 담당하는 서비스(저장소 루트 1개에 대응).
 */
export class DiffHunkService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 인덱스(스테이지)에 이미 올라간 변경이 있는지 확인한다.
   * - 분할 커밋은 "선택 hunk 만" 담기 위해 인덱스가 비어 있어야 정확하다.
   */
  async hasStagedChanges(): Promise<boolean> {
    const out = await runGit(
      ["diff", "--cached", "--name-only"],
      this.repoRoot
    );
    return out.trim().length > 0;
  }

  /**
   * 작업트리의 unstaged 변경을 파일/hunk 로 파싱해 반환한다.
   * - 추적되지 않은(신규) 파일은 `git diff` 에 나오지 않으므로 포함되지 않는다.
   */
  async getWorkingDiff(): Promise<DiffFile[]> {
    const raw = await runGit(["diff", "--no-color"], this.repoRoot);
    return parseDiff(raw);
  }

  /**
   * 선택한 hunk(및 binary 파일)만 스테이징한 뒤 하나의 커밋으로 만든다.
   * @param files      현재 파싱된 전체 변경 파일(선택 id 매칭용)
   * @param selections 사용자가 고른 선택 정보
   * @param message    커밋 메시지
   */
  async commit(
    files: DiffFile[],
    selections: HunkSelection[],
    message: string
  ): Promise<void> {
    const patchParts: string[] = [];
    const binaryPaths: string[] = [];

    for (const sel of selections) {
      const file = files.find((f) => f.path === sel.path);
      if (!file) {
        continue;
      }
      if (sel.binary) {
        binaryPaths.push(sel.path);
        continue;
      }
      const chosen = file.hunks.filter((h) => sel.hunkIds.includes(h.id));
      if (chosen.length === 0) {
        continue;
      }
      patchParts.push(file.header + "\n" + chosen.map((h) => h.text).join("\n"));
    }

    // 1) 텍스트 hunk 들을 패치로 만들어 인덱스에 적용한다.
    if (patchParts.length > 0) {
      const patchFile = tempPatchPath();
      fs.writeFileSync(patchFile, patchParts.join("\n") + "\n", "utf8");
      try {
        await runGit(["apply", "--cached", patchFile], this.repoRoot);
      } finally {
        safeUnlink(patchFile);
      }
    }
    // 2) binary 파일은 통째로 스테이징한다.
    for (const p of binaryPaths) {
      await runGit(["add", "--", p], this.repoRoot);
    }
    // 3) 인덱스에 올린 내용을 커밋한다.
    await runGit(["commit", "-m", message], this.repoRoot);
  }
}

/**
 * `git diff` 원문을 DiffFile 배열로 파싱한다.
 * - `diff --git` 으로 파일을 구분하고, `@@` 로 hunk 를 나눈다.
 * @param raw git diff 원문
 */
function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let headerLines: string[] = [];
  let hunkLines: string[] | undefined;
  let hunkIndex = 0;

  const flushHunk = (): void => {
    if (current && hunkLines) {
      current.hunks.push({
        id: `${current.path}#${hunkIndex++}`,
        text: hunkLines.join("\n"),
      });
      hunkLines = undefined;
    }
  };
  const flushFile = (): void => {
    flushHunk();
    if (current) {
      current.header = headerLines.join("\n");
      files.push(current);
    }
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const filePath = match ? match[2] : line.slice("diff --git ".length);
      current = { path: filePath, header: "", hunks: [], binary: false };
      headerLines = [line];
      hunkLines = undefined;
      hunkIndex = 0;
    } else if (current && line.startsWith("@@")) {
      flushHunk();
      hunkLines = [line];
    } else if (hunkLines) {
      hunkLines.push(line);
    } else if (current) {
      headerLines.push(line);
      if (line.startsWith("Binary files")) {
        current.binary = true;
      }
    }
  }
  flushFile();
  return files;
}

/** 임시 패치 파일 경로를 만든다(난수 접미사). */
function tempPatchPath(): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-split-${suffix}.patch`);
}

/** 파일을 조용히 삭제한다(없어도 무시). */
function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 무시 */
  }
}
