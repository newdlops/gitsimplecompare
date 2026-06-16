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
  let paused = null;
  let operationActive = false;
  let changedDuringOperation = new Set();

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
    const hashes = new Set(items.map((item) => item.hash));
    if (paused?.hash && itemIndexForHash(paused.hash) >= 0) {
      hashes.add(paused.hash);
    }
    return hashes;
  }

  /** 원본 todo 해시와 rebase 중 새로 생긴 paused 해시를 같은 항목으로 매핑한다. */
  function itemIndexForHash(hash) {
    const direct = items.findIndex((item) => item.hash === hash);
    if (direct >= 0) {
      return direct;
    }
    if (paused?.hash === hash && paused.originalHash) {
      return items.findIndex((item) => item.hash === paused.originalHash);
    }
    return -1;
  }

  /** 화면의 row 해시로 현재 rebase todo 항목을 찾는다. */
  function itemForHash(hash) {
    const index = itemIndexForHash(hash);
    return index >= 0 ? items[index] : undefined;
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
    } else if (msg.type === "graphRebasePaused") {
      paused = msg.paused || null;
      operationActive = true;
      changedDuringOperation.clear();
      ensureBar();
      renderPlan();
      window.GscGraphDetail?.refresh?.();
    } else if (msg.type === "graphRebaseOperation") {
      operationActive = Boolean(msg.active);
      ensureBar();
      renderPlan();
      window.GscGraphDetail?.refresh?.();
    } else if (msg.type === "graphRebaseClear") {
      clearPlan();
    } else if (msg.type === "graph") {
      window.setTimeout(renderPlan, 0);
    }
  });
  /** rebase 계획 모드에 들어간다. */
  function enterPlan(nextPlan) {
    plan = nextPlan;
    paused = null;
    operationActive = false;
    changedDuringOperation.clear();
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
    paused = null;
    operationActive = false;
    changedDuringOperation.clear();
    pendingDrop = null;
    hideDropMarker();
    window.GscGraphRebasePreview?.clearTransforms?.(graphContent);
    document.body.classList.remove("graph-rebase-mode");
    document.getElementById("graph-rebase-bar")?.remove();
    graphContent.querySelectorAll(".rebase-row").forEach((row) => {
      row.classList.remove("rebase-row");
      row.querySelector(".rebase-order")?.remove();
      row.querySelector(".rebase-action-marker")?.remove();
      row.querySelector(".rebase-row-actions")?.remove();
    });
    window.GscGraphDetail?.refresh?.();
  }

  /** 상단 rebase 실행 바를 만든다. */
  function ensureBar() {
    if (!plan) {
      return;
    }
    let bar = document.getElementById("graph-rebase-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "graph-rebase-bar";
      graphPane.insertBefore(bar, graphEl);
    }
    const upstream = plan.upstream ? ` · upstream ${esc(plan.upstream)}` : "";
    const base = plan.root ? " · base root" : plan.base ? ` · base ${esc(plan.base.slice(0, 10))}` : "";
    const onto = plan.onto ? ` · onto ${esc(plan.onto.slice(0, 10))}` : "";
    const controls = paused || operationActive
      ? `<button id="graph-rebase-continue" type="button" title="Continue rebase" ` +
        `aria-label="Continue rebase" data-tooltip="Save rebase edit files, amend the paused commit, then run git rebase --continue; Git may pause again at the next edit commit or conflicts">` +
        `<span class="codicon codicon-debug-continue" aria-hidden="true"></span><span>Continue</span></button>` +
        `<button id="graph-rebase-abort" type="button" title="Abort rebase" ` +
        `aria-label="Abort rebase" data-tooltip="Abort the in-progress rebase and restore the branch to the state before the rebase started">` +
        `<span class="codicon codicon-debug-stop" aria-hidden="true"></span><span>Abort</span></button>`
      : `<label id="graph-rebase-squash-option" title="Include squashed commit history in the editable message" data-tooltip="When squash is used, include the squashed commit messages in the editable combined message">` +
        `<input id="graph-rebase-include-squash" type="checkbox" checked /><span>Squash history</span></label>` +
        `<button id="graph-rebase-run" type="button" title="Start rebase" ` +
        `aria-label="Start rebase" data-tooltip="Start this interactive rebase plan for the current branch; selected actions rewrite commits in todo order">` +
        `<span class="codicon codicon-play" aria-hidden="true"></span><span>Start</span></button>` +
        `<button id="graph-rebase-cancel" type="button" title="Cancel rebase plan" ` +
        `aria-label="Cancel rebase plan" data-tooltip="Close the rebase planning UI without running git or changing commits">` +
        `<span class="codicon codicon-close" aria-hidden="true"></span><span>Cancel</span></button>`;
    bar.innerHTML =
      `<span class="codicon codicon-list-ordered" aria-hidden="true"></span>` +
      `<span class="rebase-title">Interactive rebase: ${esc(plan.branch)}${upstream}${base}${onto}</span>` +
      controls;
    bar.querySelector("#graph-rebase-run")?.addEventListener("click", () => runRebase());
    bar.querySelector("#graph-rebase-cancel")?.addEventListener("click", clearPlan);
    bar.querySelector("#graph-rebase-continue")?.addEventListener("click", continueRebase);
    bar.querySelector("#graph-rebase-abort")?.addEventListener("click", abortRebase);
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
      const index = itemIndexForHash(row.dataset.hash);
      const item = index >= 0 ? items[index] : undefined;
      if (item) {
        const slot = layout.byHash.get(row.dataset.hash);
        if (slot && slot.dy !== 0) {
          row.style.transform = `translateY(${slot.dy}px)`;
          row.classList.add("rebase-preview-moved");
        }
        row.appendChild(orderBadge(item));
        row.appendChild(actionMarker(item));
        row.appendChild(actionButtons(item));
      }
    });
    window.GscGraphRebasePreview?.applyNodeTransforms?.(graphContent, layout.byHash);
    window.GscGraphRebasePreview?.renderBranch?.(
      graphContent,
      plan,
      layout,
      visualItems(),
      planDiffersFromGraph()
    );
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
    const item = itemForHash(hash);
    if (!item) {
      return;
    }
    item.action = action;
    if (paused || operationActive) changedDuringOperation.add(item.hash);
    if (MESSAGE_ACTIONS.has(action) && !item.message) {
      item.message = defaultMessage(item, action);
    }
    renderPlan();
    if (MESSAGE_ACTIONS.has(action)) {
      openCommitDetails(hash);
    }
  }
  /** drawer textarea 에 넣을 rebase 메시지 기본값을 계산한다. */
  function defaultMessage(item, action) {
    const include = document.getElementById("graph-rebase-include-squash")?.checked !== false;
    return window.GscGraphRebaseMessages?.defaultMessage?.(items, item, action, include) ||
      item.body || item.subject || "";
  }

  /** 커밋 row 클릭과 같은 경로로 drawer 상세를 연다. */
  function openCommitDetails(hash) {
    const row = graphContent.querySelector(`.row[data-hash="${cssEscape(hash)}"]`);
    if (row) {
      row.click();
      return;
    }
    window.GscGraphPostMessage?.({ type: "selectCommit", hash });
  }
  /** CSS selector 에 넣을 값을 이스케이프한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  /** drawer 편집 UI 에서 rebase action 을 갱신한다. */
  function updateAction(hash, action) {
    setAction(hash, action);
  }

  /** drawer 편집 UI 에서 메시지를 갱신한다. */
  function updateMessage(hash, message) {
    const item = itemForHash(hash);
    if (!item) {
      return;
    }
    item.message = message || "";
    if (paused || operationActive) changedDuringOperation.add(item.hash);
    if (item.action === "pick") {
      item.action = "reword";
    }
    renderPlan();
  }

  /** drawer 편집 UI 에서 커밋 단위 파일 제외를 토글한다. */
  function toggleCommitExclude(hash, path) {
    const item = itemForHash(hash);
    if (item) {
      togglePath(item, "excludePaths", path);
      if (paused || operationActive) changedDuringOperation.add(item.hash);
      renderPlan();
    }
  }

  /** drawer 편집 UI 에서 rebase 범위 전체 파일 제외를 토글한다. */
  function toggleHistoryExclude(path) {
    const enabled = items.some((item) => (item.historyExcludePaths || []).includes(path));
    for (const item of items) {
      setPath(item, "historyExcludePaths", path, !enabled);
      if (paused || operationActive) changedDuringOperation.add(item.hash);
    }
    renderPlan();
  }

  /** item 의 경로 배열에서 값을 토글한다. */
  function togglePath(item, key, path) {
    setPath(item, key, path, !(item[key] || []).includes(path));
  }

  /** item 의 경로 배열에 값을 명시적으로 반영한다. */
  function setPath(item, key, path, enabled) {
    const next = new Set(item[key] || []);
    enabled ? next.add(path) : next.delete(path);
    item[key] = Array.from(next);
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
  function runRebase(editPath = "") {
    if (!plan) {
      return;
    }
    window.GscGraphPostMessage?.({
      type: "runGraphRebase",
      base: plan.base,
      root: Boolean(plan.root),
      onto: plan.onto || "",
      editPath,
      items: itemsPayload(),
    });
  }

  /** 확장 호스트에 보낼 현재 rebase 계획 payload 를 만든다. */
  function itemsPayload() {
    return items.map((item) => ({ hash: item.hash, action: item.action,
      message: item.message || (item.action === "squash" ? window.GscGraphRebaseMessages?.defaultMessage?.(items, item, item.action, document.getElementById("graph-rebase-include-squash")?.checked !== false) || "" : ""),
      excludePaths: item.excludePaths || [], historyExcludePaths: item.historyExcludePaths || [] }));
  }

  /** edit 파일 버튼에서 rebase 시작 또는 paused edit 파일 열기를 요청한다. */
  function requestEditFile(path) {
    if (!path) {
      return;
    }
    if (paused) {
      window.GscGraphPostMessage?.({ type: "openRebaseEditFile", path });
      return;
    }
    runRebase(path);
  }

  /** 멈춰 있는 rebase 를 확장 호스트에 계속 진행하도록 요청한다. */
  function continueRebase() {
    window.GscGraphPostMessage?.({
      type: "continueGraphRebase",
      items: itemsPayload(),
      changedHashes: Array.from(changedDuringOperation),
    });
  }

  /** 멈춰 있는 rebase 를 확장 호스트에 취소하도록 요청한다. */
  function abortRebase() {
    window.GscGraphPostMessage?.({ type: "abortGraphRebase" });
  }

  /** graph context menu 에 합쳐 넣을 rebase 전용 항목을 만든다. */
  function contextMenuItems(hash) {
    if (!plan || !itemHashSet().has(hash)) {
      return [];
    }
    return [
      ...ACTIONS.map((action) => ({
        label: action.label,
        icon: action.icon,
        title: action.tooltip,
        run: () => setAction(hash, action.action),
      })),
      {
        label: "Commit details",
        icon: "comment-discussion",
        title: "Edit commit message and excluded files",
        run: () => openCommitDetails(hash),
      },
    ];
  }

  window.GscGraphRebaseContext = {
    contextMenuItems,
    plan: () => plan,
    itemForHash,
    items: () => items,
    render: renderPlan,
    paused: () => paused,
    requestEditFile,
    continueRebase,
    abortRebase,
    updateAction,
    updateMessage,
    toggleCommitExclude,
    toggleHistoryExclude,
  };
})();
