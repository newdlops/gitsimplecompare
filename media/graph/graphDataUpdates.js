// 작은 host delta를 기존 renderer들이 사용하는 전체 모델로 복원하며 실제 DOM은 변경 부분만 갱신한다.
(function () {
  "use strict";
  let model = { rows: [], edges: [], laneCount: 1 }, revision = 0, waiting = false, colorScope;

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
      model = message.data; revision = message.revision ?? 0; waiting = false; colorScope = message.state?.colorScope; return;
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
    if (!waiting && canUpdateOnlyState(delta, message.state)) {
      // 모델은 유지하되 revision과 마지막 상태의 paint ACK는 반드시 전진시킨다.
      revision = delta.revision;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "graphLoadState", state: message.state,
        performance: message.performance, fromGraphDelta: true } }));
      return;
    }
    const rows = [...model.rows, ...delta.rows], edges = [...model.edges, ...delta.edges];
    for (const item of delta.rowUpdates) rows[item.index] = item.row;
    for (const item of delta.edgeUpdates) edges[item.index] = item.edge;
    model = { rows, edges, laneCount: delta.laneCount }; revision = delta.revision; colorScope = message.state?.colorScope;
    // 원래 메시지를 다시 전달하지 않아 observer는 정확히 한 번만 같은 완성 모델을 받는다.
    window.dispatchEvent(new MessageEvent("message", { data: { ...message, type: "graph", data: model, revision } }));
  }

  /**
   * 검증된 빈 delta만 상태 갱신으로 전달한다. 저장소 색상·reset·빈 화면·레인 변화는 원래 렌더로 보낸다.
   * @param delta revision/배열 경계를 검증한 host 데이터 @param state 현재 loading·오류·표시 범위 상태
   * @returns 현재 행/간선/저장소 의미가 그대로여서 데이터 소비자를 다시 실행할 필요가 없으면 true
   */
  function canUpdateOnlyState(delta, state) {
    return model.rows.length > 0 && state && !state.reset && state.colorScope === colorScope && delta.laneCount === model.laneCount &&
      !delta.rows.length && !delta.edges.length && !delta.rowUpdates.length && !delta.edgeUpdates.length;
  }

  /**
   * 추가 페이지는 기존 SVG/행을 유지하고 전체 snapshot만 기존 DOM을 지운다.
   * @param root 현재 Graph 캔버스 @param delta 검증된 증분 데이터 @param elementAt 기존 행 인덱스 조회 함수.
   * @returns SVG와 마지막 실제 행이 남아 있으면 true. 캐시가 없거나 분리된 행은 기존 selector로 재확인한다.
   */
  function prepare(root, delta, elementAt) {
    const svg = root.querySelector("svg");
    const cached = delta?.rowStart ? elementAt?.(delta.rowStart - 1) : null;
    const last = cached?.parentElement === root && cached.classList.contains("row") &&
      Number(cached.dataset.index) === delta.rowStart - 1 && !cached.hasAttribute("data-reflog-virtual") ? cached
      : delta?.rowStart ? root.querySelector(`:scope > .row[data-index="${delta.rowStart - 1}"]:not([data-reflog-virtual])`) : null;
    if (!delta || !svg?.__gscEdgeElements || (delta.rowStart && !last)) { root.innerHTML = ""; return false; }
    root.querySelector("#graph-tail")?.remove();
    root.querySelectorAll("[data-reflog-virtual]").forEach(node => node.remove());
    return true;
  }

  /** SVG가 이미 첫 위치에 있으면 이동하지 않아 keyboard focus와 hover 상태를 유지한다. */
  function placeSvg(root, svg) { if (root.firstChild !== svg) root.prepend(svg); }

  /** @param elementAt 기존 행 인덱스 조회 함수. 이미 있는 행을 유지하고 변경·추가 행과 실제 레인 폭 변화만 반영한다. */
  function renderRows(root, rows, width, build, delta, elementAt) {
    if (!delta) {
      const fragment = document.createDocumentFragment();
      rows.forEach((row, index) => fragment.appendChild(build(row, index, width)));
      root.appendChild(fragment);
      return;
    }
    const previousWidth = root.querySelector(":scope > .row")?.style.left;
    for (const item of delta.rowUpdates) {
      const existing = elementAt?.(item.index) || root.querySelector(`:scope > .row[data-index="${item.index}"]:not([data-reflog-virtual])`);
      existing?.replaceWith(build(item.row, item.index, width));
    }
    const fragment = document.createDocumentFragment();
    for (let index = delta.rowStart; index < rows.length; index++) fragment.appendChild(build(rows[index], index, width));
    root.appendChild(fragment);
    if (previousWidth !== `${width}px`) {
      for (const node of root.querySelectorAll(":scope > .row")) if (node.style.left !== `${width}px`) node.style.left = `${width}px`;
    }
  }

  /** @param left 이전 배열 @param right 새 배열 @returns 색상 선택에 쓰는 이름/부모 순서가 같으면 true */
  function equalValues(left, right) {
    return (left || []).length === (right || []).length && (left || []).every((value, index) => value === right[index]);
  }

  /**
   * HEAD·제목 등 표시만 바뀐 delta에서만 색상 캐시와 local-only 전파를 재사용한다.
   * @param delta 검증된 증분 데이터 @param previous 이전 전체 모델 @param next 새 전체 모델
   * @returns 레인·간선·부모·브랜치 의미 입력이 모두 같으면 true. 추가/재배치/compact 변경은 기존 경로로 보낸다.
   */
  function reusableColors(delta, previous, next) {
    if (!delta || delta.rows.length || delta.edges.length || delta.edgeUpdates.length || previous.laneCount !== next.laneCount ||
      previous.rows.length !== next.rows.length || previous.edges.length !== next.edges.length) return false;
    return delta.rowUpdates.every(({ index, row }) => {
      const before = previous.rows[index];
      return before && ["hash", "column", "color", "kind", "originalColumn", "compacted"].every(key => before[key] === row[key]) &&
        equalValues(before.parents, row.parents) && equalValues(before.localOnlyBranches, row.localOnlyBranches) &&
        equalValues((before.refs || []).filter(ref => ref !== "HEAD"), (row.refs || []).filter(ref => ref !== "HEAD"));
    });
  }

  window.addEventListener("message", handleMessage, true);
  window.GscGraphDataUpdates = { prepare, placeSvg, renderRows, reusableColors,
    stats: () => ({ revision, rows: model.rows.length, edges: model.edges.length, waiting }) };
})();
