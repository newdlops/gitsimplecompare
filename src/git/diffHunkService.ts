// 작업 변경을 hunk(diff 조각) 단위로 골라 여러 커밋으로 나누는 서비스 모듈.
// - staged/unstaged diff 를 모두 파싱하고, 선택 hunk 만 커밋한다.
// - 선택하지 않은 staged hunk 는 커밋 뒤 다시 staged 상태로 복원한다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  filePatchForDiscard,
  filePatchForUnstage,
  filePatchFromSelection,
} from "./diffPatchBuild";
import { runGit } from "./gitExec";

/** hunk 가 어느 diff 영역에서 왔는지 나타낸다. */
export type DiffStage = "staged" | "unstaged";

/** diff 한 조각(hunk). text 는 `@@ ... @@` 머리행 + 본문을 줄바꿈으로 이은 원문. */
export interface DiffHunk {
  id: string;
  text: string;
}

/** 변경 파일 한 건(헤더 + hunk 들). binary 파일은 hunk 가 없다. */
export interface DiffFile {
  stage: DiffStage;
  path: string;
  header: string;
  hunks: DiffHunk[];
  binary: boolean;
}

/** 선택 정보(파일별 선택된 hunk/line id 들, binary 통째 여부) */
export interface HunkSelection {
  stage: DiffStage;
  path: string;
  hunkIds: string[];
  lineIds?: string[];
  binary: boolean;
}

/** 작업 변경의 hunk 단위 분할 커밋을 담당하는 서비스(저장소 루트 1개에 대응). */
export class DiffHunkService {
  constructor(public readonly repoRoot: string) {}

