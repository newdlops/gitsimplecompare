// 작은 host delta를 기존 renderer들이 사용하는 전체 모델로 복원하며 실제 DOM은 변경 부분만 갱신한다.
(function () {
  "use strict";
  let model = { rows: [], edges: [], laneCount: 1 }, revision = 0, waiting = false;

  /** 누락된 revision은 패널의 현재 모델을 재게시하도록 한 번만 요청하고 불완전한 패치는 표시하지 않는다. */
  function resync() {
    if (!waiting) { waiting = true; window.GscGraphPostMessage?.({ type: "resyncGraph" }); }
  }

  /**
   * 기존 graph 수신자보다 먼저 delta를 복원해 같은 프로토콜/행 관계를 유지한다.
   * @param event host에서 전달한 전체 snapshot 또는 revision이 붙은 증분 메시지
   */
  function handleMessage(event) {
    const message = event.data;
    if (message?.type === "graph") {
      model = message.data; revision = message.revision ?? 0; waiting = false; return;
    }
    if (message?.type !== "graphDelta") return;
    event.stopImmediatePropagation();
    const delta = message.delta;
    if (!delta || delta.baseRevision !== revision || delta.revision <= revision ||
      delta.rowStart !== model.rows.length || delta.edgeStart !== model.edges.length ||
      !Array.isArray(delta.rows) || !Array.isArray(delta.edges) ||
      !Array.isArray(delta.rowUpdates) || !Array.isArray(delta.edgeUpdates) ||
      !Number.isInteger(delta.laneCount) || delta.laneCount < 1 ||
      delta.rowUpdates.some(item => !Number.isInteger(item.index) || item.index < 0 || item.index >= delta.rowStart || item.row?.hash !== model.rows[item.index]?.hash) ||
      delta.edgeUpdates.some(item => !Number.isInteger(item.index) || item.index < 0 || item.index >= delta.edgeStart)) {
      resync(); return;
    }
    const rows = [...model.rows, ...delta.rows], edges = [...model.edges, ...delta.edges];
    for (const item of delta.rowUpdates) rows[item.index] = item.row;
    for (const item of delta.edgeUpdates) edges[item.index] = item.edge;
    model = { rows, edges, laneCount: delta.laneCount }; revision = delta.revision;
    // 원래 메시지를 다시 전달하지 않아 observer는 정확히 한 번만 같은 완성 모델을 받는다.
    window.dispatchEvent(new MessageEvent("message", { data: { ...message, type: "graph", data: model, revision } }));
  }

  /** 추가 페이지는 기존 SVG/행을 유지하고 전체 snapshot만 기존 DOM을 지운다. */
  function prepare(root, delta) {
    const svg = root.querySelector("svg");
    const last = delta?.rowStart ? root.querySelector(`:scope > .row[data-index="${delta.rowStart - 1}"]:not([data-reflog-virtual])`) : null;
    if (!delta || !svg?.__gscEdgeElements || (delta.rowStart && !last)) { root.innerHTML = ""; return false; }
    root.querySelector("#graph-tail")?.remove();
    root.querySelectorAll("[data-reflog-virtual]").forEach(node => node.remove());
    return true;
  }

  /** SVG가 이미 첫 위치에 있으면 이동하지 않아 keyboard focus와 hover 상태를 유지한다. */
  function placeSvg(root, svg) { if (root.firstChild !== svg) root.prepend(svg); }

  /** 이미 있는 행은 유지하고 변경 행 교체·신규 행 추가·폭 변경만 반영한다. */
  function renderRows(root, rows, width, build, delta) {
    if (!delta) { rows.forEach((row, index) => root.appendChild(build(row, index, width))); return; }
    const existing = new Map([...root.querySelectorAll(":scope > .row:not([data-reflog-virtual])")].map(node => [Number(node.dataset.index), node]));
    for (const item of delta.rowUpdates) existing.get(item.index)?.replaceWith(build(item.row, item.index, width));
    const fragment = document.createDocumentFragment();
    for (let index = delta.rowStart; index < rows.length; index++) fragment.appendChild(build(rows[index], index, width));
    root.appendChild(fragment);
    for (const node of root.querySelectorAll(":scope > .row")) if (node.style.left !== `${width}px`) node.style.left = `${width}px`;
  }

  window.addEventListener("message", handleMessage, true);
  window.GscGraphDataUpdates = { prepare, placeSvg, renderRows,
    stats: () => ({ revision, rows: model.rows.length, edges: model.edges.length, waiting }) };
})();
