// diff hunk 선택을 git apply 용 patch 조각으로 바꾸는 순수 유틸.
// - DiffHunkService 는 git 명령 실행과 흐름 제어에 집중하고,
//   hunk 본문 재구성 규칙은 이 모듈에서 한곳에 관리한다.
import type { DiffFile, DiffHunk, HunkSelection } from "./diffHunkService";

/** 선택 라인 기준 patch 조각을 만든다. invert=true 면 선택하지 않은 변경 라인을 뽑는다. */
export function filePatchFromSelection(
  file: DiffFile,
  selection: HunkSelection | undefined,
  invert: boolean
): string | undefined {
  const lineIds = new Set(selection?.lineIds ?? []);
  const hunkIds = new Set(selection?.hunkIds ?? []);
  const parts = file.hunks
    .map((hunk) =>
      hunkPatchFromSelection(hunk, (line, index) => {
        if (!isChangeLine(line)) {
          return false;
        }
        const selected =
          lineIds.has(lineId(hunk, index)) ||
          (lineIds.size === 0 && hunkIds.has(hunk.id));
        return invert ? !selected : selected;
      })
    )
    .filter((part): part is string => !!part);
  return parts.length ? file.header + "\n" + parts.join("\n") : undefined;
}

/** working tree 에 reverse apply 할 discard 용 patch 조각을 만든다. */
export function filePatchForDiscard(
  file: DiffFile,
  selection: HunkSelection | undefined
): string | undefined {
  const lineIds = new Set(selection?.lineIds ?? []);
  const hunkIds = new Set(selection?.hunkIds ?? []);
  const parts = file.hunks
    .map((hunk) =>
      hunkPatchForDiscard(hunk, (line, index) => {
        if (!isChangeLine(line)) {
          return false;
        }
        return (
          lineIds.has(lineId(hunk, index)) ||
          (lineIds.size === 0 && hunkIds.has(hunk.id))
        );
      })
    )
    .filter((part): part is string => !!part);
  return parts.length
    ? unstagePatchHeader(file) + "\n" + parts.join("\n")
    : undefined;
}

/** staged 변경을 index 에서 선택적으로 내리기 위한 patch 조각을 만든다. */
export function filePatchForUnstage(
  file: DiffFile,
  selection: HunkSelection | undefined
): string | undefined {
  const lineIds = new Set(selection?.lineIds ?? []);
  const hunkIds = new Set(selection?.hunkIds ?? []);
  const parts = file.hunks
    .map((hunk) =>
      hunkPatchForUnstage(hunk, (line, index) => {
        if (!isChangeLine(line)) {
          return false;
        }
        return (
          lineIds.has(lineId(hunk, index)) ||
          (lineIds.size === 0 && hunkIds.has(hunk.id))
        );
      })
    )
    .filter((part): part is string => !!part);
  return parts.length ? file.header + "\n" + parts.join("\n") : undefined;
}

/** hunk 안의 선택 라인만 남기고 hunk header count 를 다시 계산한다. */
function hunkPatchFromSelection(
  hunk: DiffHunk,
  pick: (line: string, index: number) => boolean
): string | undefined {
  const [header, ...body] = hunk.text.split("\n");
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) {
    return undefined;
  }
  let pickedAny = false;
  const lines: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    if (!isChangeLine(line)) {
      lines.push(line);
      continue;
    }
    if (pick(line, index)) {
      lines.push(line);
      pickedAny = true;
    } else if (line.startsWith("-")) {
      lines.push(" " + line.slice(1));
    }
  }
  if (!pickedAny) {
    return undefined;
  }
  const oldCount = lines.filter(
    (line) => !line.startsWith("+") && !line.startsWith("\\")
  ).length;
  const newCount = lines.filter(
    (line) => !line.startsWith("-") && !line.startsWith("\\")
  ).length;
  const oldRange = rangeText(Number(match[1]), oldCount);
  const newRange = rangeText(Number(match[2]), newCount);
  return `@@ -${oldRange} +${newRange} @@${match[3]}` + "\n" + lines.join("\n");
}

/** 선택 변경만 working tree 에서 되돌리기 위한 hunk patch 를 만든다. */
function hunkPatchForDiscard(
  hunk: DiffHunk,
  pick: (line: string, index: number) => boolean
): string | undefined {
  const [header, ...body] = hunk.text.split("\n");
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) {
    return undefined;
  }
  let pickedAny = false;
  const lines: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    if (!isChangeLine(line)) {
      lines.push(line);
      continue;
    }
    if (pick(line, index)) {
      lines.push(line);
      pickedAny = true;
    } else if (line.startsWith("+")) {
      lines.push(" " + line.slice(1));
    }
  }
  if (!pickedAny) {
    return undefined;
  }
  const oldCount = lines.filter(
    (line) => !line.startsWith("+") && !line.startsWith("\\")
  ).length;
  const newCount = lines.filter(
    (line) => !line.startsWith("-") && !line.startsWith("\\")
  ).length;
  const oldRange = rangeText(Number(match[1]), oldCount);
  const newRange = rangeText(Number(match[2]), newCount);
  return `@@ -${oldRange} +${newRange} @@${match[3]}` + "\n" + lines.join("\n");
}

/** staged diff 를 index 기준 patch 로 바꿔 선택 라인만 unstage 한다. */
function hunkPatchForUnstage(
  hunk: DiffHunk,
  pick: (line: string, index: number) => boolean
): string | undefined {
  const [header, ...body] = hunk.text.split("\n");
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) {
    return undefined;
  }
  let pickedAny = false;
  const lines: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    if (!isChangeLine(line)) {
      lines.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      if (pick(line, index)) {
        lines.push("-" + line.slice(1));
        pickedAny = true;
      } else {
        lines.push(" " + line.slice(1));
      }
      continue;
    }
    if (pick(line, index)) {
      lines.push("+" + line.slice(1));
      pickedAny = true;
    }
  }
  if (!pickedAny) {
    return undefined;
  }
  const oldCount = lines.filter(
    (line) => !line.startsWith("+") && !line.startsWith("\\")
  ).length;
  const newCount = lines.filter(
    (line) => !line.startsWith("-") && !line.startsWith("\\")
  ).length;
  const start = Number(match[2]);
  return (
    `@@ -${rangeText(start, oldCount)} +${rangeText(start, newCount)} @@${match[3]}` +
    "\n" +
    lines.join("\n")
  );
}

/** unstage patch 는 현재 index 파일을 대상으로 하도록 header 를 보정한다. */
function unstagePatchHeader(file: DiffFile): string {
  if (!/(^|\n)--- \/dev\/null(\n|$)/.test(file.header)) {
    return file.header;
  }
  return [
    `diff --git a/${file.path} b/${file.path}`,
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
  ].join("\n");
}

/** hunk body 의 변경 라인 여부. */
function isChangeLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/** hunk line id 는 webview 와 동일하게 만든다. */
function lineId(hunk: DiffHunk, index: number): string {
  return `${hunk.id}:${index}`;
}

/** unified diff range 텍스트. */
function rangeText(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
