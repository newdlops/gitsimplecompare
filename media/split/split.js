// 변경 분할(부분 커밋) 웹뷰 클라이언트.
// - 파일 목록과 hunk 상세를 분리해, 한 파일에 변경이 많아도 커밋 단위를 고르기 쉽게 한다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const fileListEl = document.getElementById("file-list");
  const hunksEl = document.getElementById("hunks");
  const fileCountEl = document.getElementById("file-count");
  const activePathEl = document.getElementById("active-path");
  const activeMetaEl = document.getElementById("active-meta");
  const filterEl = document.getElementById("filter");
  const selectedOnlyBtn = document.getElementById("selected-only");
  const selectFileBtn = document.getElementById("select-file");
  const clearFileBtn = document.getElementById("clear-file");
  const openFileBtn = document.getElementById("open-file");
  const refreshBtn = document.getElementById("refresh");
  const saveWorkingFileBtn = document.getElementById("save-working-file");
  const commitBtn = document.getElementById("commit");
  const discardBtn = document.getElementById("discard");
  const summaryEl = document.getElementById("selection-summary");
  const noticeEl = document.getElementById("notice");

  const T = Object.assign(
    {
      all: "All",
      binary: "binary",
      clear: "Clear",
      changed: "Changed",
      emptyFile: "Select a file.",
      discardSelected: "Discard Selected",
      discardedSelected: "Selected hunks discarded.",
      filter: "Filter",
      files: "Files",
      headWorkingTree: "HEAD ↔ Working Tree",
      hunk: "hunk",
      hunks: "hunks",
      noChanges: "No changes.",
      noMatches: "No matching changes.",
      previous: "Previous",
      refresh: "Refresh",
      openEditableDiff: "Open Editable Diff",
      saveWorkingFile: "Save Working File",
      selected: "selected",
      selectedOnly: "Selected",
      selectedSummary: "{0} selected",
      stageSelected: "Stage Selected",
      staged: "Staged",
      stagedSelected: "Selected hunks staged.",
      unstaged: "Changes",
      workingFile: "Working File",
      workingFileDirty: "Unsaved",
      workingFileSaved: "Working file saved.",
    },
    window.__gscSplitI18n || {}
  );

  let currentFiles = [];
  let activeKey = "";
  let selectedOnly = false;
  let selected = new Map();
  let singleFile = false;
  let currentWorkingFile = undefined;
  let workingPath = "";
  let workingBaseText = "";
  let workingText = "";
  let workingHadFinalNewline = false;
  let workingDirty = false;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 간단한 지역화 포맷터. */
  function fmt(template, value) {
    return String(template).replace("{0}", String(value));
  }

  /** 변경 라인 체크박스 HTML. */
  function lineCheckbox(ids, item) {
    const lineIds = Array.isArray(ids) ? ids : [ids];
    const checked =
      lineIds.length > 0 && lineIds.every((id) => item.lineIds.has(id));
    return (
      `<input class="line-check" type="checkbox" title="${esc(
        T.stageSelected
      )}" data-line-ids="${esc(encodeLineIds(lineIds))}" ` +
      `${checked ? "checked" : ""} />`
    );
  }

  /** hunk 본문을 좌(이전 상태)/우(변경 후 상태) 비교 행 HTML 로 만든다. */
  function renderCompareRows(hunk, item) {
    const [header, ...body] = hunk.text.split("\n");
    const lines = [];
    let index = 0;
    let oldNo = hunkStartLine(header, "old");
    let newNo = hunkStartLine(header, "new");

    while (index < body.length) {
      const line = body[index];
      if (line.startsWith("\\")) {
        lines.push(compareMetaRow(line));
        index++;
        continue;
      }
      if (line.startsWith("-") || line.startsWith("+")) {
        const oldLines = [];
        const newLines = [];
        while (index < body.length && body[index].startsWith("-")) {
          oldLines.push({ line: body[index], index, no: oldNo++ });
          index++;
        }
        while (index < body.length && body[index].startsWith("+")) {
          newLines.push({ line: body[index], index, no: newNo++ });
          index++;
        }
        const rowCount = Math.max(oldLines.length, newLines.length);
        for (let row = 0; row < rowCount; row++) {
          lines.push(compareChangeRow(hunk, item, oldLines[row], newLines[row]));
        }
        continue;
      }
      const text = line.startsWith(" ") ? line.slice(1) : line;
      lines.push(compareContextRow(oldNo++, newNo++, text));
      index++;
    }
    return lines.join("");
  }

  /** 삭제/추가 변경 행을 만든다. */
  function compareChangeRow(hunk, item, oldLine, newLine) {
    return (
      `<div class="compare-row change-row">` +
      compareCell(hunk, item, oldLine, "left", "del") +
      compareCell(hunk, item, newLine, "right", "add") +
      `</div>`
    );
  }

  /** 문맥 행을 좌우에 같은 내용으로 만든다. */
  function compareContextRow(oldNo, newNo, text) {
    return (
      `<div class="compare-row context-row">` +
      compareContextCell(oldNo, text, "left") +
      compareContextCell(newNo, text, "right") +
      `</div>`
    );
  }

  /** `\ No newline at end of file` 같은 diff 메타 행을 만든다. */
  function compareMetaRow(text) {
    return `<div class="compare-row meta-row"><span>${esc(text)}</span></div>`;
  }

  /** 좌/우 변경 셀 한 칸을 만든다. 빈 칸은 추가/삭제가 한쪽에만 있을 때 쓰인다. */
  function compareCell(hunk, item, entry, side, kind) {
    if (!entry) {
      return (
        `<span class="compare-cell ${side} empty-cell">` +
        `<span class="line-check-slot"></span><span class="line-no"></span>` +
        `<span class="line-marker"></span><span class="line-text"></span></span>`
      );
    }
    const id = lineId(hunk, entry.index);
    const marker = kind === "del" ? "-" : "+";
    return (
      `<span class="compare-cell ${side} line-${kind} line-pick" ` +
      `data-line-id="${esc(id)}">` +
      lineCheckbox(id, item) +
      `<span class="line-no">${lineNumber(entry.no)}</span>` +
      `<span class="line-marker">${marker}</span>` +
      `<span class="line-text">${esc(entry.line.slice(1) || " ")}</span></span>`
    );
  }

  /** 문맥 셀 한 칸을 만든다. 문맥은 선택 대상이 아니므로 checkbox 자리는 비워 둔다. */
  function compareContextCell(no, text, side) {
    return (
      `<span class="compare-cell ${side} context-cell">` +
      `<span class="line-check-slot"></span>` +
      `<span class="line-no">${lineNumber(no)}</span>` +
      `<span class="line-marker"></span>` +
      `<span class="line-text">${esc(text || " ")}</span></span>`
    );
  }

  /** 현재 필터 조건에 맞는 파일 목록. */
  function visibleFiles() {
    const q = filterEl.value.trim().toLowerCase();
    return currentFiles.filter((file) => {
      if (selectedOnly && selectedCount(file) === 0) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        file.path.toLowerCase().includes(q) ||
        file.hunks.some((hunk) => hunk.text.toLowerCase().includes(q))
      );
    });
  }

  /** 파일별 선택 상태 객체를 얻는다. */
  function fileSelection(file) {
    const key = fileKey(file);
    let item = selected.get(key);
    if (!item) {
      item = { hunkIds: new Set(), lineIds: new Set(), binary: false };
      selected.set(key, item);
    }
    return item;
  }

  /** 파일의 선택 hunk/binary 개수. */
  function selectedCount(file) {
    const item = selected.get(fileKey(file));
    if (!item) {
      return 0;
    }
    return file.binary ? (item.binary ? 1 : 0) : item.lineIds.size;
  }

  /** 전체 선택 개수. */
  function totalSelectedCount() {
    return currentFiles.reduce((sum, file) => sum + selectedCount(file), 0);
  }

  /** 선택 맵에서 사라진 파일/hunk 를 제거한다. */
  function pruneSelection() {
    const validFiles = new Map(currentFiles.map((file) => [fileKey(file), file]));
    for (const key of Array.from(selected.keys())) {
      const file = validFiles.get(key);
      if (!file) {
        selected.delete(key);
        continue;
      }
      if (file.binary) {
        selected.get(key).hunkIds.clear();
        selected.get(key).lineIds.clear();
        continue;
      }
      const ids = new Set(file.hunks.flatMap((hunk) => changeLineIds(hunk)));
      const item = selected.get(key);
      item.binary = false;
      item.hunkIds.clear();
      for (const id of Array.from(item.lineIds)) {
        if (!ids.has(id)) {
          item.lineIds.delete(id);
        }
      }
    }
  }

  /** 파일 목록/상세 전체를 다시 그린다. */
  function render(files, focus, scoped, workingFile) {
    currentFiles = files || [];
    if (arguments.length >= 4) {
      currentWorkingFile = workingFile;
    }
    singleFile = !!scoped;
    document.body.classList.toggle("single-file-scope", singleFile);
    pruneSelection();
    const list = visibleFiles();
    if (focus?.path) {
      const focused = currentFiles.find((file) => {
        if (file.path !== focus.path) {
          return false;
        }
        return !focus.stage || file.stage === focus.stage;
      });
      if (focused) {
        activeKey = fileKey(focused);
      }
    }
    if (!list.some((file) => fileKey(file) === activeKey)) {
      activeKey = list[0] ? fileKey(list[0]) : "";
    }
    renderFileList(list);
    renderWorkingFile(currentWorkingFile);
    renderActiveFile();
    updateFooter();
  }

  /** 작업 파일 HTML textarea 를 갱신한다. */
  function renderWorkingFile(workingFile) {
    if (!workingFile) {
      workingPath = "";
      workingBaseText = "";
      workingText = "";
      workingDirty = false;
      updateEditorState();
      return;
    }
    const editedText = collectEditedWorkingText();
    if (
      !workingDirty ||
      workingPath !== workingFile.path ||
      editedText === workingFile.text
    ) {
      workingPath = workingFile.path;
      workingBaseText = workingFile.baseText || "";
      workingText = workingFile.text || "";
      workingHadFinalNewline = workingText.endsWith("\n");
      workingDirty = false;
    }
    updateEditorState();
  }

  /** 작업 파일 editor 저장/dirty 표시를 갱신한다. */
  function updateEditorState() {
    if (!saveWorkingFileBtn) {
      return;
    }
    saveWorkingFileBtn.disabled = !workingDirty || !workingPath;
    saveWorkingFileBtn.classList.toggle("dirty", workingDirty);
  }

  /** 왼쪽 파일 목록 렌더링. */
  function renderFileList(list) {
    fileCountEl.textContent = String(list.length);
    fileListEl.innerHTML = "";
    if (!currentFiles.length) {
      fileListEl.innerHTML = `<div class="empty">${esc(T.noChanges)}</div>`;
      return;
    }
    if (!list.length) {
      fileListEl.innerHTML = `<div class="empty">${esc(T.noMatches)}</div>`;
      return;
    }
    for (const file of list) {
      fileListEl.appendChild(fileRow(file));
    }
  }

  /** 파일 목록의 한 행. */
  function fileRow(file) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row" + (fileKey(file) === activeKey ? " active" : "");
    row.dataset.path = file.path;
    row.title = file.path;
    row.setAttribute("aria-label", file.path);
    const count = file.binary ? T.binary : `${file.hunks.length} ${T.hunks}`;
    const picked = selectedCount(file);
    row.innerHTML =
      `<span class="codicon codicon-file-code"></span>` +
      `<span class="file-main"><span class="file-name">${esc(baseName(file.path))}</span>` +
      `<span class="file-dir">${esc(dirName(file.path))}</span></span>` +
      `<span class="file-badges"><span class="stage-badge ${esc(file.stage)}">` +
      `${esc(stageLabel(file.stage))}</span><span>${esc(count)}</span>` +
      (picked ? `<span class="picked">${picked}</span>` : "") +
      `</span>`;
    row.addEventListener("click", () => {
      activeKey = fileKey(file);
      render(currentFiles);
    });
    return row;
  }

  /** 활성 파일 상세 렌더링. */
  function renderActiveFile() {
    const file = currentFiles.find((item) => fileKey(item) === activeKey);
    if (!file) {
      activePathEl.textContent = T.emptyFile;
      activeMetaEl.textContent = "";
      hunksEl.innerHTML = `<div class="empty">${esc(T.emptyFile)}</div>`;
      return;
    }
    activePathEl.textContent = file.path;
    const compareLabel =
      file.stage === "unstaged" ? T.headWorkingTree : stageLabel(file.stage);
    activeMetaEl.textContent = file.binary
      ? `${compareLabel} · ${T.binary}`
      : `${compareLabel} · ${file.hunks.length} ${T.hunks} · ` +
        `${selectedCount(file)} ${T.selected}`;
    if (file.binary) {
      hunksEl.innerHTML = "";
      hunksEl.appendChild(binaryCard(file));
      return;
    }
    renderEditableDiff(file);
  }

  /** 활성 파일을 카드가 아닌 전체 파일 editable diff 로 렌더링한다. */
  function renderEditableDiff(file) {
    const item = fileSelection(file);
    const rows = buildEditableDiffRows(file, workingBaseText, workingText);
    hunksEl.innerHTML =
      `<div class="edit-diff">` +
      `<div class="edit-diff-head"><span>${esc(T.previous)}</span>` +
      `<span>${esc(T.changed)}</span></div>` +
      `<div class="edit-diff-body">` +
      rows.map((row) => editableDiffRowHtml(row, item)).join("") +
      `</div></div>`;
    hunksEl.querySelectorAll(".line-check").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", (event) => {
        setLineIdsSelection(
          file,
          decodeLineIds(event.target.dataset.lineIds),
          event.target.checked
        );
      });
    });
    hunksEl.querySelectorAll(".right-edit").forEach((cell) => {
      cell.addEventListener("input", () => {
        workingDirty = true;
        updateEditorState();
      });
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          document.execCommand("insertText", false, "  ");
        }
      });
    });
  }

  /** editable diff 한 행 HTML. */
  function editableDiffRowHtml(row, item) {
    const ids = row.lineIds || [];
    const pick = ids.length
      ? lineCheckbox(ids, item)
      : `<span class="line-check-slot"></span>`;
    const right =
      row.newNo > 0
        ? `<span class="line-no">${lineNumber(row.newNo)}</span>` +
          `<span class="line-marker">${row.rightKind === "add" ? "+" : ""}</span>` +
          `<span class="right-edit" contenteditable="plaintext-only" ` +
          `data-new-no="${row.newNo}">${esc(row.rightText)}</span>`
        : `<span class="line-no"></span><span class="line-marker"></span>` +
          `<span class="line-text"></span>`;
    const left =
      row.oldNo > 0
        ? `<span class="line-no">${lineNumber(row.oldNo)}</span>` +
          `<span class="line-marker">${row.leftKind === "del" ? "-" : ""}</span>` +
          `<span class="line-text">${esc(row.leftText)}</span>`
        : `<span class="line-no"></span><span class="line-marker"></span>` +
          `<span class="line-text"></span>`;
    return (
      `<div class="edit-row ${esc(row.kind)}">` +
      `<div class="edit-cell left line-${esc(row.leftKind || "context")}">` +
      `<span class="line-check-slot"></span>${left}</div>` +
      `<div class="edit-cell right line-${esc(row.rightKind || "context")}">` +
      `${pick}${right}</div></div>`
    );
  }

  /** binary 파일 선택 카드. */
  function binaryCard(file) {
    const item = fileSelection(file);
    const label = document.createElement("label");
    label.className = "binary-card";
    label.innerHTML =
      `<input type="checkbox" title="${esc(T.stageSelected)}" ` +
      `aria-label="${esc(T.stageSelected)}" ${item.binary ? "checked" : ""} />` +
      `<span class="codicon codicon-file-binary"></span>` +
      `<span>${esc(file.path)}</span>`;
    label.querySelector("input").addEventListener("change", (event) => {
      item.binary = event.target.checked;
      render(currentFiles);
    });
    return label;
  }

  /** hunk 카드. */
  function hunkCard(file, hunk, ordinal) {
    const item = fileSelection(file);
    const ids = changeLineIds(hunk);
    const checkedCount = ids.filter((id) => item.lineIds.has(id)).length;
    const checked = ids.length > 0 && checkedCount === ids.length;
    const card = document.createElement("article");
    card.className = "hunk" + (checkedCount ? " selected" : "");
    card.dataset.id = hunk.id;
    const lines = hunk.text.split("\n");
    const headLine = lines[0] || "";
    const body = renderCompareRows(hunk, item);
    const stats = hunkStats(lines);
    card.innerHTML =
      `<header class="hunk-head">` +
      `<label class="check-wrap"><input type="checkbox" class="hunk-check" ` +
      `title="${esc(T.stageSelected)}" aria-label="${esc(T.stageSelected)}" ${
        checked ? "checked" : ""
	      } /></label>` +
      `<span class="hunk-title">${esc(hunkTitle(headLine, ordinal))}</span>` +
      `<span class="hunk-stat"><span class="add">+${stats.add}</span> ` +
      `<span class="del">-${stats.del}</span></span>` +
      `</header>` +
      `<div class="compare-labels"><span>${esc(T.previous)}</span>` +
      `<span>${esc(T.changed)}</span></div>` +
      `<div class="compare-grid">${body}</div>`;
    const hunkCheck = card.querySelector(".hunk-check");
    hunkCheck.indeterminate = checkedCount > 0 && checkedCount < ids.length;
    hunkCheck.addEventListener("change", (event) =>
      setHunkLineSelection(file, hunk, event.target.checked)
    );
    card.querySelectorAll(".line-check").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", (event) =>
        setLineSelection(file, event.target.dataset.lineId, event.target.checked)
      );
    });
    card.querySelector(".compare-grid").addEventListener("click", (event) => {
      const target =
        event.target instanceof Element ? event.target : event.target.parentElement;
      const row = target ? target.closest(".line-pick") : undefined;
      if (row && !target.closest(".line-check")) {
        const input = row.querySelector(".line-check");
        if (input) {
          setLineSelection(file, input.dataset.lineId, !input.checked);
        }
      }
    });
    return card;
  }

  /** hunk 안의 모든 변경 라인 선택 상태를 바꾼다. */
  function setHunkLineSelection(file, hunk, checked) {
    const item = fileSelection(file);
    for (const id of changeLineIds(hunk)) {
      if (checked) {
        item.lineIds.add(id);
      } else {
        item.lineIds.delete(id);
      }
    }
    render(currentFiles);
  }

  /** 변경 라인 하나의 선택 상태를 바꾼다. */
  function setLineSelection(file, id, checked) {
    setLineIdsSelection(file, [id], checked);
  }

  /** 변경 라인 여러 개의 선택 상태를 바꾼다. */
  function setLineIdsSelection(file, ids, checked) {
    const item = fileSelection(file);
    if (!ids || !ids.length) {
      return;
    }
    for (const id of ids) {
      if (!id) {
        continue;
      }
      if (checked) {
        item.lineIds.add(id);
      } else {
        item.lineIds.delete(id);
      }
    }
    activeMetaEl.textContent = activeFile()
      ? `${T.headWorkingTree} · ${activeFile().hunks.length} ${T.hunks} · ` +
        `${selectedCount(activeFile())} ${T.selected}`
      : "";
    updateFooter();
  }

  /** hunk 헤더에서 사람이 읽을 제목을 만든다. */
  function hunkTitle(line, ordinal) {
    const match = /^@@\s+[-+0-9, ]+@@\s*(.*)$/.exec(line);
    const suffix = match && match[1] ? ` · ${match[1]}` : "";
    return `${T.hunk} ${ordinal}${suffix}`;
  }

  /** hunk 추가/삭제 줄 수. */
  function hunkStats(lines) {
    let add = 0;
    let del = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith("+")) {
        add++;
      } else if (line.startsWith("-")) {
        del++;
      }
    }
    return { add, del };
  }

  /** 현재 활성 파일의 모든 hunk/binary 를 선택하거나 해제한다. */
  function setActiveFileSelection(checked) {
    const file = currentFiles.find((item) => fileKey(item) === activeKey);
    if (!file) {
      return;
    }
    const item = fileSelection(file);
    item.binary = file.binary ? checked : false;
    item.hunkIds.clear();
    item.lineIds = new Set(checked ? file.hunks.flatMap(changeLineIds) : []);
    selected.set(fileKey(file), item);
    render(currentFiles);
  }

  /** 확장으로 보낼 선택 정보를 만든다. */
  function collectSelections() {
    const selections = [];
    for (const file of currentFiles) {
      const item = selected.get(fileKey(file));
      if (!item) {
        continue;
      }
      if (file.binary && item.binary) {
        selections.push({
          stage: file.stage,
          path: file.path,
          hunkIds: [],
          binary: true,
        });
      } else if (!file.binary && item.hunkIds.size) {
        selections.push({
          stage: file.stage,
          path: file.path,
          hunkIds: Array.from(item.hunkIds),
          lineIds: Array.from(item.lineIds),
          binary: false,
        });
      } else if (!file.binary && item.lineIds.size) {
        selections.push({
          stage: file.stage,
          path: file.path,
          hunkIds: [],
          lineIds: Array.from(item.lineIds),
          binary: false,
        });
      }
    }
    return selections;
  }

  /** 하단 커밋 바 상태를 갱신한다. */
  function updateFooter() {
    const count = totalSelectedCount();
    summaryEl.textContent = fmt(T.selectedSummary, count);
    commitBtn.disabled = count === 0;
    discardBtn.disabled = count === 0;
  }

  /** 현재 활성 파일 객체를 반환한다. */
  function activeFile() {
    return currentFiles.find((item) => fileKey(item) === activeKey);
  }

  /** 경로에서 파일명만 뽑는다. */
  function baseName(path) {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  /** 경로에서 디렉터리만 뽑는다. */
  function dirName(path) {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
  }

  /** 파일 목록/선택 맵에서 쓰는 staged/unstaged 구분 키. */
  function fileKey(file) {
    return `${file.stage}:${file.path}`;
  }

  /** hunk 내부 변경 라인 id 목록. */
  function changeLineIds(hunk) {
    return hunk.text
      .split("\n")
      .slice(1)
      .flatMap((line, index) =>
        line.startsWith("+") || line.startsWith("-") ? [lineId(hunk, index)] : []
      );
  }

  /** hunk body line 의 안정적 id. */
  function lineId(hunk, index) {
    return `${hunk.id}:${index}`;
  }

  /** hunk 헤더에서 이전/변경 후 쪽 시작 줄 번호를 읽는다. */
  function hunkStartLine(header, side) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    if (!match) {
      return 1;
    }
    return Number(side === "old" ? match[1] : match[2]);
  }

  /** 줄 번호 표시 문자열. 새 파일/삭제 파일의 0번 줄은 빈칸으로 표시한다. */
  function lineNumber(no) {
    return no > 0 ? String(no) : "";
  }

  /** line id 배열을 dataset 에 안전하게 넣기 위해 인코딩한다. */
  function encodeLineIds(ids) {
    return encodeURIComponent(JSON.stringify(ids || []));
  }

  /** dataset 에 들어간 line id 배열을 복원한다. */
  function decodeLineIds(value) {
    try {
      return JSON.parse(decodeURIComponent(value || "%5B%5D"));
    } catch {
      return [];
    }
  }

  /** 현재 오른쪽 editable diff 셀의 내용을 전체 파일 문자열로 조립한다. */
  function collectEditedWorkingText() {
    const cells = Array.from(hunksEl.querySelectorAll(".right-edit"));
    if (!cells.length) {
      return workingText;
    }
    const text = cells.map((cell) => cell.textContent || "").join("\n");
    return workingHadFinalNewline ? text + "\n" : text;
  }

  /** 파일 내용을 diff 계산용 라인 배열로 바꾼다. */
  function textLines(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }

  /** 전체 파일 좌/우 텍스트와 hunk line id 를 합쳐 editable diff row 를 만든다. */
  function buildEditableDiffRows(file, baseText, changedText) {
    const oldLines = textLines(baseText);
    const newLines = textLines(changedText);
    const maps = hunkLineMaps(file);
    const ops = lineDiff(oldLines, newLines);
    const rows = [];
    let index = 0;
    while (index < ops.length) {
      const op = ops[index];
      if (op.type === "equal") {
        rows.push({
          kind: "context",
          oldNo: op.oldNo,
          newNo: op.newNo,
          leftText: op.text,
          rightText: op.text,
          leftKind: "context",
          rightKind: "context",
          lineIds: [],
        });
        index++;
        continue;
      }
      const deletions = [];
      const additions = [];
      while (index < ops.length && ops[index].type !== "equal") {
        if (ops[index].type === "delete") {
          deletions.push(ops[index]);
        } else {
          additions.push(ops[index]);
        }
        index++;
      }
      const count = Math.max(deletions.length, additions.length);
      for (let row = 0; row < count; row++) {
        const del = deletions[row];
        const add = additions[row];
        const ids = add
          ? maps.added.get(add.newNo) || []
          : del
            ? maps.deleted.get(del.oldNo) || []
            : [];
        rows.push({
          kind: add && del ? "change" : add ? "insert" : "delete",
          oldNo: del ? del.oldNo : 0,
          newNo: add ? add.newNo : 0,
          leftText: del ? del.text : "",
          rightText: add ? add.text : "",
          leftKind: del ? "del" : "empty",
          rightKind: add ? "add" : "empty",
          lineIds: ids,
        });
      }
    }
    return rows;
  }

  /** hunk line id 를 변경 후 줄 번호/이전 줄 번호 기준으로 찾을 수 있게 만든다. */
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
            for (const del of dels) {
              deleted.set(del.no, [lineId(hunk, del.index)]);
            }
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

  /** LCS 기반의 단순 line diff. */
  function lineDiff(oldLines, newLines) {
    const n = oldLines.length;
    const m = newLines.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          oldLines[i] === newLines[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && oldLines[i] === newLines[j]) {
        ops.push({
          type: "equal",
          text: oldLines[i],
          oldNo: i + 1,
          newNo: j + 1,
        });
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

  /** stage 표시 라벨. */
  function stageLabel(stage) {
    return stage === "staged" ? T.staged : T.unstaged;
  }

  filterEl.addEventListener("input", () => render(currentFiles));
  refreshBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "refresh" })
  );
  selectedOnlyBtn.addEventListener("click", () => {
    selectedOnly = !selectedOnly;
    selectedOnlyBtn.classList.toggle("active", selectedOnly);
    render(currentFiles);
  });
  selectFileBtn.addEventListener("click", () => setActiveFileSelection(true));
  clearFileBtn.addEventListener("click", () => setActiveFileSelection(false));
  openFileBtn.addEventListener("click", () => {
    const file = activeFile();
    if (file) {
      vscode.postMessage({ type: "openFile", path: file.path });
    }
  });
  if (saveWorkingFileBtn) {
    saveWorkingFileBtn.addEventListener("click", () => {
      if (!workingPath) {
        return;
      }
      saveWorkingFileBtn.disabled = true;
      vscode.postMessage({
        type: "saveFile",
        path: workingPath,
        content: collectEditedWorkingText(),
      });
    });
  }

  commitBtn.addEventListener("click", () => {
    const selections = collectSelections();
    if (!selections.length) {
      updateFooter();
      return;
    }
    commitBtn.disabled = true;
    discardBtn.disabled = true;
    vscode.postMessage({ type: "stage", selections });
  });

  discardBtn.addEventListener("click", () => {
    const selections = collectSelections();
    if (!selections.length) {
      updateFooter();
      return;
    }
    commitBtn.disabled = true;
    discardBtn.disabled = true;
    vscode.postMessage({ type: "discard", selections });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "changes") {
      noticeEl.textContent = "";
      render(msg.files, msg.focus, msg.singleFile, msg.workingFile);
    } else if (msg.type === "staged") {
      noticeEl.textContent = msg.message || T.stagedSelected;
      selected = new Map();
      updateFooter();
    } else if (msg.type === "discarded") {
      noticeEl.textContent = msg.message || T.discardedSelected;
      selected = new Map();
      updateFooter();
    } else if (msg.type === "saved") {
      noticeEl.textContent = msg.message || T.workingFileSaved;
      workingDirty = false;
      updateEditorState();
    } else if (msg.type === "error") {
      noticeEl.textContent = msg.message || "";
      commitBtn.disabled = false;
      updateFooter();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
