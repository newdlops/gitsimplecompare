// rebase 행의 장식 DOM을 재사용하고, 읽기/쓰기를 분리해 큰 계획에서도 layout 재계산을 제한한다.
(function () {
  "use strict";

  /** 계획 밖 행에서 rebase 장식만 제거한다. 일반 그래프 내용과 포커스는 건드리지 않는다. */
  function clear(row) {
    row.classList.remove("rebase-row", "rebase-preview-moved");
    row.style.transform = "";
    row.querySelector(".rebase-order")?.remove();
    row.querySelector(".rebase-action-marker")?.remove();
    row.querySelector(".rebase-row-actions")?.remove();
    delete row.dataset.rebaseAction;
  }

  /**
   * 커밋 행의 순서/액션 장식을 갱신한다. 버튼은 최초 한 번만 만들어 입력·액션 변경 중 포커스를 유지한다.
   * @param row 현재 그래프 행, item 현재 todo 모델, actions 사용 가능한 액션, onAction 해시/액션 콜백
   */
  function decorate(row, item, actions, onAction) {
    row.classList.add("rebase-row");
    let badge = row.querySelector(".rebase-order");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rebase-order";
      row.appendChild(badge);
    }
    const order = String(item.originalOrder + 1);
    if (badge.textContent !== order) {
      badge.textContent = order;
      badge.title = `Original rebase order ${order}`;
    }
    let marker = row.querySelector(".rebase-action-marker");
    if (!marker) {
      marker = document.createElement("span");
      row.appendChild(marker);
    }
    let box = row.querySelector(".rebase-row-actions");
    const created = !box;
    if (!box) {
      box = document.createElement("span");
      box.className = "rebase-row-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rebase-action-button";
        button.title = action.tooltip;
        button.dataset.tooltip = action.tooltip;
        button.setAttribute("aria-label", action.tooltip);
        button.dataset.action = action.action;
        button.innerHTML = `<span class="codicon codicon-${action.icon}" aria-hidden="true"></span>`;
        box.appendChild(button);
      }
      box.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        event.stopPropagation();
        onAction(item.hash, button.dataset.action);
      });
      row.appendChild(box);
    }
    if (created || row.dataset.rebaseAction !== item.action) {
      marker.className = `rebase-action-marker action-${item.action}`;
      marker.textContent = item.action;
      marker.title = `Rebase action: ${item.action}`;
      for (const button of box.children) {
        const active = button.dataset.action === item.action;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      row.dataset.rebaseAction = item.action;
    }
  }

  /**
   * 전체 행의 위치를 먼저 한 번 읽고 계획 순서를 화면 슬롯에 투영한다. DOM 변경은 호출자가 나중에 수행한다.
   * @param graphContent 그래프 root, visualItems 최신 커밋부터의 todo, hashes 현재 계획의 해시 집합
   * @returns 해시별 행/목표 y/이동량을 담은 layout
   */
  function layout(graphContent, visualItems, hashes) {
    const rows = [];
    const byRowHash = new Map();
    for (const row of graphContent.querySelectorAll(".row")) {
      if (!hashes.has(row.dataset.hash)) continue;
      const top = row.offsetTop;
      const slot = { row, top, y: top + row.offsetHeight / 2 };
      rows.push(slot);
      byRowHash.set(row.dataset.hash, slot);
    }
    rows.sort((a, b) => a.top - b.top);
    const byHash = new Map();
    visualItems.forEach((item, index) => {
      const original = byRowHash.get(item.hash), slot = rows[index];
      if (original && slot) byHash.set(item.hash, {
        item, row: original.row, top: slot.top, y: slot.y, dy: slot.top - original.top,
      });
    });
    return { byHash };
  }

  window.GscGraphRebaseRows = { clear, decorate, layout };
})();
