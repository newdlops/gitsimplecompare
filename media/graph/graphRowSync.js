// Graph 텍스트 행의 부분 갱신과 가로 스크롤 폭 측정을 담당하는 모듈.
// - branch/tag 상태가 바뀌어도 표시가 달라진 행만 교체해, 수천 행 전체 DOM 재생성을 피한다.
// - 가로 폭은 다음 animation frame 으로 모아 한 번만, 글자 수가 긴 후보 행만 측정해 강제 reflow 를 줄인다.
(function () {
  "use strict";

  /** 폭 측정 후보로 삼을 가장 긴 행 수. 배지 padding 차이를 감안해 여유 있게 잡는다. */
  const WIDTH_CANDIDATES = 24;

  /**
   * 행 동기화 API 를 만든다.
   * @param {object} deps graph.js 가 소유한 DOM 과 행 생성 함수
   * @param {HTMLElement} deps.graphEl 스크롤 컨테이너
   * @param {HTMLElement} deps.graphContentEl 행과 SVG 를 담는 캔버스
   * @param {(row: object, index: number, leftInset: number) => HTMLElement} deps.buildRow 행 DOM 생성 함수
   * @param {(row: object) => string} deps.rowRenderKey 행 표시가 같은지 비교할 key 계산 함수
   * @param {() => { graphWidth: number }} deps.layout 현재 그래프 폭을 돌려주는 함수
   * @returns {{ patchRows(rows: object[]): number, scheduleScrollableWidth(): void }} 행 동기화 API
   */
  window.GscGraphRowSync = function createGraphRowSync(deps) {
    const { graphEl, graphContentEl } = deps;
    let widthFrame = 0;

    /**
     * 현재 행 데이터와 DOM 행을 비교해 표시가 달라진 행만 새로 만든다.
     * - 행 순서·hash 가 다르거나 render key(배지 HTML·색·local-only·선택 상태)가 다르면 교체한다.
     * @param {object[]} rows 마지막 graph payload 의 행 데이터
     * @returns {number} 교체한 행 수
     */
    function patchRows(rows) {
      const graphWidth = deps.layout().graphWidth;
      let replaced = 0;
      graphContentEl.querySelectorAll(":scope > .row").forEach((element) => {
        const index = Number(element.dataset.index);
        const row = rows[index];
        if (!row) {
          element.remove();
          return;
        }
        if (row.hash === element.dataset.hash && deps.rowRenderKey(row) === element.dataset.renderKey) {
          return;
        }
        element.replaceWith(deps.buildRow(row, index, graphWidth));
        replaced++;
      });
      scheduleScrollableWidth();
      return replaced;
    }

    /** 다음 frame 에 가로 스크롤 폭을 한 번 측정하도록 예약한다(연속 호출은 합친다). */
    function scheduleScrollableWidth() {
      if (widthFrame) {
        return;
      }
      widthFrame = window.requestAnimationFrame(() => {
        widthFrame = 0;
        syncScrollableWidth();
      });
    }

    /**
     * 행 내용이 가로로 길 때 캔버스 폭을 가장 긴 행에 맞춰 넓힌다.
     * - 모든 행의 scrollWidth 를 읽지 않고, 글자 수가 긴 후보 행만 측정한다(글자 수는 layout 없이 읽힌다).
     */
    function syncScrollableWidth() {
      const graphWidth = deps.layout().graphWidth;
      const rowsRight = widestCandidates().reduce(
        (max, row) => Math.max(max, row.offsetLeft + row.scrollWidth + 24),
        0
      );
      const width = Math.max(graphEl.clientWidth, rowsRight, graphWidth + 680);
      if (width > 0) {
        graphContentEl.style.width = width + "px";
        graphContentEl.style.minWidth = width + "px";
      }
    }

    /** 텍스트가 가장 긴 행 몇 개를 고른다. */
    function widestCandidates() {
      const scored = [];
      graphContentEl.querySelectorAll(":scope > .row").forEach((row) => {
        const length = row.textContent.length + row.childElementCount * 2;
        if (scored.length < WIDTH_CANDIDATES) {
          scored.push({ row, length });
          scored.sort((a, b) => a.length - b.length);
        } else if (length > scored[0].length) {
          scored[0] = { row, length };
          scored.sort((a, b) => a.length - b.length);
        }
      });
      return scored.map((entry) => entry.row);
    }

    return { patchRows, scheduleScrollableWidth };
  };
})();
