// Graph DOM render와 실제 frame 사이 시간을 extension host에 되돌리는 브라우저 모듈.
(function () {
  "use strict";
  let renderGeneration = 0;

  /**
   * renderGraph 직후 두 animation frame을 기다려 compositor에 제출될 수 있는 paint 경계를 보고한다.
   * @param vscode acquireVsCodeApi 반환 객체
   * @param performance extension이 graph 메시지에 붙인 trace metadata
   * @param receivedAt webview message handler 진입 시각
   * @param renderedAt 동기 DOM 생성이 끝난 시각
   */
  function report(vscode, performance, receivedAt, renderedAt) {
    const generation = ++renderGeneration;
    if (!performance || !vscode?.postMessage) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // 다음 Graph payload가 이미 DOM을 교체했다면 이전 payload의 paint로 잘못 기록하지 않는다.
      if (generation !== renderGeneration) return;
      vscode.postMessage({
        type: "graphRendered",
        performance,
        receivedAt,
        renderedAt,
        paintedAt: Date.now(),
      });
    }));
  }

  window.GscGraphPerformance = { report };
})();