  /** staged/unstaged 변경을 파일/hunk 로 파싱해 반환한다. */
  async getWorkingDiff(): Promise<DiffFile[]> {
    const [staged, unstaged, untrackedOut] = await Promise.all([
      runGit(["diff", "--cached", "--no-color"], this.repoRoot),
      runGit(["diff", "--no-color"], this.repoRoot),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], this.repoRoot)
        .catch(() => ""),
    ]);
    const unstagedFiles = parseDiff(unstaged, "unstaged");
    const untrackedFiles = await parseUntrackedFiles(
      this.repoRoot,
      untrackedOut,
      new Set(unstagedFiles.map((file) => file.path))
    );
    return [
      ...parseDiff(staged, "staged"),
      ...unstagedFiles,
      ...untrackedFiles,
    ];
  }

  /**
   * 특정 파일의 staged/unstaged 변경만 파싱해 반환한다.
   * - editable diff checkbox 초기 렌더처럼 파일 하나만 필요한 경로에서 전체 diff 파싱을 피한다.
   * @param relPath 저장소 상대 파일 경로
   */
  async getFileWorkingDiff(relPath: string): Promise<DiffFile[]> {
    const [staged, unstaged, untrackedOut] = await Promise.all([
      runGit(["diff", "--cached", "--no-color", "--", relPath], this.repoRoot),
      runGit(["diff", "--no-color", "--", relPath], this.repoRoot),
      runGit(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", relPath],
        this.repoRoot
      ).catch(() => ""),
    ]);
    const unstagedFiles = parseDiff(unstaged, "unstaged");
    const untrackedFiles = await parseUntrackedFiles(
      this.repoRoot,
      untrackedOut,
      new Set(unstagedFiles.map((file) => file.path))
    );
    return [...parseDiff(staged, "staged"), ...unstagedFiles, ...untrackedFiles];
  }

  /**
   * 작업트리 파일 내용을 읽는다.
   * - HTML editable diff 웹뷰에서 오른쪽 작업 파일을 직접 편집할 때 사용한다.
   * @param relPath 저장소 상대 경로
   * @returns UTF-8 파일 내용
   */
  async readWorkingFile(relPath: string): Promise<string> {
    return fs.promises.readFile(path.join(this.repoRoot, relPath), "utf8");
  }

  /**
   * HEAD 의 파일 내용을 읽는다. 새 파일처럼 HEAD 에 없는 파일이면 빈 문자열을 반환한다.
   * @param relPath 저장소 상대 경로
   * @returns HEAD 기준 UTF-8 파일 내용
   */
  async readHeadFile(relPath: string): Promise<string> {
    try {
      return await runGit(["show", `HEAD:${relPath}`], this.repoRoot);
    } catch {
      return "";
    }
  }

  /**
   * 작업트리 파일 내용을 저장한다.
   * - 저장 뒤 diff 를 다시 계산하면 checkbox line id 도 현재 내용에 맞게 갱신된다.
   * @param relPath 저장소 상대 경로
   * @param content 저장할 UTF-8 내용
   */
  async writeWorkingFile(relPath: string, content: string): Promise<void> {
    await fs.promises.writeFile(path.join(this.repoRoot, relPath), content, "utf8");
  }

  /**
   * 선택한 unstaged hunk/line 만 index 에 올린다.
   * - 커밋은 수행하지 않는다. 사용자는 Changes 의 staged 영역에서 기존 커밋 흐름을 사용한다.
   * @param files      현재 파싱된 전체 변경 파일(선택 id 매칭용)
   * @param selections 사용자가 고른 선택 정보
   */
  async stageSelections(
    files: DiffFile[],
    selections: HunkSelection[]
  ): Promise<void> {
    const picked = new Map(
      selections.map((sel) => [selectionKey(sel.stage, sel.path), sel])
    );
    const patchParts: string[] = [];
    const binaryPaths: string[] = [];

    for (const file of files) {
      if (file.stage !== "unstaged") {
        continue;
      }
      const sel = picked.get(selectionKey(file.stage, file.path));
      if (file.binary) {
        if (sel?.binary) {
          binaryPaths.push(file.path);
        }
        continue;
      }
      const selectedPart = filePatchFromSelection(file, sel, false);
      if (selectedPart) {
        patchParts.push(selectedPart);
      }
    }

    if (patchParts.length === 0 && binaryPaths.length === 0) {
      throw new Error("No unstaged hunks selected.");
    }

    await applyPatch(this.repoRoot, patchParts);
    for (const filePath of binaryPaths) {
      await runGit(["add", "--", filePath], this.repoRoot);
    }
  }

  /**
   * 선택한 staged hunk/line 만 index 에서 내린다.
   * - working tree 내용은 그대로 두고, index 현재 내용에서 선택 변경만 제거하는 patch 를 적용한다.
   * @param files      현재 파싱된 전체 변경 파일(선택 id 매칭용)
   * @param selections 사용자가 고른 선택 정보
   */
  async unstageSelections(
    files: DiffFile[],
    selections: HunkSelection[]
  ): Promise<void> {
    const picked = new Map(
      selections.map((sel) => [selectionKey(sel.stage, sel.path), sel])
    );
    const patchParts: string[] = [];
    const binaryPaths: string[] = [];
    const resetPaths: string[] = [];

    for (const file of files) {
      if (file.stage !== "staged") {
        continue;
      }
      const sel = picked.get(selectionKey(file.stage, file.path));
      if (file.binary) {
        if (sel?.binary) {
          binaryPaths.push(file.path);
        }
        continue;
      }
      if (isNewFile(file) && selectionCoversAllChanges(file, sel)) {
        resetPaths.push(file.path);
        continue;
      }
      const selectedPart = filePatchForUnstage(file, sel);
      if (selectedPart) {
        patchParts.push(selectedPart);
      }
    }

    if (
      patchParts.length === 0 &&
      binaryPaths.length === 0 &&
      resetPaths.length === 0
    ) {
      throw new Error("No staged hunks selected.");
    }

    await applyPatch(this.repoRoot, patchParts);
    for (const filePath of resetPaths) {
      await runGit(["reset", "HEAD", "--", filePath], this.repoRoot);
    }
    for (const filePath of binaryPaths) {
      await runGit(["reset", "HEAD", "--", filePath], this.repoRoot);
    }
  }

  /**
   * 선택한 unstaged hunk/line 을 작업트리에서 되돌린다.
   * - index 는 건드리지 않고 working tree 변경만 reverse apply 한다.
   * @param files      현재 파싱된 전체 변경 파일(선택 id 매칭용)
   * @param selections 사용자가 고른 선택 정보
   */
  async discardSelections(
    files: DiffFile[],
    selections: HunkSelection[]
  ): Promise<void> {
    const picked = new Map(
      selections.map((sel) => [selectionKey(sel.stage, sel.path), sel])
    );
    const patchParts: string[] = [];
    const binaryPaths: string[] = [];

    for (const file of files) {
      if (file.stage !== "unstaged") {
        continue;
      }
      const sel = picked.get(selectionKey(file.stage, file.path));
      if (file.binary) {
        if (sel?.binary) {
          binaryPaths.push(file.path);
        }
        continue;
      }
      const selectedPart = filePatchForDiscard(file, sel);
      if (selectedPart) {
        patchParts.push(selectedPart);
      }
    }

    if (patchParts.length === 0 && binaryPaths.length === 0) {
      throw new Error("No unstaged hunks selected.");
    }

    await applyPatch(this.repoRoot, patchParts, true, undefined, false);
    for (const filePath of binaryPaths) {
      await runGit(["checkout", "--", filePath], this.repoRoot);
    }
  }

  /**
   * 선택한 hunk(및 binary 파일)만 인덱스에 올린 뒤 커밋한다.
   * @param files      현재 파싱된 전체 변경 파일(선택 id 매칭용)
   * @param selections 사용자가 고른 선택 정보
   * @param message    커밋 메시지
   */
  async commit(
    files: DiffFile[],
    selections: HunkSelection[],
    message: string
  ): Promise<void> {
    const picked = new Map(
      selections.map((sel) => [selectionKey(sel.stage, sel.path), sel])
    );
    const pickedStagedParts: string[] = [];
    const pickedUnstagedParts: string[] = [];
    const pickedStagedBinaryPaths: string[] = [];
    const pickedUnstagedBinaryPaths: string[] = [];

    for (const file of files) {
      const sel = picked.get(selectionKey(file.stage, file.path));
      if (file.binary) {
        if (sel?.binary && file.stage === "staged") {
          pickedStagedBinaryPaths.push(file.path);
        } else if (sel?.binary) {
          pickedUnstagedBinaryPaths.push(file.path);
        }
        continue;
      }
      const selectedPart = filePatchFromSelection(file, sel, false);
      if (file.stage === "staged") {
        if (selectedPart) {
          pickedStagedParts.push(selectedPart);
        }
      } else if (selectedPart) {
        pickedUnstagedParts.push(selectedPart);
      }
    }

    if (
      pickedStagedParts.length === 0 &&
      pickedUnstagedParts.length === 0 &&
      pickedStagedBinaryPaths.length === 0 &&
      pickedUnstagedBinaryPaths.length === 0
    ) {
      throw new Error("No hunks selected.");
    }

    const tempIndex = tempIndexPath();
    const tempEnv = { GIT_INDEX_FILE: tempIndex };
    try {
      await runGit(["read-tree", "HEAD"], this.repoRoot, tempEnv);
      await applyPatch(this.repoRoot, pickedStagedParts, false, tempEnv);
      await applyPatch(this.repoRoot, pickedUnstagedParts, false, tempEnv);
      for (const filePath of [
        ...pickedStagedBinaryPaths,
        ...pickedUnstagedBinaryPaths,
      ]) {
        await runGit(["add", "--", filePath], this.repoRoot, tempEnv);
      }
      const tree = (await runGit(["write-tree"], this.repoRoot, tempEnv)).trim();
      const commit = (
        await runGit(["commit-tree", tree, "-p", "HEAD", "-m", message], this.repoRoot)
      ).trim();

      await applyPatch(this.repoRoot, pickedUnstagedParts);
      for (const filePath of pickedUnstagedBinaryPaths) {
        await runGit(["add", "--", filePath], this.repoRoot);
      }
      await runGit(["update-ref", "HEAD", commit], this.repoRoot);
    } finally {
      safeUnlink(tempIndex);
    }
  }
}

