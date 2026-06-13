// git 그래프 웹뷰의 클라이언트 스크립트(브라우저 컨텍스트에서 실행).
// - 확장에서 받은 GraphData 를 SVG(간선/노드) + 텍스트 행으로 렌더링한다.
// - 무한 스크롤로 다음 커밋 페이지를 요청하고, 상세 패널/파일 목록 영역 크기 조절을 담당한다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  window.GscGraphPostMessage = (message) => vscode.postMessage(message);

  // 레이아웃 상수(픽셀)
  const ROW_H = 30; // 한 행 높이
  const LANE_W = 20; // 레인(열) 간격
  const NODE_R = 6; // 노드 반지름
  const MARGIN = 16; // 그래프 좌측 여백
  const TAIL_H = 42; // 로딩/더 보기 행 높이
  const DETAIL_MIN_W = 280;
  const DETAIL_MAX_W = 760;
  const SUMMARY_MIN_H = 96;
  const FILES_MIN_H = 120;

  // 레인 색상 팔레트(색상 인덱스를 순환 사용)
  const COLORS = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66", "#56b6c2"];

  const graphEl = document.getElementById("graph");
  const graphContentEl = document.getElementById("graph-content");
  const detailEl = document.getElementById("detail");
  const splitterEl = document.getElementById("main-splitter");
  const backdropEl = document.getElementById("drawer-backdrop");
  const statusEl = document.getElementById("load-status");
  const toggleDetailBtn = document.getElementById("toggle-detail");
  const refreshBtn = document.getElementById("refresh-graph");
  const openRemoteBtn = document.getElementById("open-remote-branch");

  let currentRows = []; // 마지막으로 렌더링한 행 데이터(선택/상세 요청에 사용)
  let currentLaneCount = 1;
  let selectedHash = null;
  let detailSummaryHeight = 180;
  let loadState = { loadedCount: 0, hasMore: false, loading: false, reset: true };

  // SVG_NS: SVG 요소 생성용 네임스페이스
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** 레인 인덱스를 x 좌표로 변환한다. */
  function laneX(col) {
    return MARGIN + col * LANE_W;
  }

  /** 행 인덱스를 y 좌표(행 중앙)로 변환한다. */
  function rowY(row) {
    return row * ROW_H + ROW_H / 2;
  }

  /** 색상 인덱스를 팔레트 색으로 변환한다. */
  function colorOf(idx) {
    return COLORS[idx % COLORS.length];
  }

  /** 숫자를 min/max 범위 안으로 제한한다. */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /**
   * 한 간선의 SVG path d 문자열을 만든다.
   * - 자식 노드에서 부모의 레인으로 굽고, 레인을 따라 내려간 뒤 부모 노드로 굽는다.
   */
  function edgePath(edge, rowCount) {
    const fx = laneX(edge.fromColumn);
    const fy = rowY(edge.fromRow);
    const cx = laneX(edge.column);
    const toRow = Math.min(edge.toRow, rowCount); // 로드 밖이면 바닥
    const tx = laneX(edge.toColumn);
    const ty = rowY(toRow);

    let d = `M ${fx} ${fy} `;
    // 자식 -> 레인 진입(열이 다르면 반 행 높이로 굽힘)
    if (edge.fromColumn !== edge.column) {
      const my = fy + ROW_H / 2;
      d += `C ${fx} ${my}, ${cx} ${my}, ${cx} ${fy + ROW_H} `;
    }
    // 레인을 따라 부모 근처까지 직선
    const bottom = edge.toColumn !== edge.column ? ty - ROW_H : ty;
    d += `L ${cx} ${bottom} `;
    // 레인 -> 부모 노드 진입
    if (edge.toColumn !== edge.column) {
      const my = ty - ROW_H / 2;
      d += `C ${cx} ${my}, ${tx} ${my}, ${tx} ${ty} `;
    }
    return d;
  }

  /**
   * 그래프 전체(SVG 간선/노드 + 텍스트 행)를 렌더링한다.
   * @param data GraphData
   * @param state 확장에서 전달한 페이지 로딩 상태
   */
  function renderGraph(data, state) {
    applyLoadState(state, false);
    if (state && state.reset) {
      selectedHash = null;
      graphEl.scrollTop = 0;
    }

    currentRows = data.rows || [];
    currentLaneCount = data.laneCount || 1;
    graphContentEl.innerHTML = "";

    if (!currentRows.length) {
      resizeGraphContent();
      graphContentEl.innerHTML = '<p class="empty">' + (loadState.loading ? "Loading..." : "No commits.") + "</p>";
      renderLoadTail();
      updateLoadStatus();
      return;
    }

    const graphWidth = graphWidthForLaneCount(currentLaneCount);
    const bodyHeight = currentRows.length * ROW_H;
    resizeGraphContent();

    // 1) SVG: 간선 먼저, 노드 나중에(노드가 위에 오도록)
    const svg = svgEl("svg", { width: graphWidth, height: bodyHeight });
    for (const edge of data.edges) {
      svg.appendChild(
        svgEl("path", {
          d: edgePath(edge, currentRows.length),
          fill: "none",
          stroke: colorOf(edge.color),
          "stroke-width": "1.5",
        })
      );
    }
    for (let r = 0; r < currentRows.length; r++) {
      const row = currentRows[r];
      svg.appendChild(
        svgEl("circle", {
          cx: laneX(row.column),
          cy: rowY(r),
          r: NODE_R,
          fill: colorOf(row.color),
          stroke: "var(--vscode-editor-background)",
          "stroke-width": "1",
          class: window.GscGraphFeatures?.nodeClass(row) || "node",
          "data-hash": row.hash,
          "data-row": String(r),
          "data-column": String(row.column),
        })
      );
    }
    graphContentEl.appendChild(svg);

    // 2) 텍스트 행(그래프 폭만큼 왼쪽 여백)
    for (let r = 0; r < currentRows.length; r++) {
      graphContentEl.appendChild(buildRow(currentRows[r], r, graphWidth));
    }
    window.GscGraphFeatures && window.GscGraphFeatures.attachNodeDrag(graphContentEl);
    if (state && state.reset) window.GscGraphFeatures?.focusHead(graphEl, graphContentEl);
    window.GscGraphFeatures?.updateSearchIndex(graphEl, graphContentEl);

    renderLoadTail();
    updateLoadStatus();
    requestAnimationFrame(maybeLoadMore);
  }

  /** 현재 레인 수에 맞는 그래프 SVG 폭을 계산한다. */
  function graphWidthForLaneCount(laneCount) {
    return MARGIN * 2 + Math.max(laneCount, 1) * LANE_W;
  }

  /** 로딩/더 보기 행이 필요한지에 따라 그래프 내부 캔버스 높이를 계산한다. */
  function graphContentHeight() {
    const bodyHeight = currentRows.length * ROW_H;
    return bodyHeight + (loadState.loading || loadState.hasMore ? TAIL_H : 0);
  }

  /**
   * 스크롤 컨테이너는 화면 안에 고정하고, 내부 캔버스만 커밋 수만큼 키운다.
   * - 상세 패널이 긴 그래프 때문에 화면 밖으로 밀려나는 문제를 막는다.
   */
  function resizeGraphContent() {
    const graphWidth = graphWidthForLaneCount(currentLaneCount);
    graphContentEl.style.width = "100%";
    graphContentEl.style.minWidth = graphWidth + 680 + "px";
    graphContentEl.style.height = Math.max(graphContentHeight(), graphEl.clientHeight) + "px";
  }

  /**
   * 커밋 한 행의 DOM(참조 배지 + 제목 + 작성자/날짜)을 만든다.
   * @param row       GraphRow
   * @param index     행 인덱스
   * @param leftInset 그래프 폭(좌측 여백)
   */
  function buildRow(row, index, leftInset) {
    const el = document.createElement("div");
    el.className = "row" + (row.hash === selectedHash ? " selected" : "") + (row.kind ? " " + row.kind + "-row" : "");
    el.style.top = index * ROW_H + "px";
    el.style.left = leftInset + "px";
    el.style.right = "0";
    el.style.setProperty("--branch-color", colorOf(row.color));
    el.dataset.hash = row.hash;
    el.dataset.subject = row.subject || "";
    el.dataset.refs = (row.refs || []).join("\t");

    const refRenderer = window.GscGraphFeatures && window.GscGraphFeatures.refBadge;
    const refs = (row.refs || [])
      .map((ref) =>
        refRenderer ? refRenderer(ref, esc) : `<span class="ref${ref === "HEAD" ? " head" : ""}">${esc(ref)}</span>`
      )
      .join("");
    const date = formatDate(row.dateIso);
    el.innerHTML =
      refs +
      `<span class="subject">${esc(row.subject)}</span>` +
      `<span class="meta">${esc(row.authorName)} · ${esc(date)}</span>`;

    el.addEventListener("click", () => selectCommit(row.hash));
    return el;
  }

  /** ISO 날짜를 YYYY-MM-DD HH:mm 형태로 짧게 표시한다. */
  function formatDate(iso) {
    if (!iso) {
      return "";
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return iso;
    }
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  }

  /**
   * 커밋을 선택 상태로 만들고 상세를 요청한다.
   * @param hash 선택할 커밋 해시
   */
  function selectCommit(hash) {
    selectedHash = hash;
    const rows = graphContentEl.querySelectorAll(".row");
    rows.forEach((el) =>
      el.classList.toggle("selected", el.dataset.hash === hash)
    );
    vscode.postMessage({ type: "selectCommit", hash: hash });
    if (isDrawerMode()) {
      setDetailVisible(true);
    }
  }

  /**
   * 커밋 상세를 오른쪽 패널에 렌더링한다.
   * @param detail CommitDetail
   */
  function renderDetail(detail) {
    if (!window.GscGraphDetail?.render) {
      detailEl.innerHTML = `<p class="placeholder">Commit detail renderer is unavailable.</p>`;
      return;
    }
    window.GscGraphDetail.render(detail, {
      root: detailEl,
      bindSplitter: initDetailSplitter,
    });
  }

  /**
   * 확장에서 받은 로딩 상태를 반영한다.
   * @param state GraphLoadState
   * @param renderTail true 면 기존 그래프의 하단 로딩 행만 즉시 갱신한다.
   */
  function applyLoadState(state, renderTail) {
    if (!state) {
      return;
    }
    loadState = Object.assign({}, loadState, state);
    if (state.reset && state.loading) {
      selectedHash = null;
      currentRows = [];
      currentLaneCount = 1;
      graphContentEl.innerHTML = '<p class="empty">Loading...</p>';
      graphEl.scrollTop = 0;
    }
    updateLoadStatus();
    if (renderTail) {
      resizeGraphContent();
      renderLoadTail();
    }
  }

  /** 로드 상태 텍스트를 갱신한다. */
  function updateLoadStatus() {
    const loaded = loadState.loadedCount || currentRows.length;
    if (loadState.loading) {
      statusEl.textContent = `Loading after ${loaded} commits`;
    } else if (loadState.hasMore) {
      statusEl.textContent = `${loaded} commits loaded`;
    } else {
      statusEl.textContent = `${loaded} commits, complete`;
    }
    statusEl.classList.toggle("loading", loadState.loading);
  }

  /** 현재 브랜치에 upstream remote branch 가 있으면 header 외부 링크 버튼을 활성화한다. */
  function updateRemoteBranchButton(branches) {
    if (!openRemoteBtn) {
      return;
    }
    const current = (branches || []).find((branch) => branch.current);
    const upstream = current && !current.gone ? current.upstream : "";
    const enabled = Boolean(upstream);
    openRemoteBtn.hidden = !enabled;
    openRemoteBtn.disabled = !enabled;
    const title = enabled ? `Open remote branch ${upstream}` : "No remote branch connected";
    openRemoteBtn.title = title;
    openRemoteBtn.setAttribute("aria-label", title);
  }

  /**
   * 그래프 마지막에 로딩 표시나 수동 "더 보기" 버튼을 렌더링한다.
   * - 무한 스크롤이 동작하지 않는 상황에서도 사용자가 다음 페이지를 직접 요청할 수 있다.
   */
  function renderLoadTail() {
    const oldTail = graphContentEl.querySelector("#graph-tail");
    if (oldTail) {
      oldTail.remove();
    }
    if (!loadState.loading && !loadState.hasMore) {
      return;
    }

    const tail = document.createElement("div");
    tail.id = "graph-tail";
    tail.style.top = currentRows.length * ROW_H + "px";
    if (loadState.loading) {
      tail.innerHTML =
        `<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>` +
        `<span>Loading...</span>`;
    } else {
      tail.innerHTML =
        `<button id="load-more" type="button" title="Load more commits" ` +
        `aria-label="Load more commits">` +
        `<span class="codicon codicon-arrow-circle-down" aria-hidden="true"></span>` +
        `<span>Load more</span></button>`;
    }
    graphContentEl.appendChild(tail);

    const loadMoreBtn = tail.querySelector("#load-more");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", requestMoreCommits);
    }
  }

  /** 스크롤이 하단 가까이에 도달하면 다음 커밋 페이지를 요청한다. */
  function maybeLoadMore() {
    if (!loadState.hasMore || loadState.loading) {
      return;
    }
    const remaining = graphEl.scrollHeight - graphEl.scrollTop - graphEl.clientHeight;
    if (remaining <= 320) {
      requestMoreCommits();
    }
  }

  /** 중복 요청을 막기 위해 로컬 상태를 먼저 loading 으로 바꾸고 확장에 다음 페이지를 요청한다. */
  function requestMoreCommits() {
    if (!loadState.hasMore || loadState.loading) {
      return;
    }
    loadState = Object.assign({}, loadState, { loading: true });
    updateLoadStatus();
    resizeGraphContent();
    renderLoadTail();
    vscode.postMessage({ type: "loadMore" });
  }

  /** 현재 화면 폭에서 상세 패널을 drawer 로 다룰지 판단한다. */
  function isDrawerMode() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  /**
   * 상세 패널 표시/숨김 상태를 바꾼다.
   * - 넓은 화면에서는 사이드 패널을 접고, 좁은 화면에서는 오른쪽 drawer 를 열고 닫는다.
   */
  function setDetailVisible(visible) {
    document.body.classList.toggle("detail-open", visible);
    document.body.classList.toggle("detail-collapsed", !visible);
    if (toggleDetailBtn) {
      toggleDetailBtn.title = visible ? "Hide commit details" : "Show commit details";
      toggleDetailBtn.setAttribute(
        "aria-label",
        visible ? "Hide commit details" : "Show commit details"
      );
      const icon = toggleDetailBtn.querySelector(".codicon");
      if (icon) {
        icon.classList.toggle("codicon-layout-sidebar-right", visible);
        icon.classList.toggle("codicon-layout-sidebar-right-off", !visible);
      }
    }
  }

  /** 메인 그래프/상세 사이 splitter 의 드래그와 키보드 조작을 등록한다. */
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
   * 상세 패널 폭을 허용 범위 안으로 조정한다.
   * @param width 사용자가 요청한 상세 패널 폭
   */
  function setDetailWidth(width) {
    const maxByWindow = Math.max(DETAIL_MIN_W, Math.floor(window.innerWidth * 0.7));
    const next = clamp(width, DETAIL_MIN_W, Math.min(DETAIL_MAX_W, maxByWindow));
    detailEl.style.flexBasis = next + "px";
    detailEl.style.width = next + "px";
  }

  /** 커밋 요약/파일 목록 사이 splitter 의 드래그와 키보드 조작을 등록한다. */
  function initDetailSplitter() {
    const detailSplitter = detailEl.querySelector("#detail-splitter");
    const summary = detailEl.querySelector(".commit-summary");
    const shell = detailEl.querySelector(".detail-shell");
    if (!detailSplitter || !summary || !shell) {
      return;
    }

    resizeSummary(summary, shell, detailSummaryHeight);
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
   * 상세 패널 내부의 커밋 요약 영역 높이를 조절한다.
   * @param summary 높이를 적용할 요약 영역
   * @param shell   상세 패널 내부 전체 컨테이너
   * @param height  요청된 요약 영역 높이
   */
  function resizeSummary(summary, shell, height) {
    const max = Math.max(SUMMARY_MIN_H, shell.clientHeight - FILES_MIN_H);
    detailSummaryHeight = clamp(height, SUMMARY_MIN_H, max);
    summary.style.flexBasis = detailSummaryHeight + "px";
  }

  /** toolbar/drawer/scroll 이벤트를 한 번만 등록한다. */
  function initEvents() {
    initMainSplitter();
    window.GscGraphFeatures?.initSearch(graphEl, graphContentEl);
    graphEl.addEventListener("scroll", maybeLoadMore);
    refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    [["fetch-graph", "fetch"], ["pull-graph", "pull"], ["push-graph", "push"]].forEach(([id, type]) =>
      document.getElementById(id)?.addEventListener("click", () => vscode.postMessage({ type }))
    );
    openRemoteBtn?.addEventListener("click", () => vscode.postMessage({ type: "openRemoteBranch" }));
    document.getElementById("jump-head")?.addEventListener("click", () => window.GscGraphFeatures?.jumpToHead(graphEl, graphContentEl));
    toggleDetailBtn.addEventListener("click", () => {
      setDetailVisible(!document.body.classList.contains("detail-open"));
    });
    backdropEl.addEventListener("click", () => setDetailVisible(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isDrawerMode()) {
        setDetailVisible(false);
      }
    });
    window.addEventListener("resize", () => {
      resizeGraphContent();
      renderLoadTail();
      maybeLoadMore();
    });
  }

  // 확장에서 오는 메시지 처리
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "graph") {
      renderGraph(msg.data, msg.state);
    } else if (msg.type === "branchStatus") {
      window.GscGraphFeatures && window.GscGraphFeatures.setLocalBranches(msg.branches);
      updateRemoteBranchButton(msg.branches);
      graphContentEl.querySelectorAll(".row").forEach((el) => el.remove());
      const graphWidth = graphWidthForLaneCount(currentLaneCount);
      currentRows.forEach((row, index) => graphContentEl.appendChild(buildRow(row, index, graphWidth)));
      window.GscGraphFeatures && window.GscGraphFeatures.attachNodeDrag(graphContentEl);
      window.GscGraphFeatures?.updateSearchIndex(graphEl, graphContentEl);
    } else if (msg.type === "graphLoadState") {
      applyLoadState(msg.state, true);
    } else if (msg.type === "commitDetail") {
      renderDetail(msg.detail);
    } else if (msg.type === "error") {
      detailEl.innerHTML = `<p class="placeholder">Error: ${esc(msg.message)}</p>`;
      setDetailVisible(true);
    }
  });

  initEvents();
  setDetailVisible(!isDrawerMode());

  // 준비 완료를 알려 초기 그래프 데이터를 받는다.
  vscode.postMessage({ type: "ready" });
})();
