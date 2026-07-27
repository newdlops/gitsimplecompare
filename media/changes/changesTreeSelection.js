// Changes 작업트리 파일/폴더의 다중 선택과 마퀴 선택 상태.
// - DOM 선택, Ctrl/Cmd·Shift 범위 선택, 파일 열기 의도를 메인 renderer의 HTML 생성과 분리한다.
(function () {
  "use strict";

  /** root와 path helper를 주입해 작업트리 선택 API를 만든다. */
  window.__gscChangesTreeSelection = function createChangesTreeSelection({ rootEl, closeDropdown, openWorkingPath, rowPaths }) {
    let selection = new Set();
    let selectionAnchor = null;
    let suppressNextRowClick = false;
    let marquee = null;
    const MARQUEE_EXCLUDE_SELECTOR = ".commit-box, .group-header, .header-actions, .row-actions, button, textarea, input, select, a";

    /** 행의 그룹과 path를 조합한 안정적인 선택 key를 반환한다. */
    function rowKey(row) {
      const group = row.closest(".group");
      return `${group ? group.dataset.gkey : ""}:${row.dataset.path}`;
    }

    /** 작업트리에서 선택 가능한 파일·폴더 행을 DOM 순서대로 반환한다. */
    function selectableRows() {
      return Array.from(rootEl.querySelectorAll(".wt-files .row.file, .wt-files .row.folder"));
    }

    /** 드래그가 가능한 Changes 본문에 마퀴 선택 pointer lifecycle을 연결한다. */
    function bindMarqueeSelection(filesEl) {
      filesEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(MARQUEE_EXCLUDE_SELECTOR)) return;
        marquee = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          additive: event.metaKey || event.ctrlKey,
          baseSelection: new Set(selection),
          active: false,
          box: null,
          lastKey: null,
        };
      });
      filesEl.addEventListener("pointermove", (event) => {
        if (!marquee || marquee.pointerId !== event.pointerId) return;
        const dx = event.clientX - marquee.startX;
        const dy = event.clientY - marquee.startY;
        if (!marquee.active && Math.hypot(dx, dy) < 4) return;
        event.preventDefault();
        if (!marquee.active) startMarquee(filesEl, event.pointerId);
        updateMarquee(event.clientX, event.clientY);
      });
      filesEl.addEventListener("pointerup", (event) => finishMarquee(filesEl, event));
      filesEl.addEventListener("pointercancel", (event) => cancelMarquee(filesEl, event));
    }

    /** 선택 상자를 만들고 기존 드롭다운을 닫는다. */
    function startMarquee(filesEl, pointerId) {
      if (!marquee) return;
      closeDropdown();
      marquee.active = true;
      filesEl.setPointerCapture(pointerId);
      marquee.box = document.createElement("div");
      marquee.box.className = "selection-marquee";
      document.body.append(marquee.box);
      document.body.classList.add("marquee-selecting");
    }

    /** 포인터 영역과 겹치는 행을 선택하고 선택 상자를 다시 배치한다. */
    function updateMarquee(x, y) {
      if (!marquee?.box) return;
      const rect = normalizedRect(marquee.startX, marquee.startY, x, y);
      Object.assign(marquee.box.style, {
        left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      });
      const hitKeys = selectableRows().filter((row) => rectsOverlap(rect, row.getBoundingClientRect())).map(rowKey);
      selection = marquee.additive ? new Set([...marquee.baseSelection, ...hitKeys]) : new Set(hitKeys);
      marquee.lastKey = hitKeys.at(-1) || null;
      applySelection();
    }

    /** 정상 종료한 드래그의 마지막 행을 Shift 범위 기준으로 보존한다. */
    function finishMarquee(filesEl, event) {
      if (!marquee || marquee.pointerId !== event.pointerId) return;
      if (marquee.active) {
        event.preventDefault();
        event.stopPropagation();
        if (marquee.lastKey) selectionAnchor = marquee.lastKey;
        blockMarqueeClick();
      }
      cleanupMarquee(filesEl, event.pointerId);
    }

    /** 취소된 드래그는 시작 시점 selection으로 되돌린다. */
    function cancelMarquee(filesEl, event) {
      if (!marquee || marquee.pointerId !== event.pointerId) return;
      if (marquee.active) {
        selection = new Set(marquee.baseSelection);
        applySelection();
        suppressNextRowClick = false;
      }
      cleanupMarquee(filesEl, event.pointerId);
    }

    /** 선택 상자와 pointer capture를 정리한다. */
    function cleanupMarquee(filesEl, pointerId) {
      if (filesEl.hasPointerCapture(pointerId)) filesEl.releasePointerCapture(pointerId);
      marquee?.box?.remove();
      document.body.classList.remove("marquee-selecting");
      marquee = null;
    }

    /** 드래그 종료 직후 browser가 발생시키는 행 click 하나를 막는다. */
    function blockMarqueeClick() {
      suppressNextRowClick = true;
      const clear = () => {
        suppressNextRowClick = false;
        window.removeEventListener("click", onClick, true);
      };
      const onClick = (event) => {
        if (event.target.closest(".wt-files")) {
          event.preventDefault();
          event.stopPropagation();
        }
        clear();
      };
      window.addEventListener("click", onClick, true);
      window.setTimeout(clear, 100);
    }

    /** 두 좌표를 겹침 검사에 쓰는 정규화된 사각형으로 바꾼다. */
    function normalizedRect(startX, startY, endX, endY) {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const right = Math.max(startX, endX);
      const bottom = Math.max(startY, endY);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }

    /** 두 client rect가 한 픽셀이라도 겹치는지 판단한다. */
    function rectsOverlap(left, right) {
      return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
    }

    /** 사라진 행을 정리하고 현재 선택을 DOM class로 반영한다. */
    function applySelection() {
      const rows = selectableRows();
      const present = new Set(rows.map(rowKey));
      selection.forEach((key) => { if (!present.has(key)) selection.delete(key); });
      rows.forEach((row) => {
        const selected = selection.has(rowKey(row));
        row.classList.toggle("selected", selected);
        row.classList.toggle("single-selected", selected && selection.size === 1);
      });
    }

    /** anchor와 target 사이의 DOM 행을 Shift 범위로 선택한다. */
    function selectRange(targetKey) {
      const keys = selectableRows().map(rowKey);
      const anchorIndex = selectionAnchor ? keys.indexOf(selectionAnchor) : -1;
      const targetIndex = keys.indexOf(targetKey);
      if (anchorIndex < 0 || targetIndex < 0) {
        selection = new Set([targetKey]);
        return;
      }
      selection = new Set(keys.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1));
    }

    /** 같은 stage group 안에서 선택된 파일·폴더가 가리키는 실제 path를 중복 없이 모은다. */
    function selectedPathsOfKind(groupKey) {
      const prefix = `${groupKey}:`;
      const rowsByKey = new Map(selectableRows().map((row) => [rowKey(row), row]));
      const paths = new Set();
      selection.forEach((key) => {
        if (!key.startsWith(prefix)) return;
        rowPaths(rowsByKey.get(key)).forEach((path) => { if (path) paths.add(path); });
      });
      return [...paths];
    }

    /** 다중 선택된 행이면 같은 group의 selection 전체를, 아니면 현재 행 path만 반환한다. */
    function actionPaths(row) {
      const groupKey = row.closest(".group")?.dataset.gkey || "";
      return selection.has(rowKey(row)) && selection.size > 1 ? selectedPathsOfKind(groupKey) : rowPaths(row);
    }

    /** 특정 행이 현재 선택 집합에 들어 있는지 반환한다. */
    function isSelected(row) {
      return selection.has(rowKey(row));
    }

    /** 컨텍스트 메뉴처럼 단일 행을 기준으로 동작해야 할 때 선택을 해당 행으로 교체한다. */
    function selectOnly(row) {
      const key = rowKey(row);
      selection = new Set([key]);
      selectionAnchor = key;
      applySelection();
    }

    /**
     * 마퀴 드래그 직후 브라우저가 덧붙이는 click을 한 번만 소비한다.
     * 폴더 행과 파일 행이 같은 선택 규칙을 써야 하므로, 외부 renderer가 내부 상태를
     * 직접 읽지 않도록 이 API로만 노출한다.
     * @returns {boolean} 이번 클릭을 취소해야 하면 true
     */
    function consumeSuppressedRowClick() {
      if (!suppressNextRowClick) {
        return false;
      }
      suppressNextRowClick = false;
      return true;
    }

    /** Ctrl/Cmd 토글·Shift 범위·일반 파일 열기를 VS Code tree 관례대로 처리한다. */
    function onWorkingRowClick(event, row) {
      if (consumeSuppressedRowClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const key = rowKey(row);
      if (event.metaKey || event.ctrlKey) {
        if (selection.has(key)) selection.delete(key);
        else selection.add(key);
        selectionAnchor = key;
        applySelection();
        return;
      }
      if (event.shiftKey) {
        selectRange(key);
        applySelection();
        return;
      }
      selection = new Set([key]);
      selectionAnchor = key;
      applySelection();
      if (row.classList.contains("file")) openWorkingPath(row.dataset.path, row.dataset.stage, row.dataset.status);
    }

    return {
      actionPaths,
      applySelection,
      bindMarqueeSelection,
      consumeSuppressedRowClick,
      isSelected,
      onWorkingRowClick,
      selectOnly,
    };
  };
}());
