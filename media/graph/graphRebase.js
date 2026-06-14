// 그래프 내부 interactive rebase POC.
// - row/node 드래그로 현재 브랜치 rebase 계획을 만들고, row 위 마커/액션 버튼으로 todo 를 편집한다.
(function () {
  "use strict";

  const ACTIONS = [
    { action: "pick", icon: "check", label: "Pick", tooltip: "Pick this commit as-is" },
    { action: "reword", icon: "edit", label: "Reword", tooltip: "Edit this commit message during rebase" },
    { action: "edit", icon: "debug-pause", label: "Edit", tooltip: "Pause rebase at this commit" },
    { action: "squash", icon: "combine", label: "Squash", tooltip: "Squash this commit into the previous commit" },
    { action: "fixup", icon: "wand", label: "Fixup", tooltip: "Fix up the previous commit and discard this message" },
    { action: "drop", icon: "trash", label: "Drop", tooltip: "Remove this commit from the rebased branch" },
  ];
  const MESSAGE_ACTIONS = new Set(["reword", "squash"]);

  const graphPane = document.getElementById("graph-pane");
  const graphEl = document.getElementById("graph");
  const graphContent = document.getElementById("graph-content");
  let plan = null;
  let items = [];
  let originalOrder = [];
  let drag = null;
  let pendingDrop = null;
  let marker = null;
  let menu = null;

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text == null ? "" : text).replace(/[&<>"]/g, (ch) => map[ch]);
  }

  /** 실제 커밋 해시인지 확인한다(가상 working tree/staged 노드는 제외). */
  function isRealHash(hash) {
    return hash && !hash.startsWith("__gsc_virtual_");
  }

  /** 현재 rebase 계획에 포함된 해시 집합을 반환한다. */
  function itemHashSet() {
    return new Set(items.map((item) => item.hash));
  }
  /** 그래프 표시 순서(위=newer)에 맞춘 계획 배열을 반환한다. */
  function visualItems() {
    return [...items].reverse();
  }
  /** row/node 드래그 시작 상태를 저장한다. */
  window.addEventListener("gsc-node-drag-start", (event) => {
    const hash = event.detail?.hash || "";
    if (!isRealHash(hash)) {
      return;
    }
    drag = {
      hash,
      x: event.detail.x,
      y: event.detail.y,
      activeAtStart: Boolean(plan),
    };
  });

  /** 드래그 중인 위치에 rebase drop marker 를 보여준다. */
  window.addEventListener("gsc-node-drag", (event) => {
    if (!drag || !plan) {
      return;
    }
    const y = drag.y + event.detail.dy;
    const target = nearestPlanRow(y);
    showDropMarker(target, y);
  });
  /** 드래그 종료 시 계획 진입 또는 계획 재정렬을 수행한다. */
  window.addEventListener("gsc-node-drag-end", (event) => {
    if (!drag) {
      return;
    }
    const y = drag.y + event.detail.dy;
    const moved = Math.hypot(event.detail.dx, event.detail.dy) > 8;
    hideDropMarker();
    if (!moved) {
      drag = null;
      return;
    }
    if (plan) {
      const target = nearestPlanRow(y);
      reorderByVisualTarget(drag.hash, target?.dataset.hash || "", isAfter(target, y));
      drag = null;
      return;
    }
    const target = nearestCommitRow(y);
    pendingDrop = {
      hash: drag.hash,
      targetHash: target?.dataset.hash || "",
      after: isAfter(target, y),
    };
    window.GscGraphPostMessage?.({
      type: "prepareGraphRebase",
      hash: drag.hash,
      onto: pendingDrop.targetHash || "",
    });
    drag = null;
  });

  /** 확장에서 받은 rebase 계획/정리 메시지를 처리한다. */
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "graphRebasePlan") {
      enterPlan(msg.plan);
    } else if (msg.type === "graphRebaseClear") {
      clearPlan();
    } else if (msg.type === "graph") {
      window.setTimeout(renderPlan, 0);
    }
  });
  /** 우클릭 컨텍스트 메뉴와 외부 클릭 닫기를 연결한다. */
  graphContent.addEventListener("contextmenu", (event) => {
    if (!plan) {
      return;
    }
    const row = event.target.closest?.(".row");
    if (!row || !itemHashSet().has(row.dataset.hash)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(row.dataset.hash, event.clientX, event.clientY);
  }, true);
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("#graph-rebase-menu")) {
      closeContextMenu();
    }
  });
  /** rebase 계획 모드에 들어간다. */
  function enterPlan(nextPlan) {
    plan = nextPlan;
    items = (nextPlan.commits || []).map((commit) => ({
      hash: commit.hash,
      action: "pick",
      message: "",
      subject: commit.subject,
      body: commit.body || "",
      files: commit.files || [], excludePaths: [], historyExcludePaths: [],
      originalOrder: 0,
    }));
    items.forEach((item, index) => {
      item.originalOrder = index;
    });
    originalOrder = items.map((item) => item.hash);
    if (pendingDrop && itemHashSet().has(pendingDrop.targetHash)) {
      reorderByVisualTarget(pendingDrop.hash, pendingDrop.targetHash, pendingDrop.after);
    }
    pendingDrop = null;
    document.body.classList.add("graph-rebase-mode");
    ensureBar();
    renderPlan();
  }

  /** rebase 계획 모드를 종료하고 DOM 흔적을 제거한다. */
  function clearPlan() {
    plan = null;
    items = [];
    originalOrder = [];
    pendingDrop = null;
    hideDropMarker();
    closeContextMenu();
    clearRebaseTransforms();
    removePreviewBranch();
    document.body.classList.remove("graph-rebase-mode");
    document.getElementById("graph-rebase-bar")?.remove();
    graphContent.querySelectorAll(".rebase-row").forEach((row) => {
      row.classList.remove("rebase-row");
      row.querySelector(".rebase-order")?.remove();
      row.querySelector(".rebase-action-marker")?.remove();
      row.querySelector(".rebase-row-actions")?.remove();
    });
  }

  /** 상단 rebase 실행 바를 만든다. */
  function ensureBar() {
    let bar = document.getElementById("graph-rebase-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "graph-rebase-bar";
      graphPane.insertBefore(bar, graphEl);
    }
    const upstream = plan.upstream ? ` · upstream ${esc(plan.upstream)}` : "";
    const base = plan.root ? " · base root" : plan.base ? ` · base ${esc(plan.base.slice(0, 10))}` : "";
    const onto = plan.onto ? ` · onto ${esc(plan.onto.slice(0, 10))}` : "";
    bar.innerHTML =
      `<span class="codicon codicon-list-ordered" aria-hidden="true"></span>` +
      `<span class="rebase-title">Interactive rebase: ${esc(plan.branch)}${upstream}${base}${onto}</span>` +
      `<label id="graph-rebase-squash-option" title="Include squashed commit history in the editable message" data-tooltip="Include squashed commit history in the editable message">` +
      `<input id="graph-rebase-include-squash" type="checkbox" checked /><span>Squash history</span></label>` +
      `<button id="graph-rebase-run" type="button" title="Start rebase" ` +
      `aria-label="Start rebase" data-tooltip="Start rebase with this plan">` +
      `<span class="codicon codicon-play" aria-hidden="true"></span><span>Start</span></button>` +
      `<button id="graph-rebase-cancel" type="button" title="Cancel rebase plan" ` +
      `aria-label="Cancel rebase plan" data-tooltip="Cancel this rebase plan">` +
      `<span class="codicon codicon-close" aria-hidden="true"></span><span>Cancel</span></button>`;
    bar.querySelector("#graph-rebase-run").addEventListener("click", runRebase);
    bar.querySelector("#graph-rebase-cancel").addEventListener("click", clearPlan);
  }

  /** 현재 계획을 그래프 row 에 마커/호버 액션으로 반영한다. */
  function renderPlan() {
    if (!plan) {
      return;
    }
    const hashes = itemHashSet();
    const layout = rebaseVisualLayout();
    graphContent.querySelectorAll(".row").forEach((row) => {
      row.classList.toggle("rebase-row", hashes.has(row.dataset.hash));
      row.classList.remove("rebase-preview-moved");
      row.style.transform = "";
      row.querySelector(".rebase-order")?.remove();
      row.querySelector(".rebase-action-marker")?.remove();
      row.querySelector(".rebase-row-actions")?.remove();
      const index = items.findIndex((item) => item.hash === row.dataset.hash);
      if (index >= 0) {
        const slot = layout.byHash.get(row.dataset.hash);
        if (slot && slot.dy !== 0) {
          row.style.transform = `translateY(${slot.dy}px)`;
          row.classList.add("rebase-preview-moved");
        }
        row.appendChild(orderBadge(items[index]));
        row.appendChild(actionMarker(items[index]));
        row.appendChild(actionButtons(items[index]));
      }
    });
    applyNodeTransforms(layout.byHash);
    renderPreviewBranch(layout);
  }

  /** 원래 todo 순서 번호 배지를 만든다(드래그 후에도 바뀌지 않는다). */
  function orderBadge(item) {
    const badge = document.createElement("span");
    badge.className = "rebase-order";
    badge.textContent = String(item.originalOrder + 1);
    badge.title = `Original rebase order ${item.originalOrder + 1}`;
    return badge;
  }

  /** 현재 todo action 을 표시하는 마커를 만든다. */
  function actionMarker(item) {
    const markerEl = document.createElement("span");
    markerEl.className = `rebase-action-marker action-${item.action}`;
    markerEl.textContent = item.action;
    markerEl.title = `Rebase action: ${item.action}`;
    return markerEl;
  }

  /** row hover 시 보이는 rebase action 아이콘 묶음을 만든다. */
  function actionButtons(item) {
    const box = document.createElement("span");
    box.className = "rebase-row-actions";
    for (const action of ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rebase-action-button${item.action === action.action ? " active" : ""}`;
      button.title = action.tooltip;
      button.dataset.tooltip = action.tooltip;
      button.setAttribute("aria-label", action.tooltip);
      button.dataset.action = action.action;
      button.innerHTML = `<span class="codicon codicon-${action.icon}" aria-hidden="true"></span>`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setAction(item.hash, action.action);
      });
      box.appendChild(button);
    }
    return box;
  }

  /** 특정 커밋의 rebase action 을 바꾸고 필요한 메시지를 입력받는다. */
  function setAction(hash, action) {
    const item = items.find((entry) => entry.hash === hash);
    if (!item) {
      return;
    }
    item.action = action;
    if (MESSAGE_ACTIONS.has(action) && !item.message) {
      const message = window.GscGraphRebaseMessages?.defaultMessage?.(items, item, action, document.getElementById("graph-rebase-include-squash")?.checked !== false) || item.body || item.subject || "";
      item.message = window.prompt(`${action} message`, message) || "";
    }
    renderPlan();
  }

  /** 커밋 우클릭 액션 메뉴를 연다. */
  function showContextMenu(hash, x, y) {
    closeContextMenu();
    menu = document.createElement("div");
    menu.id = "graph-rebase-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.innerHTML = ACTIONS.map((action) =>
      `<button type="button" data-action="${action.action}" title="${esc(action.tooltip)}" ` +
      `aria-label="${esc(action.tooltip)}" data-tooltip="${esc(action.tooltip)}">` +
      `<span class="codicon codicon-${action.icon}" aria-hidden="true"></span>${action.label}</button>`
    ).join("") +
      `<button type="button" data-edit-message="1" title="Edit queued rebase message" ` +
      `aria-label="Edit commit details" data-tooltip="Edit commit message and excluded files">` +
      `<span class="codicon codicon-comment-discussion" aria-hidden="true"></span>Commit details</button>`;
    menu.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) {
        return;
      }
      if (button.dataset.action) {
        setAction(hash, button.dataset.action);
      } else {
        window.GscGraphRebaseDetail?.open(items, hash, renderPlan) || editMessage(hash);
      }
      closeContextMenu();
    });
    document.body.appendChild(menu);
  }

  /** 메시지 큐에 넣을 커밋 메시지를 직접 편집한다. */
  function editMessage(hash) {
    const item = items.find((entry) => entry.hash === hash);
    if (!item) {
      return;
    }
    const message = item.message || window.GscGraphRebaseMessages?.defaultMessage?.(items, item, item.action, document.getElementById("graph-rebase-include-squash")?.checked !== false) || item.body || item.subject || "";
    item.message = window.prompt("Commit message", message) || "";
    if (item.action === "pick") {
      item.action = "reword";
    }
    renderPlan();
  }

  /** 열린 컨텍스트 메뉴를 닫는다. */
  function closeContextMenu() {
    menu?.remove();
    menu = null;
  }

  /** 계획 row 중 y 좌표와 가장 가까운 row 를 찾는다. */
  function nearestPlanRow(y) {
    const hashes = itemHashSet();
    return nearestRow(y, (row) => hashes.has(row.dataset.hash));
  }

  /** 전체 커밋 row 중 y 좌표와 가장 가까운 실제 커밋 row 를 찾는다. */
  function nearestCommitRow(y) {
    return nearestRow(y, (row) => isRealHash(row.dataset.hash));
  }

  /** 조건을 만족하는 row 중 y 좌표와 가장 가까운 row 를 찾는다. */
  function nearestRow(y, predicate) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    graphContent.querySelectorAll(".row").forEach((row) => {
      if (!predicate(row)) {
        return;
      }
      const rect = row.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - y);
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    });
    return best;
  }

  /** y 좌표가 row 의 아래 절반인지 확인한다. */
  function isAfter(row, y) {
    if (!row) {
      return false;
    }
    const rect = row.getBoundingClientRect();
    return y > rect.top + rect.height / 2;
  }

  /** 그래프 표시 순서를 기준으로 드래그한 커밋을 재배치한다. */
  function reorderByVisualTarget(hash, targetHash, after) {
    if (!hash || hash === targetHash) {
      return;
    }
    const visual = visualItems().filter((item) => item.hash !== hash);
    const item = items.find((entry) => entry.hash === hash);
    if (!item) {
      return;
    }
    const targetIndex = visual.findIndex((entry) => entry.hash === targetHash);
    const insertAt = targetIndex < 0 ? 0 : targetIndex + (after ? 1 : 0);
    visual.splice(insertAt, 0, item);
    items = visual.reverse();
    renderPlan();
  }

  /** 현재 todo 순서와 원래 순서를 비교해 그래프 preview 가 필요한지 판단한다. */
  function planDiffersFromGraph() {
    return Boolean(plan?.onto) ||
      items.some((item, index) => item.hash !== originalOrder[index]) ||
      items.some((item) => item.action !== "pick" || item.excludePaths?.length || item.historyExcludePaths?.length);
  }

  /** rebase todo 의 현재 순서를 그래프 row 위치로 투영한다. */
  function rebaseVisualLayout() {
    const hashes = itemHashSet();
    const rowByHash = new Map();
    graphContent.querySelectorAll(".row").forEach((row) => {
      if (hashes.has(row.dataset.hash)) {
        rowByHash.set(row.dataset.hash, row);
      }
    });
    const slots = Array.from(rowByHash.values())
      .sort((a, b) => a.offsetTop - b.offsetTop)
      .map((row) => ({
        top: row.offsetTop,
        y: row.offsetTop + row.offsetHeight / 2,
      }));
    const byHash = new Map();
    visualItems().forEach((item, index) => {
      const row = rowByHash.get(item.hash);
      const slot = slots[index];
      if (!row || !slot) {
        return;
      }
      byHash.set(item.hash, {
        item,
        row,
        top: slot.top,
        y: slot.y,
        dy: slot.top - row.offsetTop,
      });
    });
    return { byHash };
  }

  /** todo 순서가 바뀐 커밋 node 를 새 위치로 옮긴다. */
  function applyNodeTransforms(layout) {
    graphContent.querySelectorAll(".node.rebase-preview-moved-node").forEach((node) => {
      node.removeAttribute("transform");
      node.classList.remove("rebase-preview-moved-node");
    });
    layout.forEach((slot, hash) => {
      const node = nodeForHash(hash);
      if (!node || slot.dy === 0) {
        return;
      }
      node.setAttribute("transform", `translate(0 ${slot.dy})`);
      node.classList.add("rebase-preview-moved-node");
    });
  }

  /** 원본 그래프와 달라지는 계획을 별도 branch preview 로 그린다. */
  function renderPreviewBranch(layout) {
    removePreviewBranch();
    if (!planDiffersFromGraph()) {
      return;
    }
    const svg = graphContent.querySelector("svg");
    if (!svg) {
      return;
    }
    svg.style.overflow = "visible";
    const kept = visualItems().filter(
      (item) => item.action !== "drop" && layout.byHash.has(item.hash)
    );
    if (kept.length === 0) {
      return;
    }
    const x = previewBranchX(svg);
    const group = svgEl("g", { class: "rebase-preview-layer" });
    const points = kept.map((item) => layout.byHash.get(item.hash).y);
    const anchor = previewAnchor(layout);
    const pathParts = anchor
      ? [
          `M ${anchor.x} ${anchor.y}`,
          `L ${x} ${anchor.y}`,
          `L ${x} ${points[0]}`,
          ...points.slice(1).map((y) => `L ${x} ${y}`),
        ]
      : points.map((y, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`);
    group.appendChild(svgEl("path", {
      class: "rebase-preview-edge",
      d: pathParts.join(" "),
    }));
    kept.forEach((item) => {
      const slot = layout.byHash.get(item.hash);
      const node = svgEl("circle", {
        class: `rebase-preview-node action-${item.action}`,
        cx: String(x),
        cy: String(slot.y),
        r: "5",
      });
      const title = svgEl("title", {});
      title.textContent = `rebase preview ${item.originalOrder + 1}: ${item.subject || item.hash}`;
      node.appendChild(title);
      group.appendChild(node);
    });
    svg.appendChild(group);
  }

  /** preview branch 가 갈라져 나오는 기준 node 좌표를 찾는다. */
  function previewAnchor(layout) {
    const anchorHash = plan?.onto || (!plan?.root ? plan?.base : "");
    if (!anchorHash) {
      return null;
    }
    const slot = layout.byHash.get(anchorHash);
    const node = nodeForHash(anchorHash);
    if (slot && node) {
      return {
        x: Number(node.getAttribute("cx")) || 0,
        y: slot.y,
      };
    }
    if (!node) {
      return null;
    }
    return {
      x: Number(node.getAttribute("cx")) || 0,
      y: Number(node.getAttribute("cy")) || 0,
    };
  }

  /** SVG 안에 rebase preview branch 를 놓을 x 좌표를 계산한다. */
  function previewBranchX(svg) {
    const nodes = Array.from(svg.querySelectorAll(".node"));
    const maxX = nodes.reduce(
      (max, node) => Math.max(max, Number(node.getAttribute("cx")) || 0),
      0
    );
    const width = Number(svg.getAttribute("width")) || maxX + 32;
    return Math.min(Math.max(16, maxX + 24), Math.max(16, width - 8));
  }

  /** rebase preview branch SVG layer 를 제거한다. */
  function removePreviewBranch() {
    graphContent.querySelector(".rebase-preview-layer")?.remove();
  }

  /** rebase preview 를 위해 row/node 에 적용한 transform 을 제거한다. */
  function clearRebaseTransforms() {
    graphContent.querySelectorAll(".row").forEach((row) => {
      row.style.transform = "";
      row.classList.remove("rebase-preview-moved");
    });
    graphContent.querySelectorAll(".node.rebase-preview-moved-node").forEach((node) => {
      node.removeAttribute("transform");
      node.classList.remove("rebase-preview-moved-node");
    });
  }

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** 해시로 SVG node 를 찾는다. */
  function nodeForHash(hash) {
    return Array.from(graphContent.querySelectorAll(".node")).find(
      (node) => node.dataset.hash === hash
    );
  }

  /** drop marker 를 대상 row 위/아래에 표시한다. */
  function showDropMarker(row, y) {
    if (!row) {
      hideDropMarker();
      return;
    }
    if (!marker) {
      marker = document.createElement("div");
      marker.id = "graph-rebase-drop-marker";
      graphContent.appendChild(marker);
    }
    marker.style.top = `${row.offsetTop + (isAfter(row, y) ? row.offsetHeight : 0)}px`;
  }

  /** drop marker 를 제거한다. */
  function hideDropMarker() {
    marker?.remove();
    marker = null;
  }

  /** 계획을 실행 메시지로 보낸다. */
  function runRebase() {
    if (!plan) {
      return;
    }
    window.GscGraphPostMessage?.({
      type: "runGraphRebase",
      base: plan.base,
      root: Boolean(plan.root),
      onto: plan.onto || "",
      items: items.map((item) => ({
        hash: item.hash,
        action: item.action,
        message: item.message || (item.action === "squash" ? window.GscGraphRebaseMessages?.defaultMessage?.(items, item, item.action, document.getElementById("graph-rebase-include-squash")?.checked !== false) || "" : ""),
        excludePaths: item.excludePaths || [], historyExcludePaths: item.historyExcludePaths || [],
      })),
    });
  }
})();
