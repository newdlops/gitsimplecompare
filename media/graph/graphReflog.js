// 그래프 toolbar 의 reflog 복구 패널.
// - HEAD/branch reflog 를 보여주고, 각 지점에서 브랜치 생성/checkout/hash 복사를 직접 실행한다.
(function () {
  "use strict";

  const button = document.getElementById("graph-reflog");
  const panel = document.getElementById("graph-reflog-panel");
  const graphEl = document.getElementById("graph");
  const graphContent = document.getElementById("graph-content");
  let entries = [];
  let loading = false;
  let loadingObjects = false;
  let objectScan = false;
  let hoverHash = "";
  let activeHash = "";
  let pendingJump;
  let pendingGraphViewport;
  let requestSeq = 0;
  let syncFrame = 0;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** CSS selector 에 넣을 값을 안전하게 이스케이프한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  /** reflog 에서 온 hash 의 앞뒤 줄바꿈/공백을 제거한다. */
  function cleanHash(hash) {
    return String(hash || "").trim();
  }

  /** 패널을 열고 최신 reflog 를 요청한다. */
  function openPanel() {
    if (!panel) {
      return;
    }
    panel.hidden = false;
    button?.classList.add("active");
    updateToggleButton(true);
    syncGraphMarkers();
    requestReflog(false);
  }

  /** 패널을 닫는다. */
  function closePanel() {
    if (!panel) {
      return;
    }
    panel.hidden = true;
    button?.classList.remove("active");
    updateToggleButton(false);
    hoverHash = "";
    activeHash = "";
    clearGraphMarkers();
  }

  /** 패널 표시 상태를 토글한다. */
  function togglePanel() {
    if (!panel || panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  }

  /** 확장 호스트에 reflog refresh 를 요청한다. */
  function requestReflog(includeUnreachable) {
    if (loading) {
      return;
    }
    loading = true;
    loadingObjects = Boolean(includeUnreachable);
    render({ preserveGraphViewport: true, preservePanelScroll: true });
    window.GscGraphPostMessage?.({ type: "refreshReflog", includeUnreachable: Boolean(includeUnreachable) });
  }

  /** toolbar reflog 아이콘의 토글 접근성 상태와 tooltip 을 갱신한다. */
  function updateToggleButton(open) {
    if (!button) {
      return;
    }
    const title = open ? "Hide reflog recovery" : "Show reflog recovery";
    button.setAttribute("aria-pressed", open ? "true" : "false");
    button.setAttribute("aria-label", title);
    button.title = title;
    button.dataset.tooltip = title;
  }

  /** reflog 패널을 렌더링한다. */
  function render(options) {
    if (!panel || panel.hidden) {
      return;
    }
    const panelScroll = options?.preservePanelScroll ? capturePanelScroll() : undefined;
    panel.innerHTML =
      `<header>` +
      `<div><strong>Reflog Recovery</strong><span>${esc(statusText())}</span></div>` +
      `<div class="reflog-actions">` +
      iconButton("refresh-reflog", "refresh", "Refresh reflog") +
      iconButton("scan-reflog-objects", "search", "Scan unreachable objects") +
      iconButton("close-reflog", "close", "Close reflog") +
      `</div></header>` +
      `<div class="reflog-help">${summaryHtml()}</div>` +
      `<div class="reflog-list">${window.GscGraphReflogList?.entriesHtml?.(entries, { loading, activeHash, hoverHash, hashLoaded }) || ""}</div>`;
    panel.querySelector("#refresh-reflog")?.addEventListener("click", () => requestReflog(false));
    panel.querySelector("#scan-reflog-objects")?.addEventListener("click", () => requestReflog(true));
    panel.querySelector("#close-reflog")?.addEventListener("click", closePanel);
    panel.querySelectorAll(".reflog-entry").forEach((entry) => {
      entry.addEventListener("mouseenter", () => setHoverHash(entry.dataset.hash || ""));
      entry.addEventListener("mouseleave", () => setHoverHash(""));
      entry.addEventListener("focusin", () => setHoverHash(entry.dataset.hash || ""));
      entry.addEventListener("focusout", () => setHoverHash(""));
    });
    panel.querySelectorAll("[data-reflog-detail]").forEach((target) => {
      target.addEventListener("click", () => showEntryDetail(Number(target.dataset.reflogIndex)));
      target.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showEntryDetail(Number(target.dataset.reflogIndex));
        }
      });
    });
    panel.querySelectorAll("[data-reflog-action]").forEach((action) => {
      action.addEventListener("click", (event) => {
        event.stopPropagation();
        postEntryAction(action);
      });
    });
    syncGraphMarkers({
      preserveViewport: options?.preserveGraphViewport,
      viewport: options?.graphViewport,
    });
    restorePanelScroll(panelScroll);
  }

  /** 리플로그 패널을 다시 그리기 전 목록 스크롤 위치를 저장한다. */
  function capturePanelScroll() {
    return panel ? { top: panel.scrollTop, left: panel.scrollLeft } : undefined;
  }

  /** 리플로그 패널 재렌더 이후 기존 목록 스크롤 위치를 복원한다. */
  function restorePanelScroll(scroll) {
    if (!panel || !scroll) {
      return;
    }
    const maxTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
    const maxLeft = Math.max(0, panel.scrollWidth - panel.clientWidth);
    panel.scrollTop = Math.min(Math.max(0, scroll.top || 0), maxTop);
    panel.scrollLeft = Math.min(Math.max(0, scroll.left || 0), maxLeft);
  }

  /** 현재 패널 상태 문구를 만든다. */
  function statusText() {
    if (loading) {
      return loadingObjects ? "Scanning reflog objects..." : "Loading reflog...";
    }
    const visible = visibleEntryCount();
    return visible > 0
      ? `${entries.length} entries, ${visible} on graph`
      : `${entries.length} entries`;
  }

  /** reflog 흐름 상태별 요약 HTML 을 만든다. */
  function summaryHtml() {
    const counts = window.GscGraphReflogModel?.counts?.(entries) || { flow: 0, dropped: 0, timeline: 0, object: 0 };
    const note = objectScan
      ? "Objects come from git fsck and may disappear after garbage collection."
      : "Fast loading reads HEAD and branch reflogs.";
    return `<span class="reflog-summary-chip reflog-relation-flow">Branch flow ${esc(counts.flow)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-dropped">Dropped ${esc(counts.dropped)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-timeline">Timeline ${esc(counts.timeline)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-object">Objects ${esc(counts.object || 0)}</span>` +
      `<span class="reflog-summary-note">${esc(note)}</span>`;
  }

  /** toolbar/panel icon button HTML 을 만든다. */
  function iconButton(id, icon, title) {
    return `<button id="${id}" class="icon-button" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** reflog 항목 버튼 클릭을 기존 graph action 메시지로 변환한다. */
  function postEntryAction(button) {
    const hash = cleanHash(button.dataset.hash);
    if (!hash) return;
    const action = button.dataset.reflogAction;
    if (action === "showInGraph") {
      showInGraph(hash);
    } else if (action === "createBranch") {
      window.GscGraphPostMessage?.({ type: "createBranch", hash });
    } else if (action === "restoreBranch") {
      window.GscGraphPostMessage?.({ type: "restoreBranchFromReflog", hash });
    } else if (action === "cherryPick") {
      window.GscGraphPostMessage?.({ type: "cherryPick", hash });
    } else if (action === "checkoutCommit") {
      window.GscGraphPostMessage?.({ type: "checkoutCommit", hash });
    } else if (action === "copyCommitHash") {
      window.GscGraphPostMessage?.({ type: "copyCommitHash", hash });
    }
  }

  /** reflog 항목이 가리키는 commit 을 그래프에서 보이게 한다. */
  function showInGraph(hash) {
    hash = cleanHash(hash);
    if (!hash) return;
    if (jumpToHash(hash)) {
      return;
    }
    const requestId = `reflog-${++requestSeq}`;
    pendingJump = { requestId, hash };
    window.GscGraphPostMessage?.({ type: "showReflogCommit", requestId, hash });
  }

  /** 현재 로드된 그래프 row 로 스크롤하고 reflog 활성 강조를 적용한다. */
  function jumpToHash(hash) {
    hash = cleanHash(hash);
    const row = rowForHash(hash);
    if (!row || !graphEl) {
      return false;
    }
    activeHash = hash;
    graphEl.scrollTop = Math.max(0, row.offsetTop - 80);
    refreshActiveMarks();
    render({ preserveGraphViewport: true, preservePanelScroll: true });
    return true;
  }

  /** hover 중인 reflog 항목과 같은 그래프 row/node 를 강조한다. */
  function setHoverHash(hash) {
    hoverHash = cleanHash(hash);
    refreshActiveMarks();
    panel?.querySelectorAll(".reflog-entry").forEach((entry) => {
      entry.classList.toggle("graph-hover", Boolean(hoverHash) && entry.dataset.hash === hoverHash);
    });
  }

  /** 로드된 그래프에 reflog 전용 가상 branch 와 row 를 다시 붙인다. */
  function syncGraphMarkers(options) {
    const viewport = options?.viewport || (options?.preserveViewport ? captureGraphViewport() : undefined);
    clearGraphMarkers();
    if (!graphContent || panel?.hidden || !entries.length) {
      restoreGraphViewport(viewport);
      return;
    }
    const virtualMarkers = entries.map((entry, index) => eventMarker(entry, index)).filter(Boolean);
    window.GscGraphReflogMarkers?.renderVirtualBranch?.(graphContent, virtualMarkers);
    refreshActiveMarks();
    restoreGraphViewport(viewport);
  }

  /** 리플로그 가상 row 를 다시 끼우기 전 그래프 viewport 기준점을 저장한다. */
  function captureGraphViewport() {
    return window.GscGraphViewport?.capture?.(graphEl, graphContent) || undefined;
  }

  /** 리플로그 가상 row 재배치 이후 그래프 viewport 기준점을 복원한다. */
  function restoreGraphViewport(viewport) {
    if (viewport) window.GscGraphViewport?.restore?.(graphEl, graphContent, viewport);
  }

  /** 이전 reflog 그래프 표시를 모두 제거한다. */
  function clearGraphMarkers() {
    if (!graphContent) {
      return;
    }
    window.GscGraphReflogMarkers?.clearVirtualLayout?.(graphContent);
    graphContent.querySelectorAll(".reflog-graph-marker").forEach((marker) => marker.remove());
    graphContent.querySelectorAll(".reflog-linked-row,.reflog-active-row,.reflog-hover-row").forEach((row) => {
      row.classList.remove("reflog-linked-row", "reflog-active-row", "reflog-hover-row");
      if (row.dataset.originalTitle != null) {
        row.title = row.dataset.originalTitle;
        delete row.dataset.originalTitle;
      }
    });
    graphContent.querySelectorAll(".reflog-virtual-branch,.reflog-node-shape,.reflog-virtual-row").forEach((shape) => shape.remove());
  }

  /** active/hover 상태 class 를 row/가상 reflog node 에 반영한다. */
  function refreshActiveMarks() {
    if (!graphContent) {
      return;
    }
    graphContent.querySelectorAll(".reflog-active-row,.reflog-hover-row").forEach((row) => {
      row.classList.remove("reflog-active-row", "reflog-hover-row");
    });
    graphContent.querySelectorAll(".reflog-active-node-shape,.reflog-hover-node-shape").forEach((shape) => {
      shape.classList.remove("reflog-active-node-shape", "reflog-hover-node-shape");
    });
    graphContent.querySelectorAll(".reflog-active-virtual-node,.reflog-hover-virtual-node").forEach((node) => {
      node.classList.remove("reflog-active-virtual-node", "reflog-hover-virtual-node");
    });
    graphContent.querySelectorAll(".reflog-active-virtual-row,.reflog-hover-virtual-row").forEach((row) => {
      row.classList.remove("reflog-active-virtual-row", "reflog-hover-virtual-row");
    });
    markHash(activeHash, "active");
    markHash(hoverHash, "hover");
  }

  /** 한 hash 에 active/hover class 를 붙인다. */
  function markHash(hash, kind) {
    if (!hash) {
      return;
    }
    rowForHash(hash)?.classList.add(`reflog-${kind}-row`);
    const virtualNode = graphContent?.querySelector(`.reflog-virtual-node[data-hash="${cssEscape(cleanHash(hash))}"]`);
    virtualNode?.classList.add(`reflog-${kind}-virtual-node`);
    virtualNode?.querySelector(".reflog-node-shape")?.classList.add(`reflog-${kind}-node-shape`);
    graphContent?.querySelectorAll(`.reflog-virtual-row[data-hash="${cssEscape(cleanHash(hash))}"]`).forEach((row) => row.classList.add(`reflog-${kind}-virtual-row`));
  }

  /** reflog 항목을 오른쪽 상세 패널에 표시한다. */
  function showEntryDetail(index) {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    activeHash = cleanHash(entry.hash);
    refreshActiveMarks();
    refreshEntryActiveMarks();
    window.GscGraphReflogDetail?.show?.(entry, index, { loaded: hashLoaded(entry.hash) });
  }

  /** reflog 목록에서 선택된 항목 표시만 갱신한다. 그래프 row 재배치는 하지 않는다. */
  function refreshEntryActiveMarks() {
    panel?.querySelectorAll(".reflog-entry").forEach((entry) => {
      entry.classList.toggle("graph-active", Boolean(activeHash) && entry.dataset.hash === activeHash);
    });
  }

  /** hash 에 해당하는 row 가 현재 그래프 DOM 에 로드되어 있는지 확인한다. */
  function hashLoaded(hash) {
    return Boolean(rowForHash(cleanHash(hash)));
  }

  /** HEAD reflog 이벤트를 가상 브랜치 marker 모델로 변환한다. */
  function eventMarker(entry, index) {
    const hash = cleanHash(entry.hash);
    if (!hash) return undefined;
    const fromHash = cleanHash(entry.transition?.fromHash);
    const row = rowForHash(hash);
    const parentRows = (entry.parentHashes || []).map((parentHash) => rowForHash(parentHash)).filter(Boolean);
    const dropRows = dropAnchorRows(entry);
    return {
      hash,
      fromHash,
      toHash: hash,
      fromRow: rowForHash(fromHash),
      toRow: row,
      parentRows,
      dropRows,
      index,
      dateIso: entry.dateIso,
      flow: modelIsHistoryChange(entry) ? "changed" : flowState(entry),
      recovery: modelRecoveryKind(entry),
      recoveryLabel: modelRecoveryLabel(entry),
      status: virtualStatusLabel(entry, Boolean(row)),
      event: eventLabel(entry),
      subject: entry.message || "Reflog entry",
      title: eventMarkerTitle(entry, index, Boolean(rowForHash(fromHash)), Boolean(row)),
    };
  }

  /** 가상 HEAD 이벤트 marker tooltip 을 만든다. */
  function eventMarkerTitle(entry, index, fromLoaded, toLoaded) {
    const from = entry.source === "branch" ? (entry.shortSelector || "branch") : shortHash(entry.transition?.fromHash) || "unknown";
    const to = shortHash(entry.hash);
    const move = entry.source === "branch" ? to : `${from} -> ${to}`;
    const placement = fromLoaded || toLoaded ? "between visible commits" : "off current graph";
    const code = entryCode(entry, index);
    const anchor = objectAnchorText(entry);
    return `${sourceLabel(entry)} ${code}: ${move} | ${modelRecoveryLabel(entry)} | ${eventLabel(entry)} | ${anchor || relationSummary(entry, toLoaded)} | ${placement}`;
  }

  /** 가상 branch node 옆에 붙일 상태 라벨을 만든다. */
  function virtualStatusLabel(entry, loaded) {
    if (entry.recovery?.kind === "recoverable") {
      return "Recoverable";
    }
    if (entry.recovery?.kind === "expired") {
      return "Expired";
    }
    if (modelIsHistoryChange(entry)) {
      return loaded ? "Changed" : "Changed off graph";
    }
    return relationLabel(entry, loaded);
  }

  /** 모델이 아직 로드되지 않은 초기 상태에서도 안전한 flow 상태를 반환한다. */
  function flowState(entry) {
    return window.GscGraphReflogModel?.flowState?.(entry) || "timeline";
  }

  /** 모델의 관계 라벨을 안전하게 호출한다. */
  function relationLabel(entry, loaded) {
    return window.GscGraphReflogModel?.relationLabel?.(entry, loaded) || (loaded ? "On graph" : "Timeline");
  }

  /** 모델의 이벤트 라벨을 안전하게 호출한다. */
  function eventLabel(entry) {
    return window.GscGraphReflogModel?.eventLabel?.(entry) || "Reflog update";
  }

  function modelRecoveryKind(entry) { return window.GscGraphReflogModel?.recoveryKind?.(entry) || "reachable"; }
  function modelRecoveryLabel(entry) { return window.GscGraphReflogModel?.recoveryLabel?.(entry) || "On branch"; }
  function modelIsHistoryChange(entry) { return Boolean(window.GscGraphReflogModel?.isHistoryChange?.(entry)); }

  /** 모델의 관계 설명을 안전하게 호출한다. */
  function relationSummary(entry, loaded) {
    return window.GscGraphReflogModel?.relationSummary?.(entry, loaded) || "Reflog entry.";
  }

  /** 항목 출처에 맞는 짧은 번호를 만든다. */
  function entryCode(entry, index) {
    return `${entry?.source === "unreachable" ? "O" : entry?.source === "branch" ? "B" : "R"}${index + 1}`;
  }

  /** 항목 출처를 사용자에게 보여줄 짧은 라벨로 바꾼다. */
  function sourceLabel(entry) {
    return entry?.source === "unreachable" ? "Unreachable object" : entry?.source === "branch" ? "Branch reflog" : "HEAD reflog";
  }

  /** object 항목의 drop 근거 중 가장 가까운 항목 하나를 고른다. */
  function firstDropSource(entry) {
    return Array.isArray(entry?.dropSources) ? entry.dropSources[0] : undefined;
  }

  /** drop source 를 목록/tooltip 에 들어갈 짧은 문구로 만든다. */
  function dropLabel(source) {
    const branch = source?.name || "unknown branch";
    const via = source?.viaHash ? ` via ${shortHash(source.viaHash)}` : "";
    return `${branch}${via}`;
  }

  /** drop source 의 from/to hash 중 현재 그래프에 보이는 row 를 anchor 후보로 모은다. */
  function dropAnchorRows(entry) {
    const rows = [];
    (entry?.dropSources || []).forEach((source) => {
      const toRow = rowForHash(source.toHash);
      const fromRow = rowForHash(source.fromHash);
      if (toRow) rows.push(toRow);
      if (fromRow) rows.push(fromRow);
    });
    return rows;
  }

  /** object marker tooltip 에 표시할 구조/시간 anchor 설명을 만든다. */
  function objectAnchorText(entry) {
    if (entry?.source !== "unreachable") {
      return "";
    }
    const parent = (entry.parentHashes || [])[0];
    if (parent) {
      return `Parent anchor ${shortHash(parent)}.`;
    }
    const drop = firstDropSource(entry);
    if (drop) {
      return `Dropped from ${dropLabel(drop)} at ${formatDate(drop.dateIso)}.`;
    }
    return "Placed by commit date because no visible parent or reflog move was found.";
  }

  /** 현재 로드된 그래프에 표시 가능한 reflog 항목 수를 계산한다. */
  function visibleEntryCount() {
    return entries.filter((entry) => hashLoaded(entry.hash)).length;
  }

  /** 현재 렌더된 graph row 중 hash 가 같은 요소를 찾는다. */
  function rowForHash(hash) {
    return graphContent?.querySelector(`.row[data-hash="${cssEscape(cleanHash(hash))}"]:not([data-reflog-virtual])`) || null;
  }

  /** 커밋 해시를 짧게 줄인다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 10);
  }

  /** reflog selector 날짜를 보기 좋은 짧은 형태로 만든다. */
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 그래프가 다시 렌더링된 뒤 reflog 연결 표시를 다시 붙인다. */
  function scheduleGraphSync() {
    if (syncFrame) {
      return;
    }
    syncFrame = window.requestAnimationFrame(() => {
      const viewport = pendingGraphViewport || captureGraphViewport();
      pendingGraphViewport = undefined;
      syncFrame = 0;
      if (!panel?.hidden) {
        render({
          preserveGraphViewport: true,
          preservePanelScroll: true,
          graphViewport: viewport,
        });
      }
    });
  }

  /** graph.js 가 DOM 을 바꾸기 전에 현재 그래프 viewport 를 캡처한다. */
  function captureGraphSyncMessage(event) {
    const msg = event.data || {};
    if (!shouldSyncForGraphMessage(msg) || panel?.hidden || !entries.length) {
      return;
    }
    pendingGraphViewport = captureGraphViewport();
  }

  /** 리플로그 상태/마커를 다시 계산해야 하는 그래프 갱신 메시지인지 확인한다. */
  function shouldSyncForGraphMessage(msg) {
    if (msg.type === "graph") return !msg.state?.reset || Boolean(msg.state?.loadDirection);
    return ["branchStatus", "tagStatus"].includes(msg.type);
  }

  /**
   * MutationObserver 가 감지한 변경이 reflog 가상 row 추가/삭제뿐인지 확인한다.
   * - reflog row 삽입 자체를 다시 graph render 트리거로 보면 높이 복원/삽입이 반복되어 스크롤이 튕긴다.
   * @param mutations graph-content childList 변경 목록
   */
  function reflogOnlyMutations(mutations) {
    let sawElement = false;
    return mutations.every((mutation) => {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
      return nodes.every((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return true;
        }
        sawElement = true;
        return isReflogGraphNode(node);
      });
    }) && sawElement;
  }

  /**
   * reflog renderer 가 직접 추가/삭제하는 graph DOM 인지 판별한다.
   * @param node MutationObserver 로 들어온 DOM node
   */
  function isReflogGraphNode(node) {
    const element = node;
    return element.classList?.contains("reflog-virtual-row") ||
      element.classList?.contains("reflog-virtual-branch") ||
      Boolean(element.querySelector?.(".reflog-virtual-row,.reflog-virtual-branch"));
  }

  /** 그래프 DOM 교체를 감지해 reflog marker 를 최신 row/node 로 옮긴다. */
  function observeGraph() {
    if (!graphContent) return;
    const observer = new MutationObserver((mutations) => {
      if (!reflogOnlyMutations(mutations)) {
        scheduleGraphSync();
      }
    });
    observer.observe(graphContent, { childList: true });
  }

  updateToggleButton(false);
  button?.addEventListener("click", togglePanel);
  window.addEventListener("gsc-reflog-show-in-graph", (event) => showInGraph(event.detail?.hash || ""));
  window.addEventListener("gsc-reflog-select", (event) => showEntryDetail(Number(event.detail?.index)));
  window.addEventListener("gsc-reflog-recover", (event) => window.GscGraphPostMessage?.({ type: "createBranch", hash: cleanHash(event.detail?.hash) }));
  window.addEventListener("gsc-reflog-restore-branch", (event) => window.GscGraphPostMessage?.({ type: "restoreBranchFromReflog", hash: cleanHash(event.detail?.hash) }));
  observeGraph();
  window.addEventListener("message", captureGraphSyncMessage, true);
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "graphReflog") {
      entries = Array.isArray(msg.entries) ? msg.entries : [];
      loading = false;
      loadingObjects = false;
      objectScan = Boolean(msg.scannedObjects);
      if (!panel?.hidden) {
        render({ preserveGraphViewport: true, preservePanelScroll: true });
      }
    } else if (msg.type === "commitVisibility" && pendingJump?.requestId === msg.requestId) {
      const hash = cleanHash(msg.hash || pendingJump.hash);
      pendingJump = undefined;
      if (msg.found) {
        window.requestAnimationFrame(() => jumpToHash(hash));
      } else if (!panel?.hidden) {
        render({ preserveGraphViewport: true, preservePanelScroll: true });
      }
    } else if (shouldSyncForGraphMessage(msg)) {
      scheduleGraphSync();
    }
  });
})();