/** `git diff` 원문을 DiffFile 배열로 파싱한다. */
function parseDiff(raw: string, stage: DiffStage): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let headerLines: string[] = [];
  let hunkLines: string[] | undefined;
  let hunkIndex = 0;

  const flushHunk = (): void => {
    if (current && hunkLines) {
      while (hunkLines[hunkLines.length - 1] === "") {
        hunkLines.pop();
      }
      current.hunks.push({
        id: `${current.stage}:${current.path}#${hunkIndex++}`,
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
      current = { stage, path: filePath, header: "", hunks: [], binary: false };
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

/** 미추적 파일 목록을 line stage 가능한 new-file diff 로 변환한다. */
async function parseUntrackedFiles(
  repoRoot: string,
  raw: string,
  skipPaths: Set<string>
): Promise<DiffFile[]> {
  const paths = raw.split("\0").filter((item) => item.length > 0);
  const files: DiffFile[] = [];
  for (const relPath of paths) {
    if (skipPaths.has(relPath)) {
      continue;
    }
    files.push(await untrackedFileToDiff(repoRoot, relPath));
  }
  return files;
}

/**
 * 미추적 파일 하나를 `/dev/null → working file` 형태의 synthetic diff 로 만든다.
 * @param repoRoot 저장소 루트
 * @param relPath 저장소 상대 경로
 */
async function untrackedFileToDiff(
  repoRoot: string,
  relPath: string
): Promise<DiffFile> {
  const fullPath = path.join(repoRoot, relPath);
  const header = newFileHeader(relPath, await fileMode(fullPath));
  try {
    const buffer = await fs.promises.readFile(fullPath);
    if (buffer.includes(0)) {
      return { stage: "unstaged", path: relPath, header, hunks: [], binary: true };
    }
    const content = buffer.toString("utf8");
    const hunk = newFileHunk(content);
    return {
      stage: "unstaged",
      path: relPath,
      header,
      hunks: hunk ? [{ id: `unstaged:${relPath}#0`, text: hunk }] : [],
      binary: false,
    };
  } catch {
    return { stage: "unstaged", path: relPath, header, hunks: [], binary: true };
  }
}

/** new-file diff header 를 만든다. */
function newFileHeader(relPath: string, mode: string): string {
  return [
    `diff --git a/${relPath} b/${relPath}`,
    `new file mode ${mode}`,
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relPath}`,
  ].join("\n");
}

/** 파일 모드를 git diff header 에 들어가는 100644/100755 형태로 만든다. */
async function fileMode(fullPath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(fullPath);
    return stat.mode & 0o111 ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

/** 파일 내용을 new-file hunk 본문으로 만든다. */
function newFileHunk(content: string): string | undefined {
  const split = splitContent(content);
  if (!split.lines.length) {
    return undefined;
  }
  const lines = split.lines.map((line) => `+${line}`);
  if (!split.finalNewline) {
    lines.push("\\ No newline at end of file");
  }
  return `@@ -0,0 +${rangeText(1, split.lines.length)} @@\n${lines.join("\n")}`;
}

/** 문자열을 patch line 배열과 마지막 개행 여부로 나눈다. */
function splitContent(content: string): { lines: string[]; finalNewline: boolean } {
  if (!content.length) {
    return { lines: [], finalNewline: false };
  }
  const finalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (finalNewline) {
    lines.pop();
  }
  return { lines, finalNewline };
}

/** 파일이 HEAD 에 없던 new-file diff 인지 확인한다. */
function isNewFile(file: DiffFile): boolean {
  return /(^|\n)--- \/dev\/null(\n|$)/.test(file.header);
}

/** 선택 정보가 파일 안의 모든 변경 라인을 포함하는지 확인한다. */
function selectionCoversAllChanges(
  file: DiffFile,
  selection: HunkSelection | undefined
): boolean {
  if (!selection) {
    return false;
  }
  const lineIds = new Set(selection.lineIds ?? []);
  const hunkIds = new Set(selection.hunkIds);
  let found = false;
  for (const hunk of file.hunks) {
    const [, ...body] = hunk.text.split("\n");
    for (let index = 0; index < body.length; index++) {
      if (!isChangeLine(body[index])) {
        continue;
      }
      found = true;
      if (!hunkIds.has(hunk.id) && !lineIds.has(`${hunk.id}:${index}`)) {
        return false;
      }
    }
  }
  return found;
}

/** hunk body 의 변경 라인 여부. */
function isChangeLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/** unified diff range 텍스트. */
function rangeText(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/** 선택 키는 같은 파일의 staged/unstaged hunk 를 구분해야 한다. */
function selectionKey(stage: DiffStage, filePath: string): string {
  return `${stage}\0${filePath}`;
}

/**
 * patch 조각들을 index 또는 working tree 에 적용한다.
 * - 선택 라인으로 hunk 본문을 재구성하므로 `--recount` 로 header count 를 git 이 다시 검증하게 한다.
 * @param repoRoot 저장소 루트
 * @param parts 적용할 unified diff 조각들
 * @param reverse true 면 patch 를 반대로 적용한다
 * @param env 임시 index 등 git 환경 변수
 * @param cached true 면 index 에 적용하고 false 면 working tree 에 적용한다
 */
async function applyPatch(
  repoRoot: string,
  parts: string[],
  reverse = false,
  env?: Record<string, string>,
  cached = true
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
      env
    );
  } finally {
    safeUnlink(patchFile);
  }
}

/** 임시 패치 파일 경로를 만든다(난수 접미사). */
function tempPatchPath(): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-split-${suffix}.patch`);
}

/** 임시 git index 파일 경로를 만든다. */
function tempIndexPath(): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-split-index-${suffix}`);
}

/** 파일을 조용히 삭제한다(없어도 무시). */
function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 무시 */
  }
}
