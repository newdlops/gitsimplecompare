// Reviews 큐의 roving-tabindex와 키보드 탐색.
// - 개인/관리 큐의 PR 열기 키는 공유하고, 다중 선택 키는 관리 행에서만 활성화한다.
// - 재렌더가 일어나는 범위 선택 뒤에도 같은 PR 행에 포커스를 되돌린다.
(function () {
  "use strict";

  /** Reviews main renderer가 현재 DOM에 연결할 키보드 controller를 만든다. */
  window.__gscReviewsQueueKeyboard = function createReviewsQueueKeyboard({ root, toggleManagementSelection, dismissManagementInteraction }) {
    /** 현재 렌더된 모든 PR button을 DOM 순서대로 찾는다. */
    function rows() {
      return Array.from(root.querySelectorAll(".reviews__pr[data-review-key]"));
    }

    /** 같은 queue의 다른 행은 Tab 순서에서 빼고 현재 행만 진입점으로 남긴다. */
    function setRovingTabstop(active) {
      rows().forEach((row) => { row.tabIndex = row === active ? 0 : -1; });
    }

    /** re-render 뒤 안정 key로 다시 찾아 focus한다. */
    function restoreFocus(key) {
      requestAnimationFrame(() => {
        const next = rows().find((row) => row.dataset.reviewKey === key);
        if (!next) return;
        setRovingTabstop(next);
        next.focus({ preventScroll: true });
      });
    }

    /** Arrow/Home/End 로 이동할 대상 행을 구한다. */
    function nextRow(current, key) {
      const all = rows();
      const index = all.indexOf(current);
      if (index < 0 || !all.length) return undefined;
      if (key === "Home") return all[0];
      if (key === "End") return all[all.length - 1];
      if (key === "ArrowUp") return all[(index + all.length - 1) % all.length];
      if (key === "ArrowDown") return all[(index + 1) % all.length];
      return undefined;
    }

    /** PR 행 하나에 open·navigate·관리 범위 선택 키를 연결한다. */
    function bindRow(row) {
      row.addEventListener("focus", () => setRovingTabstop(row));
      row.addEventListener("keydown", (event) => {
        const target = nextRow(row, event.key);
        if (target) {
          event.preventDefault();
          if (row.dataset.reviewManagement === "true" && event.shiftKey) {
            toggleAndRestore(target.dataset.reviewKey || "", true, true);
            return;
          }
          setRovingTabstop(target);
          target.focus({ preventScroll: true });
          return;
        }
        if (event.key !== " " || row.dataset.reviewManagement !== "true") return;
        event.preventDefault();
        const selected = row.dataset.reviewSelected === "true";
        toggleAndRestore(row.dataset.reviewKey || "", !selected, false);
      });
    }

    /** Escape는 현재 관리 confirmation을 먼저 닫고, 다음 Escape에서 selection만 해제한다. */
    function bindEscape() {
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || isEditable(event.target)) return;
        const focusedKey = document.activeElement?.dataset?.reviewKey || "";
        if (!dismissManagementInteraction()) return;
        event.preventDefault();
        if (focusedKey) restoreFocus(focusedKey);
      });
    }

    /** 입력 중인 검색/저장 큐 form에는 webview shortcut을 적용하지 않는다. */
    function isEditable(target) {
      return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable;
    }

    /** 관리 selection을 갱신하고 DOM 교체 뒤 현재 항목으로 복귀한다. */
    function toggleAndRestore(key, checked, range) {
      if (!key) return;
      toggleManagementSelection(key, checked, range);
      restoreFocus(key);
    }

    /** render가 끝난 후 한 번 호출해 모든 PR button을 roving group으로 만든다. */
    function bind() {
      const all = rows();
      if (!all.length) return;
      const focused = document.activeElement;
      const active = all.includes(focused) ? focused : all.find((row) => row.tabIndex === 0) || all[0];
      setRovingTabstop(active);
      all.forEach(bindRow);
    }

    bindEscape();
    return { bind };
  };
}());
