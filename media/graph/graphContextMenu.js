// git graph 웹뷰의 overlay UI.
// - VS Code QuickPick 대신 웹뷰 안에서 context menu 를 보여주고, graph tooltip 을 화면 안에 배치한다.
(function () {
  "use strict";

  const TOOLTIP_GAP = 6;
  const VIEWPORT_EDGE = 8;

  let menuEl;
  let tooltipEl;
  let activeTooltipTarget;

  /** graph-content root 에 contextmenu 이벤트를 한 번만 연결한다. */
  function attach(root, helpers) {
    if (!root) {
      return;
    }
    root.__gscContextHelpers = helpers || {};
    if (root.dataset.graphContextMenuBound === "1") {
      return;
    }
    root.dataset.graphContextMenuBound = "1";
    root.addEventListener("contextmenu", (event) => openForEvent(root, event), true);
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.(".graph-context-menu")) {
        hideMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideMenu();
      }
    });
    window.addEventListener("blur", hideMenu);
    window.addEventListener("resize", hideMenu);
  }

  /** 우클릭 대상이 branch/tag chip 또는 commit row/node 인지 판별해 메뉴를 연다. */
  function openForEvent(root, event) {
    const target = eventTargetElement(event);
    const ref = target?.closest?.("[data-tag-name],[data-branch-name]");
    const items = ref
      ? refMenuItems(ref)
      : commitMenuItems(root, target, root.__gscContextHelpers || {});
    if (!items.length) {
      hideMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showMenu(items, event.clientX, event.clientY);
  }

  /** branch/tag chip 용 메뉴 항목을 만든다. */
  function refMenuItems(ref) {
    const tag = ref.dataset.tagName;
    if (tag) {
      const target = ref.dataset.tagHash || undefined;
      const remote = ref.dataset.tagRemote || undefined;
      const local = ref.dataset.tagLocal === "1";
      return [
        item("Checkout Tag", "debug-restart", () => ({ type: "checkoutTag", tag, target })),
        item("Create Branch from Tag", "git-branch-create", () => ({ type: "createBranchFromTag", tag, target })),
        ...(local ? [
          item("Rename Local Tag", "rename", () => ({ type: "renameTag", tag })),
          item("Push Tag", "cloud-upload", () => ({ type: "pushTag", tag })),
          item("Delete Local Tag", "trash", () => ({ type: "deleteTag", tag })),
        ] : []),
        ...(remote || local ? [
          item("Delete Remote Tag", "trash", () => ({ type: "deleteRemoteTag", tag, remote })),
        ] : []),
        item("Fetch Tags", "repo-fetch", () => ({ type: "fetchTags" })),
        item("Copy Tag Name", "copy", () => ({ type: "copyTagName", tag })),
      ];
    }

    const branch = ref.dataset.branchName;
    if (!branch) {
      return [];
    }
    const kind = ref.dataset.branchKind || "local";
    if (kind === "remote") {
      return [
        item("Checkout Remote Branch", "repo-pull", () => ({
          type: "checkoutRemoteBranch",
          branch,
        })),
        item("Squash Merge Branch", "git-merge", () => ({
          type: "branchMergeAction",
          branch,
          kind: "remote",
          action: "squash",
        })),
        item("Rebase Merge Branch", "repo-forked", () => ({
          type: "branchMergeAction",
          branch,
          kind: "remote",
          action: "rebase",
        })),
      ];
    }

    const actions = [];
    if (ref.dataset.checkoutBranch) {
      actions.push(
        item("Checkout Branch", "git-branch", () => ({
          type: "checkoutBranch",
          branch,
        }))
      );
      actions.push(
        item("Squash Merge Branch", "git-merge", () => ({
          type: "branchMergeAction",
          branch,
          kind: "local",
          action: "squash",
        })),
        item("Rebase Merge Branch", "repo-forked", () => ({
          type: "branchMergeAction",
          branch,
          kind: "local",
          action: "rebase",
        }))
      );
    }
    actions.push(
      item("Rename Branch", "rename", () => ({
        type: "renameBranch",
        branch,
      })),
      item("Clone Branch", "git-branch-create", () => ({
        type: "cloneBranch",
        branch,
        checkout: false,
      })),
      item("Clone and Checkout Branch", "git-branch-create", () => ({
        type: "cloneBranch",
        branch,
        checkout: true,
      }))
    );
    if (ref.dataset.checkoutBranch) {
      actions.push(
        item("Delete Branch", "trash", () => ({
          type: "deleteBranch",
          branch,
          kind: "local",
        }))
      );
    }
    return actions;
  }

  /** commit row/node 용 메뉴 항목을 만든다. */
  function commitMenuItems(root, target, helpers) {
    const hash = commitHashFromTarget(root, target);
    if (!hash) {
      return [];
    }
    const actions = [];
    const rebaseItems = window.GscGraphRebaseContext?.contextMenuItems?.(hash) || [];
    const rebaseActive = rebaseItems.length > 0;
    if (rebaseActive) {
      actions.push(...rebaseItems, separator());
    }
    if (helpers.canUndoCommit?.(hash)) {
      actions.push(
        item("Undo Commit", "discard", () => ({ type: "undoCommit", hash }))
      );
    }
    if (isRealCommit(hash)) {
      if (!rebaseActive) {
        actions.push(item("Interactive Rebase From Here", "list-ordered", () => ({
          type: "prepareGraphRebase",
          hash,
        })));
      }
      actions.push(
        item("Checkout Detached", "debug-restart", () => ({
          type: "checkoutCommit",
          hash,
        })),
        item("Create Branch Here", "git-branch-create", () => ({
          type: "createBranch",
          hash,
        })),
        item("Cherry-pick Commit", "git-pull-request", () => ({
          type: "cherryPick",
          hash,
        }))
      );
    }
    actions.push(
      item("Copy Commit Hash", "copy", () => ({ type: "copyCommitHash", hash }))
    );
    return actions;
  }

  /** 메뉴 항목 데이터를 만든다. */
  function item(label, icon, message) {
    return { label, icon, title: label, message };
  }

  /** 메뉴 섹션 구분선을 만든다. */
  function separator() {
    return { separator: true };
  }

  /** 메뉴 DOM 을 만들고 항목을 렌더링한 뒤 화면 안쪽에 배치한다. */
  function showMenu(items, x, y) {
    const menu = ensureMenu();
    menu.innerHTML = "";
    items.forEach((entry) => {
      menu.appendChild(entry.separator ? menuSeparator() : menuButton(entry));
    });
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const left = clamp(x, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const top = clamp(y, 8, Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector("button")?.focus();
  }

  /** 메뉴 항목 버튼을 만든다. 버튼에는 title/aria-label 을 같이 둬 hover tooltip 을 제공한다. */
  function menuButton(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.title = entry.title;
    button.setAttribute("aria-label", entry.title);
    button.innerHTML =
      `<span class="codicon codicon-${entry.icon}" aria-hidden="true"></span>` +
      `<span>${esc(entry.label)}</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
      if (entry.run) {
        entry.run();
      } else {
        window.GscGraphPostMessage?.(entry.message());
      }
    });
    return button;
  }

  /** 메뉴 안에서 rebase/일반 액션을 구분하는 선을 만든다. */
  function menuSeparator() {
    const separator = document.createElement("div");
    separator.className = "graph-context-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }

  /** context menu 컨테이너를 지연 생성한다. */
  function ensureMenu() {
    if (!menuEl) {
      menuEl = document.createElement("div");
      menuEl.className = "graph-context-menu";
      menuEl.setAttribute("role", "menu");
      menuEl.hidden = true;
      menuEl.addEventListener("contextmenu", (event) => event.preventDefault());
      document.body.appendChild(menuEl);
    }
    return menuEl;
  }

  /** 열려 있는 메뉴를 닫는다. */
  function hideMenu() {
    if (menuEl) {
      menuEl.hidden = true;
    }
  }

  /** graph tooltip 이벤트를 문서 레벨 위임으로 연결한다. */
  function initTooltips() {
    document.addEventListener("mouseover", (event) => {
      const target = tooltipTarget(event);
      if (!target || target === activeTooltipTarget) {
        return;
      }
      showTooltip(target);
    });
    document.addEventListener("mouseout", (event) => {
      if (!activeTooltipTarget) {
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && activeTooltipTarget.contains(next)) {
        return;
      }
      hideTooltip();
    });
    document.addEventListener("focusin", (event) => {
      const target = tooltipTarget(event);
      if (target) {
        showTooltip(target);
      }
    });
    document.addEventListener("focusout", hideTooltip);
    document.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("blur", hideTooltip);
  }

  /** 이벤트 대상에서 tooltip 을 표시할 graph UI 요소를 찾는다. */
  function tooltipTarget(event) {
    return eventTargetElement(event)?.closest?.(
      ".ref[data-tooltip], .lane-hover-target[data-tooltip], #graph-toolbar [data-tooltip]"
    ) || undefined;
  }

  /** 대상 chip 의 data-tooltip 내용을 표시하고 viewport 안쪽으로 위치를 보정한다. */
  function showTooltip(target) {
    const text = target.dataset.tooltip || "";
    if (!text) {
      hideTooltip();
      return;
    }
    activeTooltipTarget = target;
    const tooltip = ensureTooltip();
    tooltip.textContent = text;
    tooltip.hidden = false;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    placeTooltip(target, tooltip);
  }

  /** tooltip 을 target 아래쪽에 두되 화면을 벗어나면 좌표와 방향을 보정한다. */
  function placeTooltip(target, tooltip) {
    const targetRect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(
      VIEWPORT_EDGE,
      window.innerWidth - tipRect.width - VIEWPORT_EDGE
    );
    const left = clamp(
      targetRect.left + targetRect.width / 2 - tipRect.width / 2,
      VIEWPORT_EDGE,
      maxLeft
    );
    let top = targetRect.bottom + TOOLTIP_GAP;
    if (top + tipRect.height + VIEWPORT_EDGE > window.innerHeight) {
      top = targetRect.top - tipRect.height - TOOLTIP_GAP;
    }
    top = clamp(
      top,
      VIEWPORT_EDGE,
      Math.max(VIEWPORT_EDGE, window.innerHeight - tipRect.height - VIEWPORT_EDGE)
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  /** tooltip DOM 을 지연 생성한다. */
  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "graph-tooltip";
      tooltipEl.setAttribute("role", "tooltip");
      tooltipEl.hidden = true;
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  /** tooltip 을 숨기고 현재 target 을 비운다. */
  function hideTooltip() {
    activeTooltipTarget = undefined;
    if (tooltipEl) {
      tooltipEl.hidden = true;
    }
  }

  /** 이벤트 target 을 closest 를 호출할 수 있는 Element 로 정규화한다. */
  function eventTargetElement(event) {
    return event.target?.nodeType === Node.ELEMENT_NODE
      ? event.target
      : event.target?.parentElement;
  }

  /** 우클릭 대상에서 commit hash 를 찾는다. row 를 우선하고 SVG node 를 보조로 본다. */
  function commitHashFromTarget(root, target) {
    const row = target?.closest?.(".row:not([data-reflog-virtual])");
    if (row?.dataset.hash) {
      return row.dataset.hash;
    }
    const node = target?.closest?.(".node");
    if (node?.dataset.hash) {
      return node.dataset.hash;
    }
    return "";
  }

  /** 가상 ongoing/staged row 는 git commit action 대상에서 제외한다. */
  function isRealCommit(hash) {
    return hash && hash.indexOf("__gsc_virtual_") !== 0;
  }

  /** 값을 min/max 범위 안으로 제한한다. */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** 메뉴 라벨을 안전하게 HTML 에 넣기 위해 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  initTooltips();

  window.GscGraphContextMenu = { attach };
})();
