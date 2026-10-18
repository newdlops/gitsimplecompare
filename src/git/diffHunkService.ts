// 작업 변경을 hunk(diff 조각) 단위로 골라 여러 커밋으로 나누는 서비스 모듈.
// - staged/unstaged diff 를 모두 파싱하고, 선택 hunk 만 커밋한다.
// - 선택하지 않은 staged hunk 는 커밋 뒤 다시 staged 상태로 복원한다.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  filePatchForDiscard,
  filePatchForUnstage,
  filePatchFromSelection,
} from "./diffPatchBuild";
import { createDiffMutationGuard } from "./diffMutationGuard";
import { applyPatch, safeUnlink, tempIndexPath } from "./gitPatchApply";
import { runGitLiteralPaths as runGit } from "./gitExec";
import { readWorkingDiff } from "./diffWorkingRead";
import { runGitWithPaths } from "./pathspecExec";

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
    return readWorkingDiff(this.repoRoot);
  }

  /**
   * 특정 파일의 staged/unstaged 변경만 파싱해 반환한다.
   * - editable diff checkbox 초기 렌더처럼 파일 하나만 필요한 경로에서 전체 diff 파싱을 피한다.
   * @param relPath 저장소 상대 파일 경로
   * @param signal 파일 표시 소비자가 더 이상 필요하지 않을 때 Git과 후속 파일 I/O를 취소한다.
   */
  async getFileWorkingDiff(relPath: string, signal?: AbortSignal): Promise<DiffFile[]> {
    return this.getFilesWorkingDiff([relPath], signal);
  }

  /**
   * 선택 파일을 묶어 최신 diff를 읽어 파일마다 Git 세 개를 새로 실행하지 않는다.
   * - 명령줄 한도 안의 묶음을 차례로 읽고 각 묶음 안의 staged/unstaged/미추적 조회만 병렬화한다.
   * - 캐시하지 않아 변경 직전과 lock 재시도 때 실제 파일/index 상태를 다시 검증할 수 있다.
   * @param relPaths literal 저장소 상대 경로 목록. 빈 목록은 전체 조회 없이 빈 배열을 반환한다.
   * @param signal 소비자가 필요 없어진 뒤 후속 묶음과 파일 읽기를 중단할 신호
   * @returns 각 stage/path별 최신 header와 hunk. 단일 파일 조회와 같은 hunk ID를 사용한다.
   */
  async getFilesWorkingDiff(relPaths: readonly string[], signal?: AbortSignal): Promise<DiffFile[]> {
    return readWorkingDiff(this.repoRoot, relPaths, signal);
  }

  /**
   * 작업트리 파일 내용을 읽는다.
   * - HTML editable diff 웹뷰에서 오른쪽 작업 파일을 직접 편집할 때 사용한다.
   * @param relPath 저장소 상대 경로
   * @returns UTF-8 파일 내용
   */
  async readWorkingFile(relPath: string, signal?: AbortSignal): Promise<string> {
    return fs.promises.readFile(path.join(this.repoRoot, relPath), { encoding: "utf8", signal });
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

    const guard = createDiffMutationGuard(this, files, selections);
    await guard.assertSafe();
    await applyPatch(
      this.repoRoot,
      patchParts,
      false,
      undefined,
      true,
      guard.beforeRetry
    );
    for (const filePath of binaryPaths) {
      await runGit(["add", "--", filePath], this.repoRoot, {
        beforeRetry: guard.beforeRetry,
      });
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
    assertWholeFileTypeSelections(files, picked);

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
      if ((isNewFile(file) || isDeletedFile(file)) && selectionCoversAllChanges(file, sel)) {
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

    const guard = createDiffMutationGuard(this, files, selections);
    await guard.assertSafe();
    await applyPatch(
      this.repoRoot,
      patchParts,
      false,
      undefined,
      true,
      guard.beforeRetry
    );
    // 전체 선택한 추가/삭제 파일과 binary는 reset을 묶어 index 재조회와 lock 획득을 반복하지 않는다.
    await runGitWithPaths(["--literal-pathspecs", "reset", "HEAD"], [...resetPaths, ...binaryPaths], this.repoRoot, {
      beforeRetry: guard.beforeRetry,
    });
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

    const guard = createDiffMutationGuard(this, files, selections);
    await guard.assertSafe();
    await applyPatch(
      this.repoRoot,
      patchParts,
      true,
      undefined,
      false,
      guard.beforeRetry
    );
    for (const filePath of binaryPaths) {
      await runGit(["checkout", "--", filePath], this.repoRoot, {
        beforeRetry: guard.beforeRetry,
      });
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

    const guard = createDiffMutationGuard(this, files, selections);
    await guard.assertSafe();
    const oldHead = (await runGit(["rev-parse", "HEAD"], this.repoRoot)).trim();
    const tempIndex = tempIndexPath();
    const tempEnv = { GIT_INDEX_FILE: tempIndex };
    try {
      await runGit(["read-tree", oldHead], this.repoRoot, tempEnv);
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
        await runGit(
          ["commit-tree", tree, "-p", oldHead, "-m", message],
          this.repoRoot
        )
      ).trim();

      await applyPatch(
        this.repoRoot,
        pickedUnstagedParts,
        false,
        undefined,
        true,
        guard.beforeRetry
      );
      for (const filePath of pickedUnstagedBinaryPaths) {
        await runGit(["add", "--", filePath], this.repoRoot, {
          beforeRetry: guard.beforeRetry,
        });
      }
      await runGit(["update-ref", "HEAD", commit, oldHead], this.repoRoot, {
        beforeRetry: guard.beforeRetry,
      });
    } finally {
      safeUnlink(tempIndex);
    }
  }
}

/** 파일이 HEAD 에 없던 new-file diff 인지 확인한다. */
function isNewFile(file: DiffFile): boolean {
  return /(^|\n)--- \/dev\/null(\n|$)/.test(file.header);
}

/** @param file Git diff 항목 @returns 삭제되어 index 복원이 필요한 파일이면 true */
function isDeletedFile(file: DiffFile): boolean {
  return /(^|\n)\+\+\+ \/dev\/null(\n|$)/.test(file.header);
}

/**
 * 파일 종류 변경의 D/A 구간을 일부만 선택했을 때 전체 reset으로 확대되는 것을 막는다.
 * - 같은 경로의 구간은 hunk ID가 겹치므로 종류 변경은 모든 구간의 전체 선택만 허용한다.
 * @param files 최신 diff 목록 @param picked stage/path별 사용자 선택
 * @throws 복수 구간 경로에 부분 선택이 있으면 index에 쓰기 전에 오류를 반환한다.
 */
function assertWholeFileTypeSelections(files: readonly DiffFile[], picked: ReadonlyMap<string, HunkSelection>): void {
  const groups = new Map<string, DiffFile[]>();
  for (const file of files) {
    if (file.stage !== "staged") continue;
    const key = selectionKey(file.stage, file.path);
    if (!picked.has(key)) continue;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const selection = picked.get(key)!;
    if (!selection.binary && !selection.hunkIds.length && !selection.lineIds?.length) continue;
    if (!group.every(file => file.binary ? selection.binary : selectionCoversAllChanges(file, selection))) {
      throw new Error("File type changes must be unstaged as a whole file.");
    }
  }
}

/**
 * 부분 선택을 전체 reset으로 확장하지 않도록 파일의 모든 변경 줄이 선택됐는지 확인한다.
 * @param file 현재 diff 파일 @param selection line ID가 있으면 hunk ID보다 우선하는 선택 정보
 * @returns 모든 변경 줄이 실제 선택에 포함됐으면 true
 */
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
      if (!lineIds.has(`${hunk.id}:${index}`) && !(lineIds.size === 0 && hunkIds.has(hunk.id))) {
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

/** 선택 키는 같은 파일의 staged/unstaged hunk 를 구분해야 한다. */
function selectionKey(stage: DiffStage, filePath: string): string {
  return `${stage}\0${filePath}`;
}
