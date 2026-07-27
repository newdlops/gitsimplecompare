// Split Commit의 editable diff 계산·렌더링 모듈.
// - 전체 파일 좌/우 텍스트와 git hunk line id를 결합하고, 선택·편집 이벤트만 상위 상태 조정기에 콜백으로 전달한다.
(function () {
  "use strict";

  /** 상위 renderer의 DOM/상태 callback을 받아 editable diff API를 만든다. */
  window.__gscSplitEditableDiff = function createSplitEditableDiff(deps) {
    const { T, esc, hunksEl } = deps;

    /** 한 파일의 전체 editable diff와 선택 checkbox·contenteditable 이벤트를 렌더한다. */
    function render(options) {
      const { file, item, baseText, workingText, onSelection, onDirty } = options;
      const rows = buildRows(file, baseText, workingText);
      hunksEl.innerHTML =
        `<div class="edit-diff">` +
        `<div class="edit-diff-head"><span>${esc(T.previous)}</span>` +
        `<span>${esc(T.changed)}</span></div>` +
        `<div class="edit-diff-body">` +
        rows.map((row) => rowHtml(row, item)).join("") +
        `</div></div>`;
      hunksEl.querySelectorAll(".line-check").forEach((input) => {
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("change", (event) => {
          onSelection(decodeLineIds(event.target.dataset.lineIds), event.target.checked);
        });
      });
      hunksEl.querySelectorAll(".right-edit").forEach((cell) => {
        cell.addEventListener("input", onDirty);
        cell.addEventListener("keydown", (event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            document.execCommand("insertText", false, "  ");
          }
        });
      });
    }

    /** editable diff 한 행의 좌·우 line number, 선택 checkbox, 편집 cell HTML을 만든다. */
    function rowHtml(row, item) {
      const ids = row.lineIds || [];
      const pick = ids.length ? lineCheckbox(ids, item) : `<span class="line-check-slot"></span>`;
      const right = row.newNo > 0
        ? `<span class="line-no">${lineNumber(row.newNo)}</span>` +
          `<span class="line-marker">${row.rightKind === "add" ? "+" : ""}</span>` +
          `<span class="right-edit" contenteditable="plaintext-only" data-new-no="${row.newNo}">${esc(row.rightText)}</span>`
        : `<span class="line-no"></span><span class="line-marker"></span><span class="line-text"></span>`;
      const left = row.oldNo > 0
        ? `<span class="line-no">${lineNumber(row.oldNo)}</span>` +
          `<span class="line-marker">${row.leftKind === "del" ? "-" : ""}</span>` +
          `<span class="line-text">${esc(row.leftText)}</span>`
        : `<span class="line-no"></span><span class="line-marker"></span><span class="line-text"></span>`;
      return `<div class="edit-row ${esc(row.kind)}">` +
        `<div class="edit-cell left line-${esc(row.leftKind || "context")}">` +
        `<span class="line-check-slot"></span>${left}</div>` +
        `<div class="edit-cell right line-${esc(row.rightKind || "context")}">` +
        `${pick}${right}</div></div>`;
    }

    /** 선택 대상 line id 배열을 checkbox dataset에 안전하게 넣는다. */
    function lineCheckbox(ids, item) {
      const lineIds = Array.isArray(ids) ? ids : [ids];
      const checked = lineIds.length > 0 && lineIds.every((id) => item.lineIds.has(id));
      return `<input class="line-check" type="checkbox" title="${esc(T.stageSelected)}" ` +
        `aria-label="${esc(T.stageSelected)}" data-line-ids="${esc(encodeLineIds(lineIds))}" ${checked ? "checked" : ""} />`;
    }

    /** 현재 오른쪽 편집 텍스트와 base 텍스트를 LCS line diff로 바꾼 뒤 hunk 선택 id를 결합한다. */
    function buildRows(file, baseText, changedText) {
      const oldLines = textLines(baseText);
      const newLines = textLines(changedText);
      const maps = hunkLineMaps(file);
      const ops = lineDiff(oldLines, newLines);
      const rows = [];
      let index = 0;
      while (index < ops.length) {
        const op = ops[index];
        if (op.type === "equal") {
          rows.push({ kind: "context", oldNo: op.oldNo, newNo: op.newNo, leftText: op.text, rightText: op.text, leftKind: "context", rightKind: "context", lineIds: [] });
          index++;
          continue;
        }
        const deletions = [];
        const additions = [];
        while (index < ops.length && ops[index].type !== "equal") {
          if (ops[index].type === "delete") deletions.push(ops[index]);
          else additions.push(ops[index]);
          index++;
        }
        const count = Math.max(deletions.length, additions.length);
        for (let row = 0; row < count; row++) {
          const del = deletions[row];
          const add = additions[row];
          const ids = add ? maps.added.get(add.newNo) || [] : del ? maps.deleted.get(del.oldNo) || [] : [];
          rows.push({ kind: add && del ? "change" : add ? "insert" : "delete", oldNo: del ? del.oldNo : 0, newNo: add ? add.newNo : 0, leftText: del ? del.text : "", rightText: add ? add.text : "", leftKind: del ? "del" : "empty", rightKind: add ? "add" : "empty", lineIds: ids });
        }
      }
      return rows;
    }

    /** hunk line id를 old/new line number로 찾아 editable row의 stage checkbox와 연결한다. */
    function hunkLineMaps(file) {
      const added = new Map();
      const deleted = new Map();
      for (const hunk of file.hunks) {
        const [header, ...body] = hunk.text.split("\n");
        let index = 0;
        let oldNo = hunkStartLine(header, "old");
        let newNo = hunkStartLine(header, "new");
        while (index < body.length) {
          const line = body[index];
          if (line.startsWith("-") || line.startsWith("+")) {
            const dels = [];
            const adds = [];
            while (index < body.length && body[index].startsWith("-")) {
              dels.push({ index, no: oldNo++ });
              index++;
            }
            while (index < body.length && body[index].startsWith("+")) {
              adds.push({ index, no: newNo++ });
              index++;
            }
            if (adds.length) {
              for (let row = 0; row < adds.length; row++) {
                const paired = dels[row] ? [lineId(hunk, dels[row].index)] : [];
                added.set(adds[row].no, [...paired, lineId(hunk, adds[row].index)]);
              }
            } else {
              dels.forEach((del) => deleted.set(del.no, [lineId(hunk, del.index)]));
            }
            continue;
          }
          if (!line.startsWith("\\")) {
            oldNo++;
            newNo++;
          }
          index++;
        }
      }
      return { added, deleted };
    }

    /** LCS 기반 line diff로 equal/insert/delete 연산과 1-base line number를 만든다. */
    function lineDiff(oldLines, newLines) {
      const n = oldLines.length;
      const m = newLines.length;
      const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const ops = [];
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && oldLines[i] === newLines[j]) {
          ops.push({ type: "equal", text: oldLines[i], oldNo: i + 1, newNo: j + 1 });
          i++;
          j++;
        } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
          ops.push({ type: "insert", text: newLines[j], newNo: j + 1 });
          j++;
        } else {
          ops.push({ type: "delete", text: oldLines[i], oldNo: i + 1 });
          i++;
        }
      }
      return ops;
    }

    /** 입력 문자열을 LF 기준 line 배열로 만들고 마지막 빈 line은 newline 표기로만 취급한다. */
    function textLines(text) {
      const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines;
    }

    /** git hunk header에서 old/new 쪽 시작 줄을 읽고 손상된 header는 안전한 첫 줄로 보정한다. */
    function hunkStartLine(header, side) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
      return match ? Number(side === "old" ? match[1] : match[2]) : 1;
    }

    /** hunk body 위치를 stage selection이 공유하는 안정 id로 만든다. */
    function lineId(hunk, index) {
      return `${hunk.id}:${index}`;
    }

    /** 0 이하 line number는 새/삭제 파일의 빈 칸으로 표시한다. */
    function lineNumber(number) {
      return number > 0 ? String(number) : "";
    }

    /** line id 배열을 dataset attribute에 안전하게 넣는다. */
    function encodeLineIds(ids) {
      return encodeURIComponent(JSON.stringify(ids || []));
    }

    /** dataset에 저장한 line id 배열을 실패 시 빈 배열로 복원한다. */
    function decodeLineIds(value) {
      try {
        return JSON.parse(decodeURIComponent(value || "%5B%5D"));
      } catch {
        return [];
      }
    }

    return { render };
  };
}());
