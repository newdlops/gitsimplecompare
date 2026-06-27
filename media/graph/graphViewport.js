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
   * 현재 viewport 의 기준 row 와 row 내부 offset 을 캡처한다.
   * @param graphEl 스크롤 컨테이너
   * @param graphContent 그래프 row 를 담는 컨테이너
   * @returns 복원에 필요한 anchor. 렌더링된 row 가 없으면 null
   */
  function capture(graphEl, graphContent) {
    if (!graphEl || !graphContent) {
      return null;
    }
    const rows = Array.from(graphContent.querySelectorAll(ROW_SELECTOR));
    if (rows.length === 0) {
      return null;
    }
    const top = graphEl.scrollTop;
    const visible = rows.find((row) => row.offsetTop + row.offsetHeight > top) || rows[0];
    return {
      hash: visible.dataset.hash || "",
      offset: visible.offsetTop - top,
      scrollTop: top,
      scrollLeft: graphEl.scrollLeft,
    };
  }

  /**
   * 새로 렌더링된 그래프에서 캡처된 viewport anchor 를 복원한다.
   * @param graphEl 스크롤 컨테이너
   * @param graphContent 그래프 row 를 담는 컨테이너
   * @param anchor capture 가 반환한 기준 위치
   * @returns 스크롤 복원을 시도했으면 true
   */
  function restore(graphEl, graphContent, anchor) {
    if (!graphEl || !graphContent || !anchor) {
      return false;
    }
    const row = anchor.hash
      ? graphContent.querySelector(`.row[data-hash="${cssEscape(anchor.hash)}"]`)
      : null;
    const wantedTop = row ? row.offsetTop - anchor.offset : anchor.scrollTop;
    const maxTop = Math.max(0, graphEl.scrollHeight - graphEl.clientHeight);
    const maxLeft = Math.max(0, graphEl.scrollWidth - graphEl.clientWidth);
    graphEl.scrollTop = Math.min(Math.max(0, wantedTop), maxTop);
    graphEl.scrollLeft = Math.min(Math.max(0, anchor.scrollLeft || 0), maxLeft);
    return true;
  }

  window.GscGraphViewport = { capture, restore };
})();
