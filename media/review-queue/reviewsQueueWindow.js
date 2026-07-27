// Reviews sidebar의 lane별 점진 렌더링 helper.
// - 큰 GitHub queue의 모든 행을 첫 paint에 DOM으로 만들지 않고, 사용자가 명시적으로 더 보기를 선택할 때만 확장한다.
(function () {
  "use strict";

  const INITIAL_ROWS = 20;
  const ROW_INCREMENT = 20;

  /** shared state와 DOM 도우미를 받아 lane별 visible window API를 만든다. */
  window.__gscReviewsQueueWindow = function createReviewsQueueWindow(deps) {
    const { T, state, element, actionButton, render, template } = deps;

    /** 현재 lane에서 DOM으로 만들 row만 반환하며, 깨진 persisted 값은 안전한 기본값으로 교정한다. */
    function visible(lane, rows) {
      return rows.slice(0, limit(lane));
    }

    /** 아직 표시하지 않은 결과가 있을 때만 다음 묶음을 렌더링하는 explicit action을 만든다. */
    function renderControl(lane, total) {
      const remaining = Math.max(0, total - limit(lane));
      if (!remaining) return document.createDocumentFragment();
      const count = Math.min(ROW_INCREMENT, remaining);
      const control = element("div", "reviews__queue-window");
      control.append(
        actionButton(
          "gsc-button gsc-button--ghost",
          template(T.showMorePullRequests, count),
          () => showMore(lane)
        )
      );
      return control;
    }

    /** 한 lane의 노출 범위를 다음 고정 묶음만큼 늘리고, queue 데이터 자체는 다시 읽지 않는다. */
    function showMore(lane) {
      windows()[lane] = limit(lane) + ROW_INCREMENT;
      render();
    }

    /** 검색·정렬·상태 filter가 바뀌면 새 결과를 첫 묶음부터 다시 보이게 한다. */
    function reset() {
      state.queueWindows = {};
    }

    /** webview restore 후에도 lane별 positive integer window만 신뢰한다. */
    function limit(lane) {
      const value = Number(windows()[lane]);
      return Number.isInteger(value) && value > 0 ? value : INITIAL_ROWS;
    }

    /** persisted state 안의 lane -> visible row count 맵을 지연 초기화한다. */
    function windows() {
      if (!state.queueWindows || typeof state.queueWindows !== "object") state.queueWindows = {};
      return state.queueWindows;
    }

    return { visible, renderControl, reset };
  };
}());
