// Git Graph 상세 패널의 가로/세로 splitter 동작.
// - 그래프 렌더링과 무관한 pointer·keyboard 크기 조절 상태를 graph.js 밖에서 관리한다.
(function () {
  "use strict";

  const DETAIL_MIN_W = 280;
  const DETAIL_MAX_W = 760;
  const SUMMARY_MIN_H = 96;
  const FILES_MIN_H = 120;

  /**
   * 그래프 상세 패널에 연결할 splitter controller를 만든다.
   * @param options splitter/detail DOM과 현재 drawer 여부를 읽는 함수
   * @returns 메인 splitter와 상세 내부 splitter를 각각 초기화하는 함수
   */
  function create(options) {
    const splitterEl = options.splitterEl;
    const detailEl = options.detailEl;
    const isDrawerMode = options.isDrawerMode;
    let detailSummaryHeight = 180;

    /** 메인 그래프/상세 사이 splitter의 pointer와 방향키 조작을 한 번 등록한다. */
    function initMainSplitter() {
      splitterEl.addEventListener("pointerdown", (event) => {
        if (isDrawerMode()) {
          return;
        }
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = detailEl.getBoundingClientRect().width;
        document.body.classList.add("resizing");

        const onMove = (moveEvent) => {
          setDetailWidth(startWidth + startX - moveEvent.clientX);
        };
        const onUp = () => {
          document.body.classList.remove("resizing");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      splitterEl.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? 24 : -24;
        setDetailWidth(detailEl.getBoundingClientRect().width + delta);
      });
    }

    /**
     * 상세 패널 폭을 화면 안의 허용 범위로 제한해 반영한다.
     * @param width pointer 또는 keyboard가 요청한 패널 폭
     */
    function setDetailWidth(width) {
      const maxByWindow = Math.max(DETAIL_MIN_W, Math.floor(window.innerWidth * 0.7));
      const next = clamp(width, DETAIL_MIN_W, Math.min(DETAIL_MAX_W, maxByWindow));
      detailEl.style.flexBasis = next + "px";
      detailEl.style.width = next + "px";
    }

    /** 커밋 요약/파일 목록 사이 splitter를 새 상세 DOM에 맞춰 초기화한다. */
    function initDetailSplitter() {
      const detailSplitter = detailEl.querySelector("#detail-splitter");
      const summary = detailEl.querySelector(".commit-summary");
      const shell = detailEl.querySelector(".detail-shell");
      if (!detailSplitter || !summary || !shell) {
        return;
      }

      resizeSummary(summary, shell, preferredSummaryHeight(summary, shell));
      detailSplitter.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = summary.getBoundingClientRect().height;
        document.body.classList.add("resizing");

        const onMove = (moveEvent) => {
          resizeSummary(summary, shell, startHeight + moveEvent.clientY - startY);
        };
        const onUp = () => {
          document.body.classList.remove("resizing");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      detailSplitter.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
          return;
        }
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? -18 : 18;
        resizeSummary(summary, shell, detailSummaryHeight + delta);
      });
    }

    /**
     * 요약 높이를 파일 목록의 최소 높이를 침범하지 않는 범위로 반영한다.
     * @param summary 높이를 적용할 커밋 요약 DOM
     * @param shell 상세 패널 내부 전체 DOM
     * @param height 요청된 요약 높이
     */
    function resizeSummary(summary, shell, height) {
      const max = Math.max(SUMMARY_MIN_H, shell.clientHeight - FILES_MIN_H);
      detailSummaryHeight = clamp(height, SUMMARY_MIN_H, max);
      summary.style.flexBasis = detailSummaryHeight + "px";
    }

    /**
     * 실제 커밋 요약 내용에 맞는 최초 높이를 계산한다.
     * @param summary 실제 상세 내용이 들어 있는 DOM
     * @param shell 상세 패널 전체 높이를 제공하는 DOM
     * @returns 최소 요약/파일 영역을 모두 보존하는 초기 높이
     */
    function preferredSummaryHeight(summary, shell) {
      const max = Math.max(SUMMARY_MIN_H, shell.clientHeight - FILES_MIN_H);
      return clamp(summary.scrollHeight + 2, SUMMARY_MIN_H, max);
    }

    return { initDetailSplitter, initMainSplitter };
  }

  /** 숫자를 주어진 최솟값과 최댓값 사이로 제한한다. */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  window.GscGraphDetailResize = { create };
})();
