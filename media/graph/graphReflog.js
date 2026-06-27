// 그래프 toolbar 의 reflog 복구 패널.
// - HEAD reflog 를 보여주고, 각 지점에서 브랜치 생성/checkout/hash 복사를 직접 실행한다.
(function () {
  "use strict";

  const button = document.getElementById("graph-reflog");
  const panel = document.getElementById("graph-reflog-panel");
  const graphEl = document.getElementById("graph");
  const graphContent = document.getElementById("graph-content");
  let entries = [];
  let loading = false;
  let hoverHash = "";
  let activeHash = "";
  let pendingJump;
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
    requestReflog();
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
  function requestReflog() {
    loading = true;
    render();
    window.GscGraphPostMessage?.({ type: "refreshReflog" });
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
  function render() {
    if (!panel || panel.hidden) {
      return;
    }
    panel.innerHTML =
      `<header>` +
      `<div><strong>HEAD Reflog</strong><span>${esc(statusText())}</span></div>` +
      `<div class="reflog-actions">` +
      iconButton("refresh-reflog", "refresh", "Refresh reflog") +
      iconButton("close-reflog", "close", "Close reflog") +
      `</div></header>` +
      `<div class="reflog-help">${summaryHtml()}</div>` +
      `<div class="reflog-list">${entriesHtml()}</div>`;
    panel.querySelector("#refresh-reflog")?.addEventListener("click", requestReflog);
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
    syncGraphMarkers();
  }

  /** 현재 패널 상태 문구를 만든다. */
  function statusText() {
    if (loading) {
      return "Loading HEAD reflog...";
    }
    const visible = visibleEntryCount();
    return visible > 0
      ? `${entries.length} entries, ${visible} on graph`
      : `${entries.length} entries`;
  }

  /** reflog 흐름 상태별 요약 HTML 을 만든다. */
  function summaryHtml() {
    const counts = window.GscGraphReflogModel?.counts?.(entries) || { flow: 0, dropped: 0, timeline: 0 };
    return `<span class="reflog-summary-chip reflog-relation-flow">Branch flow ${esc(counts.flow)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-dropped">Dropped ${esc(counts.dropped)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-timeline">Timeline ${esc(counts.timeline)}</span>` +
      `<span class="reflog-summary-note">Dropped means unreachable now. Changed means amend/rebase/reset moved history. Missing commits stay on the reflog lane by time.</span>`;
  }

  /** reflog 항목 리스트 HTML 을 만든다. */
  function entriesHtml() {
    if (loading && entries.length === 0) {
      return `<div class="reflog-empty">Loading...</div>`;
    }
    if (entries.length === 0) {
      return `<div class="reflog-empty">No reflog entries.</div>`;
    }
    return entries.map((entry, index) => entryHtml(entry, index)).join("");
  }

  /** reflog 항목 한 줄 HTML 을 만든다. */
  function entryHtml(entry, index) {
    const entryHash = cleanHash(entry.hash);
    const hash = shortHash(entryHash);
    const message = entry.message || "reflog entry";
    const date = formatDate(entry.dateIso);
    const loaded = hashLoaded(entryHash);
    const flow = flowState(entry);
    const state = relationLabel(entry, loaded);
    const event = eventLabel(entry);
    const summary = relationSummary(entry, loaded);
    const expired = entry.recovery?.kind === "expired";
    const canRecover = Boolean(entry.recovery?.available);
    const recoverTitle = canRecover
      ? "Recover by creating branch at this HEAD state"
      : entry.recovery?.reason || "This reflog entry is not a recovery target";
    const classes = [
      "reflog-entry",
      `reflog-${flow}`,
      loaded ? "graph-loaded" : "graph-missing",
      entryHash === activeHash ? "graph-active" : "",
      entryHash === hoverHash ? "graph-hover" : "",
    ].filter(Boolean).join(" ");
    return `<article class="${classes}" data-hash="${esc(entryHash)}" data-flow="${esc(flow)}">` +
      `<div class="reflog-index"><span class="reflog-timeline-dot" title="${esc(state)}"></span><span>R${esc(index + 1)}</span></div>` +
      `<div class="reflog-main" role="button" tabindex="0" data-reflog-detail="1" data-reflog-index="${esc(index)}" ` +
      `title="${esc(state)}: ${esc(summary)}" aria-label="Show reflog details" data-tooltip="${esc(state)}: ${esc(summary)}">` +
      `<div class="reflog-title"><code>${esc(hash)}</code><strong>${esc(message)}</strong>` +
      `<span class="reflog-graph-state reflog-relation-${esc(flow)}">${esc(state)}</span>` +
      `<span class="reflog-recovery-chip reflog-recovery-${esc(modelRecoveryKind(entry))}">${esc(modelRecoveryLabel(entry))}</span>` +
      `<span class="reflog-event-chip">${esc(event)}</span></div>` +
      `<div class="reflog-meta"><span>${esc(entry.shortSelector || entry.selector)}</span>` +
      `<span>${esc(date)}</span></div>` +
      `<div class="reflog-flow-summary">${esc(summary)}</div>` +
      `<div class="reflog-transition">${esc(transitionText(entry))}</div>` +
      provenanceHtml(entry) +
      `</div>` +
      `<div class="reflog-entry-actions">` +
      entryButton("showInGraph", "target", loaded ? "Show this reflog entry in graph" : "Load and show this reflog entry in graph", entryHash, expired) +
      entryButton("createBranch", "git-branch-create", recoverTitle, entryHash, !canRecover) +
      entryButton("checkoutCommit", "debug-restart", "Checkout this reflog commit detached", entryHash, expired) +
      entryButton("copyCommitHash", "copy", "Copy reflog commit hash", entryHash) +
      `</div>` +
      `</article>`;
  }

  /** toolbar/panel icon button HTML 을 만든다. */
  function iconButton(id, icon, title) {
    return `<button id="${id}" class="icon-button" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** reflog 항목 액션 버튼 HTML 을 만든다. */
  function entryButton(action, icon, title, hash, disabled) {
    const clean = cleanHash(hash);
    return `<button class="reflog-entry-button" type="button" data-reflog-action="${esc(action)}" ` +
      `data-hash="${esc(clean)}" title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}" ${disabled ? "disabled" : ""}>` +
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
    render();
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
  function syncGraphMarkers() {
    clearGraphMarkers();
    if (!graphContent || panel?.hidden || !entries.length) {
      return;
    }
    const virtualMarkers = entries.map((entry, index) => eventMarker(entry, index)).filter(Boolean);
    window.GscGraphReflogMarkers?.renderVirtualBranch?.(graphContent, virtualMarkers);
    refreshActiveMarks();
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
    render();
    window.GscGraphReflogDetail?.show?.(entry, index, { loaded: hashLoaded(entry.hash) });
  }

  /** hash 에 해당하는 row 가 현재 그래프 DOM 에 로드되어 있는지 확인한다. */
  function hashLoaded(hash) {
    return Boolean(rowForHash(cleanHash(hash)));
  }

  /** reflog 항목의 브랜치 출처 근거를 HTML 로 만든다. */
  function provenanceHtml(entry) {
    const chips = [];
    const currentRefs = window.GscGraphReflogModel?.currentRefNames?.(entry) || [];
    if (currentRefs.length) {
      chips.push(chipHtml("Current flow", currentRefs.join(", ")));
    }
    const move = entry.checkoutMove;
    if (move?.from) {
      chips.push(chipHtml("Moved from", move.from));
    }
    if (move?.to && move.to !== move.from) {
      chips.push(chipHtml("To", move.to));
    }
    const localBranches = window.GscGraphReflogModel?.branchSourceNames?.(entry, "local") || [];
    if (localBranches.length) {
      chips.push(chipHtml("Branch log", localBranches.join(", ")));
    }
    const remoteBranches = window.GscGraphReflogModel?.branchSourceNames?.(entry, "remote") || [];
    if (remoteBranches.length) {
      chips.push(chipHtml("Remote log", remoteBranches.join(", ")));
    }
    if (!chips.length) {
      return `<div class="reflog-provenance muted">No branch reflog evidence</div>`;
    }
    return `<div class="reflog-provenance" title="${esc(window.GscGraphReflogModel?.provenanceTitle?.(entry) || "")}">${chips.join("")}</div>`;
  }

  /** 브랜치 출처 표시용 chip HTML 을 만든다. */
  function chipHtml(label, value) {
    return `<span class="reflog-origin-chip"><em>${esc(label)}</em><strong>${esc(value)}</strong></span>`;
  }

  /** HEAD reflog 이벤트를 가상 브랜치 marker 모델로 변환한다. */
  function eventMarker(entry, index) {
    const hash = cleanHash(entry.hash);
    if (!hash) return undefined;
    const fromHash = cleanHash(entry.transition?.fromHash);
    const row = rowForHash(hash);
    return {
      hash,
      fromHash,
      toHash: hash,
      fromRow: rowForHash(fromHash),
      toRow: row,
      index,
      flow: modelIsHistoryChange(entry) ? "changed" : flowState(entry),
      recovery: modelRecoveryKind(entry),
      recoveryLabel: modelRecoveryLabel(entry),
      status: virtualStatusLabel(entry, Boolean(row)),
      event: eventLabel(entry),
      subject: entry.message || "HEAD reflog entry",
      title: eventMarkerTitle(entry, index, Boolean(rowForHash(fromHash)), Boolean(row)),
    };
  }

  /** 가상 HEAD 이벤트 marker tooltip 을 만든다. */
  function eventMarkerTitle(entry, index, fromLoaded, toLoaded) {
    const from = shortHash(entry.transition?.fromHash) || "unknown";
    const to = shortHash(entry.hash);
    const placement = fromLoaded || toLoaded ? "between visible commits" : "off current graph";
    return `Reflog log R${index + 1}: ${from} -> ${to} | ${modelRecoveryLabel(entry)} | ${eventLabel(entry)} | ${relationSummary(entry, toLoaded)} | ${placement}`;
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
    return window.GscGraphReflogModel?.relationSummary?.(entry, loaded) || "HEAD reflog entry.";
  }

  /** HEAD 전이를 짧은 텍스트로 표시한다. */
  function transitionText(entry) {
    const from = shortHash(entry.transition?.fromHash) || "unknown";
    const to = shortHash(entry.hash);
    return `HEAD ${from} -> ${to}`;
  }

  /** 현재 로드된 그래프에 표시 가능한 reflog 항목 수를 계산한다. */
  function visibleEntryCount() {
    return entries.filter((entry) => hashLoaded(entry.hash)).length;
  }

  /** 현재 렌더된 graph row 중 hash 가 같은 요소를 찾는다. */
  function rowForHash(hash) {
    return graphContent?.querySelector(`.row[data-hash="${cssEscape(cleanHash(hash))}"]`) || null;
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
      syncFrame = 0;
      if (!panel?.hidden) {
        render();
      }
    });
  }

  /** 그래프 DOM 교체를 감지해 reflog marker 를 최신 row/node 로 옮긴다. */
  function observeGraph() {
    if (!graphContent) return;
    const observer = new MutationObserver(scheduleGraphSync);
    observer.observe(graphContent, { childList: true });
  }

  updateToggleButton(false);
  button?.addEventListener("click", togglePanel);
  window.addEventListener("gsc-reflog-show-in-graph", (event) => showInGraph(event.detail?.hash || ""));
  window.addEventListener("gsc-reflog-select", (event) => showEntryDetail(Number(event.detail?.index)));
  window.addEventListener("gsc-reflog-recover", (event) => window.GscGraphPostMessage?.({ type: "createBranch", hash: cleanHash(event.detail?.hash) }));
  observeGraph();
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "graphReflog") {
      entries = Array.isArray(msg.entries) ? msg.entries : [];
      loading = false;
      if (!panel?.hidden) {
        render();
      }
    } else if (msg.type === "commitVisibility" && pendingJump?.requestId === msg.requestId) {
      const hash = cleanHash(msg.hash || pendingJump.hash);
      pendingJump = undefined;
      if (msg.found) {
        window.requestAnimationFrame(() => jumpToHash(hash));
      } else if (!panel?.hidden) {
        render();
      }
    }
  });
})();
