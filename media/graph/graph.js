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
  let currentEdges = [];
  let currentLaneCount = 1;
  let selectedHash = null;
  let detailLabel = "commit details";
  let detailSummaryHeight = 180;
  let loadState = { loadedCount: 0, hasMore: false, hasMoreBefore: false, loading: false, reset: true };
  let rowColorCache = new WeakMap();
  let localColorResolver = null;

  /** 레인 인덱스를 x 좌표로 변환한다. */
  function laneX(col) {
    return MARGIN + col * LANE_W;
  }

  /** 행 인덱스를 y 좌표(행 중앙)로 변환한다. */
  function rowY(row) {
    return row * ROW_H + ROW_H / 2;
  }

  /** 숫자를 min/max 범위 안으로 제한한다. */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text == null ? "" : text).replace(/[&<>"]/g, (ch) => map[ch]);
  }

  /**
   * 그래프 전체(SVG 간선/노드 + 텍스트 행)를 렌더링한다.
   * @param data GraphData
   * @param state 확장에서 전달한 페이지 로딩 상태
   */
  function renderGraph(data, state) {
    const resetView = Boolean(state && state.reset);
    const preserveView = resetView || state?.loadDirection === "newer";
    const viewport = preserveView ? window.GscGraphViewport?.capture(graphEl, graphContentEl) : null;
    applyLoadState(state, false);
    if (resetView && !viewport) {
      selectedHash = null;
      graphEl.scrollTop = 0;
    }

    currentRows = data.rows || [];
    currentEdges = data.edges || [];
    rowColorCache = new WeakMap();
    localColorResolver = window.GscGraphLocalColors?.makeResolver?.(currentRows, currentEdges) || null;
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

    graphContentEl.appendChild(window.GscGraphSvgRender.render({
      rows: currentRows,
      edges: currentEdges,
      graphWidth,
      bodyHeight,
      laneX,
      rowY,
      rowHeight: ROW_H,
      nodeRadius: NODE_R,
      rowDisplayColor,
      edgeDisplayColor,
      rowTitle,
    }));

    // 2) 텍스트 행(그래프 폭만큼 왼쪽 여백)
    for (let r = 0; r < currentRows.length; r++) {
      graphContentEl.appendChild(buildRow(currentRows[r], r, graphWidth));
    }
    syncScrollableWidth(graphWidth);
    window.GscGraphFeatures && window.GscGraphFeatures.attachNodeDrag(graphContentEl);
    const restored = preserveView && window.GscGraphViewport?.restore(graphEl, graphContentEl, viewport);
    if (resetView && !restored) window.GscGraphHeadJump?.focusHead(graphEl, graphContentEl);
    window.GscGraphSearch?.update(graphEl, graphContentEl);

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
    return bodyHeight + (isLoadingOlder() || loadState.hasMore ? TAIL_H : 0);
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

  /** row 내용이 가로로 길 때 그래프 컨텐츠 폭을 실제 row 폭에 맞춰 넓힌다. */
  function syncScrollableWidth(graphWidth) {
    const rowsRight = Array.from(graphContentEl.querySelectorAll(".row")).reduce(
      (max, row) => Math.max(max, row.offsetLeft + row.scrollWidth + 24),
      0
    );
    const graphRight = (graphWidth || graphWidthForLaneCount(currentLaneCount)) + 680;
    const width = Math.max(graphEl.clientWidth, rowsRight, graphRight);
    if (width > 0) {
      graphContentEl.style.width = width + "px";
      graphContentEl.style.minWidth = width + "px";
    }
  }

  /**
   * 커밋 한 행의 DOM(참조 배지 + 제목 + 작성자/날짜)을 만든다.
   * @param row       GraphRow
   * @param index     행 인덱스
   * @param leftInset 그래프 폭(좌측 여백)
   */
  function buildRow(row, index, leftInset) {
    const el = document.createElement("div");
    const localOnlyBranches = row.localOnlyBranches || [];
    const displayRefs = window.GscGraphFeatures?.displayRefs?.(row) || row.refs || [];
    el.className =
      "row" +
      (row.hash === selectedHash ? " selected" : "") +
      (row.kind ? " " + row.kind + "-row" : "");
    el.style.top = index * ROW_H + "px";
    el.style.left = leftInset + "px";
    el.style.right = "0";
    el.style.setProperty("--branch-color", rowDisplayColor(row));
    el.dataset.hash = row.hash;
    el.dataset.subject = row.subject || "";
    el.dataset.dateIso = row.dateIso || "";
    el.dataset.refs = displayRefs.join("\t");
    el.dataset.localOnlyBranches = localOnlyBranches.join("\t");
    el.title = rowTitle(row, displayRefs);
    const refRenderer = window.GscGraphFeatures && window.GscGraphFeatures.refBadge;
    const refs = displayRefs
      .map((ref) =>
        refRenderer ? refRenderer(ref, esc) : `<span class="ref${ref === "HEAD" ? " head" : ""}">${esc(ref)}</span>`
      )
      .join("");
    const date = formatDate(row.dateIso);
    const badge = localOnlyBranches.length ? `<span class="local-only-badge" title="${esc(`local only: ${localOnlyBranches.join(", ")}`)}">-local only-</span>` : "";
    el.innerHTML =
      refs +
      `<span class="subject">${esc(row.subject)}</span>` +
      `<span class="meta">${esc(row.authorName)} · ${esc(date)}</span>` + badge;

    el.addEventListener("click", () => selectCommit(row.hash));
    return el;
  }
  /** row 별 표시 색상을 한 번만 계산해 SVG edge/node 와 텍스트 row 가 같은 값을 공유하게 한다. */
  function rowDisplayColor(row) {
    if (!row) {
      return "#abb2bf";
    }
    const cached = rowColorCache.get(row);
    if (cached) {
      return cached;
    }
    const color =
      localColorResolver?.colorForRow?.(row) ||
      window.GscGraphFeatures?.rowColor?.(row) ||
      window.GscGraphColors?.rowColor?.(row) ||
      "#abb2bf";
    rowColorCache.set(row, color);
    return color;
  }

  /** edge 시작 row 색상을 재사용해 local-only edge 도 브랜치 색과 맞춘다. */
  function edgeDisplayColor(edge) {
    const from = currentRows[edge.fromRow];
    return from
      ? rowDisplayColor(from)
      : window.GscGraphColors?.edgeColor?.(edge, currentRows) || "#abb2bf";
  }
  /** 커밋 row/node hover tooltip 에 표시할 짧은 설명을 만든다. */
  function rowTitle(row, refsOverride) {
    const refs = (refsOverride || row.refs || []).filter(Boolean).join(", ");
    const localOnlyBranches = (row.localOnlyBranches || []).filter(Boolean).join(", ");
    const subject = row.subject || row.hash;
    const parts = [subject];
    if (refs) {
      parts.push(refs);
    }
    if (localOnlyBranches) {
      parts.push(`local only: ${localOnlyBranches}`);
    }
    const compactTitle = window.GscGraphCompactRender?.titlePart?.(row);
    if (compactTitle) {
      parts.push(compactTitle);
    }
    return parts.join(" | ");
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
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 커밋을 선택 상태로 만들고 상세를 요청한다.
   * @param hash 선택할 커밋 해시
   */
  function selectCommit(hash) {
    selectedHash = hash;
    const rows = graphContentEl.querySelectorAll(".row:not([data-reflog-virtual])");
    rows.forEach((el) => el.classList.toggle("selected", el.dataset.hash === hash));
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
    setDetailLabel("commit details");
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
    if (state.reset && state.loading && currentRows.length === 0) {
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
      statusEl.textContent = loadState.loadDirection === "newer"
        ? `Loading newer commits before ${loaded} loaded`
        : `Loading older commits after ${loaded} loaded`;
    } else if (loadState.hasMore || loadState.hasMoreBefore) {
      statusEl.textContent = `${loaded} commits loaded`;
    } else {
      statusEl.textContent = `${loaded} commits, complete`;
    }
    statusEl.classList.toggle("loading", loadState.loading);
  }

  /**
   * 그래프 마지막에 로딩 표시나 수동 "더 보기" 버튼을 렌더링한다.
   * - 무한 스크롤이 동작하지 않는 상황에서도 사용자가 다음 페이지를 직접 요청할 수 있다.
   */
  function renderLoadTail() {
    const oldTail = graphContentEl.querySelector("#graph-tail");
    oldTail?.remove();
    if (!isLoadingOlder() && !loadState.hasMore) {
      return;
    }

    const tail = document.createElement("div");
    tail.id = "graph-tail";
    tail.style.top = currentRows.length * ROW_H + "px";
    if (isLoadingOlder()) {
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

    tail.querySelector("#load-more")?.addEventListener("click", () => requestMoreCommits("older"));
  }

  /** 스크롤이 위/아래 끝 가까이에 도달하면 해당 방향의 커밋 페이지를 요청한다. */
  function maybeLoadMore() {
    if (loadState.loading) return;
    if (loadState.hasMoreBefore && graphEl.scrollTop <= 240) {
      requestMoreCommits("newer");
      return;
    }
    if (!loadState.hasMore) return;
    const remaining = graphEl.scrollHeight - graphEl.scrollTop - graphEl.clientHeight;
    if (remaining <= 320) {
      requestMoreCommits("older");
    }
  }

  /** 중복 요청을 막기 위해 로컬 상태를 먼저 loading 으로 바꾸고 확장에 다음 페이지를 요청한다. */
  function requestMoreCommits(direction) {
    const newer = direction === "newer";
    if (loadState.loading || (newer ? !loadState.hasMoreBefore : !loadState.hasMore)) {
      return;
    }
    loadState = Object.assign({}, loadState, { loading: true, loadDirection: newer ? "newer" : "older" });
    updateLoadStatus();
    resizeGraphContent();
    renderLoadTail();
    vscode.postMessage({ type: "loadMore", direction: loadState.loadDirection });
  }

  /** 현재 로딩이 하단(older) 페이지 로딩인지 확인한다. */
  function isLoadingOlder() { return loadState.loading && loadState.loadDirection !== "newer"; }

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
      toggleDetailBtn.title = visible ? `Hide ${detailLabel}` : `Show ${detailLabel}`;
      toggleDetailBtn.dataset.tooltip = toggleDetailBtn.title;
      toggleDetailBtn.setAttribute("aria-label", toggleDetailBtn.title);
      const icon = toggleDetailBtn.querySelector(".codicon");
      if (icon) {
        icon.classList.toggle("codicon-layout-sidebar-right", visible);
        icon.classList.toggle("codicon-layout-sidebar-right-off", !visible);
      }
    }
  }

  /** 상세 패널이 현재 보여주는 내용 종류를 toggle button 문구에 반영한다. */
  function setDetailLabel(label) {
    detailLabel = label || "details";
    setDetailVisible(document.body.classList.contains("detail-open"));
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

  /**
   * 커밋 메시지/메타 정보가 긴 경우 파일 목록을 최소 높이까지 줄여 상세 내용을 먼저 보이게 한다.
   * @param summary 실제 상세 내용이 들어 있는 영역
   * @param shell   상세 패널 전체 높이를 제공하는 컨테이너
   */
  function preferredSummaryHeight(summary, shell) {
    const max = Math.max(SUMMARY_MIN_H, shell.clientHeight - FILES_MIN_H);
    return clamp(summary.scrollHeight + 2, SUMMARY_MIN_H, max);
  }

  /** toolbar/drawer/scroll 이벤트를 한 번만 등록한다. */
  function initEvents() {
    initMainSplitter();
    window.GscGraphSearch?.init(graphEl, graphContentEl);
    window.GscGraphCompactRender?.bindNavigation(graphEl, graphContentEl);
    window.GscGraphCompactRender?.bindLaneHighlight(graphContentEl);
    graphEl.addEventListener("scroll", maybeLoadMore);
    refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    [["fetch-graph", "fetch"], ["fetch-tags-graph", "fetchTags"], ["pull-graph", "pull"], ["push-graph", "push"], ["force-push-graph", "forcePush"]].forEach(([id, type]) =>
      document.getElementById(id)?.addEventListener("click", () => vscode.postMessage({ type }))
    );
    window.GscGraphRemote?.bind(openRemoteBtn, (message) => vscode.postMessage(message));
    document.getElementById("jump-head")?.addEventListener("click", () => window.GscGraphHeadJump?.jumpToHead(graphEl, graphContentEl));
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
      syncScrollableWidth();
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
      window.GscGraphWorktrees?.setWorktrees?.(msg.worktrees);
      window.GscGraphFeatures && window.GscGraphFeatures.setLocalBranches(msg.branches);
      rowColorCache = new WeakMap();
      localColorResolver = window.GscGraphLocalColors?.makeResolver?.(currentRows, currentEdges) || null;
      window.GscGraphRemote?.updateButton(openRemoteBtn, msg.branches);
      graphContentEl.querySelectorAll(".row").forEach((el) => el.remove());
      const graphWidth = graphWidthForLaneCount(currentLaneCount);
      currentRows.forEach((row, index) => graphContentEl.appendChild(buildRow(row, index, graphWidth)));
      syncScrollableWidth(graphWidth);
      window.GscGraphFeatures && window.GscGraphFeatures.attachNodeDrag(graphContentEl);
      window.GscGraphSearch?.update(graphEl, graphContentEl);
    } else if (msg.type === "tagStatus") {
      window.GscGraphFeatures?.setTagStatus?.(msg.tags);
      graphContentEl.querySelectorAll(".row").forEach((el) => el.remove());
      const graphWidth = graphWidthForLaneCount(currentLaneCount);
      currentRows.forEach((row, index) => graphContentEl.appendChild(buildRow(row, index, graphWidth)));
      syncScrollableWidth(graphWidth);
      window.GscGraphFeatures && window.GscGraphFeatures.attachNodeDrag(graphContentEl);
      window.GscGraphSearch?.update(graphEl, graphContentEl);
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
  window.GscGraphDetailHost = {
    root: detailEl,
    show(label) {
      setDetailLabel(label || "details");
      setDetailVisible(true);
    },
    hide() {
      setDetailVisible(false);
    },
  };
  setDetailVisible(!isDrawerMode());

  // 준비 완료를 알려 초기 그래프 데이터를 받는다.
  vscode.postMessage({ type: "ready" });
})();
