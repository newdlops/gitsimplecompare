// 그래프 refresh 중 사용자가 보고 있던 viewport 위치를 보존하는 클라이언트 헬퍼.
// - git 상태 변화로 그래프가 reset 렌더링되어도 첫 번째 보이는 row 를 기준으로 스크롤을 복원한다.
(function () {
  "use strict";

  const ROW_SELECTOR = ".row[data-hash]:not([data-reflog-virtual])";

  /** CSS selector 에 넣을 값을 이스케이프한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  /**
   * renderer가 고정 높이와 전역 inline top을 보증하면 layout 없이 위치를 읽는다.
   * @param row 현재 모델의 실제 행
   * @param rowHeight renderer의 고정 높이. 생략한 기존 호출은 Native geometry를 유지한다.
   * @returns CSS pixel 기준 전역 top. 임의 CSS 위치는 기존 offsetTop으로 확인한다.
   */
  function rowTop(row, rowHeight) {
    if (Number.isFinite(rowHeight) && rowHeight > 0 && /^-?\d+(?:\.\d+)?px$/.test(row.style.top)) {
      return parseFloat(row.style.top);
    }
    return row.offsetTop;
  }

  /**
   * 현재 viewport 의 기준 row 와 row 내부 offset 을 캡처한다.
   * @param graphEl 스크롤 컨테이너
   * @param graphContent 그래프 row 를 담는 컨테이너
   * @param rowHeight renderer가 보증하는 고정 높이. 제공되면 화면 밖 행의 layout을 강제하지 않는다.
   * @returns 복원에 필요한 anchor. 렌더링된 row 가 없으면 null
   */
  function capture(graphEl, graphContent, rowHeight) {
    if (!graphEl || !graphContent) {
      return null;
    }
    const rows = Array.from(graphContent.querySelectorAll(ROW_SELECTOR));
    if (rows.length === 0) {
      return null;
    }
    const top = graphEl.scrollTop;
    const knownHeight = Number.isFinite(rowHeight) && rowHeight > 0;
    const visible = rows.find(row => rowTop(row, rowHeight) + (knownHeight ? rowHeight : row.offsetHeight) > top) || rows[0];
    return {
      hash: visible.dataset.hash || "",
      offset: rowTop(visible, rowHeight) - top,
      scrollTop: top,
      scrollLeft: graphEl.scrollLeft,
    };
  }

  /**
   * 새로 렌더링된 그래프에서 캡처된 viewport anchor 를 복원한다.
   * @param graphEl 스크롤 컨테이너
   * @param graphContent 그래프 row 를 담는 컨테이너
   * @param anchor capture 가 반환한 기준 위치
   * @param rowHeight capture와 같은 renderer 높이. 생략하면 기존 Native 위치를 사용한다.
   * @returns 스크롤 복원을 시도했으면 true
   */
  function restore(graphEl, graphContent, anchor, rowHeight) {
    if (!graphEl || !graphContent || !anchor) {
      return false;
    }
    const row = anchor.hash
      ? graphContent.querySelector(`.row[data-hash="${cssEscape(anchor.hash)}"]`)
      : null;
    const wantedTop = row ? rowTop(row, rowHeight) - anchor.offset : anchor.scrollTop;
    const maxTop = Math.max(0, graphEl.scrollHeight - graphEl.clientHeight);
    const maxLeft = Math.max(0, graphEl.scrollWidth - graphEl.clientWidth);
    graphEl.scrollTop = Math.min(Math.max(0, wantedTop), maxTop);
    graphEl.scrollLeft = Math.min(Math.max(0, anchor.scrollLeft || 0), maxLeft);
    return true;
  }

  window.GscGraphViewport = { capture, restore };
})();
