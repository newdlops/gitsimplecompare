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

  /** reflog 패널을 렌더링한다. */
  function render() {
    if (!panel || panel.hidden) {
      return;
    }
    panel.innerHTML =
      `<header>` +
      `<div><strong>Reflog Recovery</strong><span>${esc(statusText())}</span></div>` +
      `<div class="reflog-actions">` +
      iconButton("refresh-reflog", "refresh", "Refresh reflog") +
      iconButton("close-reflog", "close", "Close reflog") +
      `</div></header>` +
      `<div class="reflog-help">Create a branch at a reflog entry before experimenting with checkout or rebase recovery.</div>` +
      `<div class="reflog-list">${entriesHtml()}</div>`;
    panel.querySelector("#refresh-reflog")?.addEventListener("click", requestReflog);
    panel.querySelector("#close-reflog")?.addEventListener("click", closePanel);
    panel.querySelectorAll(".reflog-entry").forEach((entry) => {
      entry.addEventListener("mouseenter", () => setHoverHash(entry.dataset.hash || ""));
      entry.addEventListener("mouseleave", () => setHoverHash(""));
      entry.addEventListener("focusin", () => setHoverHash(entry.dataset.hash || ""));
      entry.addEventListener("focusout", () => setHoverHash(""));
    });
    panel.querySelectorAll("[data-reflog-action]").forEach((action) => {
      action.addEventListener("click", () => postEntryAction(action));
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
    const state = loaded ? "On graph" : "Not loaded";
    const classes = [
      "reflog-entry",
      loaded ? "graph-loaded" : "graph-missing",
      entryHash === activeHash ? "graph-active" : "",
      entryHash === hoverHash ? "graph-hover" : "",
    ].filter(Boolean).join(" ");
    return `<article class="${classes}" data-hash="${esc(entryHash)}">` +
      `<div class="reflog-index">${esc(index + 1)}</div>` +
      `<div class="reflog-main">` +
      `<div class="reflog-title"><code>${esc(hash)}</code><strong>${esc(message)}</strong>` +
      `<span class="reflog-graph-state">${esc(state)}</span></div>` +
      `<div class="reflog-meta"><span>${esc(entry.shortSelector || entry.selector)}</span>` +
      `<span>${esc(date)}</span></div>` +
      `</div>` +
      `<div class="reflog-entry-actions">` +
      entryButton("showInGraph", "target", loaded ? "Show this reflog entry in graph" : "Load and show this reflog entry in graph", entryHash) +
      entryButton("createBranch", "git-branch-create", "Create branch at this reflog entry", entryHash) +
      entryButton("checkoutCommit", "debug-restart", "Checkout this reflog commit detached", entryHash) +
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
  function entryButton(action, icon, title, hash) {
    const clean = cleanHash(hash);
    return `<button class="reflog-entry-button" type="button" data-reflog-action="${esc(action)}" ` +
      `data-hash="${esc(clean)}" title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** reflog 항목 버튼 클릭을 기존 graph action 메시지로 변환한다. */
  function postEntryAction(button) {
    const hash = cleanHash(button.dataset.hash);
    if (!hash) {
      return;
    }
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
    if (!hash) {
      return;
    }
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

  /** 로드된 그래프에 reflog row badge 와 node 표시를 다시 붙인다. */
  function syncGraphMarkers() {
    clearGraphMarkers();
    if (!graphContent || panel?.hidden || !entries.length) {
      return;
    }
    groupedEntries().forEach((items, hash) => {
      const row = rowForHash(hash);
      if (!row) {
        return;
      }
      const node = nodeForHash(hash);
      const first = items[0];
      row.classList.add("reflog-linked-row");
      row.dataset.originalTitle = row.dataset.originalTitle || row.title || "";
      row.title = `${row.dataset.originalTitle}${row.dataset.originalTitle ? " | " : ""}${markerTitle(items)}`;
      row.appendChild(markerBadge(first.entry, first.index, items));
      node?.classList.add("reflog-linked-node");
    });
    refreshActiveMarks();
  }

  /** 이전 reflog 그래프 표시를 모두 제거한다. */
  function clearGraphMarkers() {
    if (!graphContent) {
      return;
    }
    graphContent.querySelectorAll(".reflog-graph-marker").forEach((marker) => marker.remove());
    graphContent.querySelectorAll(".reflog-linked-row,.reflog-active-row,.reflog-hover-row").forEach((row) => {
      row.classList.remove("reflog-linked-row", "reflog-active-row", "reflog-hover-row");
      if (row.dataset.originalTitle != null) {
        row.title = row.dataset.originalTitle;
        delete row.dataset.originalTitle;
      }
    });
    graphContent.querySelectorAll(".reflog-linked-node,.reflog-active-node,.reflog-hover-node").forEach((node) => {
      node.classList.remove("reflog-linked-node", "reflog-active-node", "reflog-hover-node");
    });
  }

  /** active/hover 상태 class 를 row/node 에 반영한다. */
  function refreshActiveMarks() {
    if (!graphContent) {
      return;
    }
    graphContent.querySelectorAll(".reflog-active-row,.reflog-hover-row").forEach((row) => {
      row.classList.remove("reflog-active-row", "reflog-hover-row");
    });
    graphContent.querySelectorAll(".reflog-active-node,.reflog-hover-node").forEach((node) => {
      node.classList.remove("reflog-active-node", "reflog-hover-node");
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
    nodeForHash(hash)?.classList.add(`reflog-${kind}-node`);
  }

  /** reflog entries 를 hash 별로 묶어 그래프 badge 하나에 여러 시점을 담는다. */
  function groupedEntries() {
    const groups = new Map();
    entries.forEach((entry, index) => {
      const hash = cleanHash(entry.hash);
      if (!hash) {
        return;
      }
      const group = groups.get(hash) || [];
      group.push({ entry, index });
      groups.set(hash, group);
    });
    return groups;
  }

  /** 그래프 row 에 붙일 reflog badge 를 만든다. */
  function markerBadge(entry, index, items) {
    const badge = document.createElement("span");
    badge.className = "reflog-graph-marker";
    badge.textContent = markerLabel(entry, index, items.length);
    badge.title = markerTitle(items);
    return badge;
  }

  /** row badge 에 표시할 짧은 reflog 시점 라벨을 만든다. */
  function markerLabel(entry, index, count) {
    const suffix = count > 1 ? ` +${count - 1}` : "";
    const time = timeLabel(entry.dateIso);
    return `R${index + 1}${time ? ` ${time}` : ""}${suffix}`;
  }

  /** row badge tooltip 에 표시할 reflog 시점 설명을 만든다. */
  function markerTitle(items) {
    const lines = items.slice(0, 4).map((item) => {
      const entry = item.entry;
      const selector = entry.shortSelector || entry.selector || `R${item.index + 1}`;
      return `R${item.index + 1} ${selector}: ${entry.message || "reflog entry"}`;
    });
    if (items.length > lines.length) {
      lines.push(`${items.length - lines.length} more reflog entries`);
    }
    return `Reflog: ${lines.join(" | ")}`;
  }

  /** hash 에 해당하는 row 가 현재 그래프 DOM 에 로드되어 있는지 확인한다. */
  function hashLoaded(hash) {
    return Boolean(rowForHash(cleanHash(hash)));
  }

  /** 현재 로드된 그래프에 표시 가능한 reflog 항목 수를 계산한다. */
  function visibleEntryCount() {
    return entries.filter((entry) => hashLoaded(entry.hash)).length;
  }

  /** 현재 렌더된 graph row 중 hash 가 같은 요소를 찾는다. */
  function rowForHash(hash) {
    return graphContent?.querySelector(`.row[data-hash="${cssEscape(cleanHash(hash))}"]`) || null;
  }

  /** 현재 렌더된 graph node 중 hash 가 같은 요소를 찾는다. */
  function nodeForHash(hash) {
    return graphContent?.querySelector(`.node[data-hash="${cssEscape(cleanHash(hash))}"]`) || null;
  }

  /** 커밋 해시를 짧게 줄인다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 10);
  }

  /** reflog selector 날짜를 보기 좋은 짧은 형태로 만든다. */
  function formatDate(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 그래프 badge 에 넣을 짧은 시간 문자열을 만든다. */
  function timeLabel(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const pad = (num) => String(num).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    if (!graphContent) {
      return;
    }
    const observer = new MutationObserver(scheduleGraphSync);
    observer.observe(graphContent, { childList: true });
  }

  button?.addEventListener("click", togglePanel);
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
