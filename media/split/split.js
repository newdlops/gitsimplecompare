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
      showAllChanges: "Show All Changes",
      showSelectedChangesOnly: "Show Selected Changes Only",
      refreshChangesTooltip: "Refresh Changes",
      selectAllCurrentFile: "Select All Changes in Current File",
      clearSelectionCurrentFile: "Clear Selection in Current File",
      openCurrentFileEditableDiff: "Open Current File in Editable Diff",
      discardSelectedChanges: "Discard Selected Changes",
      stageSelectedChanges: "Stage Selected Changes",
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
  let operationBusy = false;
  const editableDiff = window.__gscSplitEditableDiff({ T, esc, hunksEl });

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

  /** 선택 항목 전용 필터 버튼의 현재 동작을 hover/스크린리더에 같은 문구로 반영한다. */
  function syncSelectedOnlyButtonTooltip() {
    const tooltip = selectedOnly
      ? T.showAllChanges
      : T.showSelectedChangesOnly;
    selectedOnlyBtn.title = tooltip;
    selectedOnlyBtn.setAttribute("aria-label", tooltip);
    selectedOnlyBtn.setAttribute("data-tooltip", tooltip);
    selectedOnlyBtn.setAttribute("aria-pressed", selectedOnly ? "true" : "false");
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
    saveWorkingFileBtn.disabled = operationBusy || !workingDirty || !workingPath;
    saveWorkingFileBtn.classList.toggle("dirty", workingDirty);
  }

  /** host operation 상태를 footer status와 모든 mutation action의 disabled 상태에 반영한다. */
  function renderOperation(state, message) {
    operationBusy = state === "loading" || state === "running";
    noticeEl.textContent = message || "";
    noticeEl.className = state ? `operation-status operation-status--${state}` : "operation-status";
    noticeEl.setAttribute("aria-busy", String(operationBusy));
    refreshBtn.disabled = operationBusy;
    selectedOnlyBtn.disabled = operationBusy;
    selectFileBtn.disabled = operationBusy;
    clearFileBtn.disabled = operationBusy;
    openFileBtn.disabled = operationBusy;
    updateEditorState();
    updateFooter();
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
    editableDiff.render({
      file,
      item,
      baseText: workingBaseText,
      workingText,
      onSelection: (ids, checked) => setLineIdsSelection(file, ids, checked),
      onDirty: () => {
        workingDirty = true;
        updateEditorState();
      },
    });
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
    commitBtn.disabled = operationBusy || count === 0;
    discardBtn.disabled = operationBusy || count === 0;
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

  /** 현재 오른쪽 editable diff 셀의 내용을 전체 파일 문자열로 조립한다. */
  function collectEditedWorkingText() {
    const cells = Array.from(hunksEl.querySelectorAll(".right-edit"));
    if (!cells.length) {
      return workingText;
    }
    const text = cells.map((cell) => cell.textContent || "").join("\n");
    return workingHadFinalNewline ? text + "\n" : text;
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
    syncSelectedOnlyButtonTooltip();
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
      render(msg.files, msg.focus, msg.singleFile, msg.workingFile);
    } else if (msg.type === "operation") {
      renderOperation(msg.state, msg.message);
    } else if (msg.type === "staged") {
      selected = new Map();
      updateFooter();
    } else if (msg.type === "discarded") {
      selected = new Map();
      updateFooter();
    } else if (msg.type === "saved") {
      workingDirty = false;
      updateEditorState();
    } else if (msg.type === "error") {
      renderOperation("error", msg.message || "");
    }
  });

  syncSelectedOnlyButtonTooltip();
  vscode.postMessage({ type: "ready" });
})();
