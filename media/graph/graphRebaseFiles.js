// rebase 상세의 전체 파일 모델을 유지하면서 화면 주변 행만 그린다.
// - 스크롤 밖 포커스 행은 pin 하고 Tab 경계에서는 다음 모델 행을 만들어 키보드 접근을 보존한다.
(function () {
  "use strict";
  const OVERSCAN = 6;
  let active = null;

  /**
   * 상세 파일 viewport에 가상 목록을 연결한다. 이전 상세의 observer/frame은 즉시 해제한다.
   * @param root 스크롤 컨테이너, files 원본 순서의 전체 파일, rowHtml 파일/index를 HTML로 바꾸는 콜백
   */
  function mount(root, files, rowHtml) {
    active?.dispose();
    if (!root || !files.length) { active = null; return; }
    const content = document.createElement("div");
    content.className = "rebase-file-window";
    root.replaceChildren(content);
    root.setAttribute("role", "list");
    root.setAttribute("aria-labelledby", "rebase-detail-files-title");
    const rendered = new Map();
    let rowHeight = 26, frame = 0;
    content.style.height = `${files.length * rowHeight}px`;

    /** 예약된 그리기를 취소하고 교체된 상세 화면의 observer와 이벤트 참조를 해제한다. */
    function dispose() {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      root.removeEventListener("scroll", schedule);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("focusout", schedule);
    }

    /** scroll/resize를 다음 프레임 한 번으로 합쳐 같은 viewport를 반복해서 만들지 않는다. */
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; render(); });
    }

    /** 보이는 범위와 포커스 행을 모델 index로 구해 기존 행을 유지하며 차이만 그린다. */
    function render() {
      if (!root.isConnected) { dispose(); return; }
      const focused = document.activeElement?.closest(".file-row[data-file-index]");
      const focusedIndex = root.contains(focused) ? Number(focused.dataset.fileIndex) : -1;
      const range = window.__gscVirtualList({ itemCount: files.length, rowHeight, overscan: OVERSCAN })
        .windowFor(root.clientHeight || 180, root.scrollTop, focusedIndex);
      const indexes = [...range.pinned];
      for (let index = range.start; index < range.end; index++) indexes.push(index);
      indexes.sort((a, b) => a - b);
      const wanted = new Set(indexes);
      for (const [index, row] of rendered) {
        if (!wanted.has(index)) { row.remove(); rendered.delete(index); }
      }
      let cursor = content.firstElementChild;
      for (const index of indexes) {
        let row = rendered.get(index);
        if (!row) {
          const template = document.createElement("template");
          template.innerHTML = rowHtml(files[index], index);
          row = template.content.firstElementChild;
          row.dataset.fileIndex = String(index);
          row.setAttribute("role", "listitem");
          row.setAttribute("aria-posinset", String(index + 1));
          row.setAttribute("aria-setsize", String(files.length));
          rendered.set(index, row);
        }
        row.style.top = `${index * rowHeight}px`;
        if (row === cursor) cursor = cursor.nextElementSibling;
        else content.insertBefore(row, cursor);
      }
    }

    /** Tab이 DOM 범위 끝에 오면 이웃 모델 행을 표시하고 포커스해 전체 파일을 순서대로 조작하게 한다. */
    function onKeyDown(event) {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const row = event.target.closest(".file-row[data-file-index]");
      if (!row) return;
      const controls = Array.from(row.querySelectorAll("button:not(:disabled),select:not(:disabled)"));
      const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
      if (event.target !== boundary) return;
      const next = Number(row.dataset.fileIndex) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= files.length) return;
      event.preventDefault();
      root.scrollTop = Math.max(0, next * rowHeight - (event.shiftKey ? 0 : root.clientHeight - rowHeight));
      render();
      const targets = rendered.get(next)?.querySelectorAll("button:not(:disabled),select:not(:disabled)");
      const target = event.shiftKey ? targets?.[targets.length - 1] : targets?.[0];
      target?.focus({ preventScroll: true });
      schedule();
    }

    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    root.addEventListener("scroll", schedule, { passive: true });
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("focusout", schedule);
    observer?.observe(root);
    active = { dispose };
    render();
    // 테마의 글꼴 크기는 첫 행만 실측한 뒤 전체 행에 같은 높이로 투영한다.
    const measured = content.firstElementChild?.getBoundingClientRect().height;
    if (measured && measured !== rowHeight) {
      rowHeight = measured;
      content.style.height = `${files.length * rowHeight}px`;
      render();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "graphRebaseClear") { active?.dispose(); active = null; }
  });
  window.GscGraphRebaseFiles = { mount };
})();
