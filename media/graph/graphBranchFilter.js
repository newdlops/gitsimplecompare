// git graph 검색 헤더의 브랜치 표시 필터 UI.
// - 확장에서 받은 브랜치 목록을 체크박스 popover 로 보여주고, 선택 변경을 setBranchFilter 로 보낸다.
(function () {
  "use strict";

  let buttonEl;
  let menuEl;
  let bound = false;
  let snapshot = { mode: "all", selected: [], compact: true, branches: [] };
  let branchQuery = "";
  let focusBranchSearch = false;

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** DOM 요소를 찾고 이벤트를 한 번만 연결한다. */
  function init() {
    if (bound) {
      return;
    }
    buttonEl = document.getElementById("graph-branch-filter-button");
    menuEl = document.getElementById("graph-branch-filter-menu");
    if (!buttonEl || !menuEl) {
      return;
    }
    bound = true;
    buttonEl.addEventListener("click", toggleMenu);
    menuEl.addEventListener("click", handleMenuClick);
    menuEl.addEventListener("input", handleMenuInput);
    menuEl.addEventListener("change", handleMenuChange);
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.("#graph-branch-filter-button,#graph-branch-filter-menu")) {
        closeMenu();
      }
    });
    render();
  }

  /** 필터 메뉴를 열거나 닫는다. */
  function toggleMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (menuEl.hidden) {
      const searchResults = document.getElementById("graph-search-results");
      if (searchResults) {
        searchResults.hidden = true;
      }
      menuEl.hidden = false;
      buttonEl.setAttribute("aria-expanded", "true");
      return;
    }
    closeMenu();
  }

  /** 필터 메뉴를 닫고 버튼 접근성 상태를 갱신한다. */
  function closeMenu() {
    if (!menuEl || !buttonEl) {
      return;
    }
    menuEl.hidden = true;
    buttonEl.setAttribute("aria-expanded", "false");
  }

  /** 메뉴 내부 shortcut 버튼 클릭을 처리한다. */
  function handleMenuClick(event) {
    const shortcut = event.target.closest?.("[data-branch-filter-shortcut]");
    if (!shortcut) {
      return;
    }
    event.preventDefault();
    const action = shortcut.dataset.branchFilterShortcut;
    if (action === "select-all") {
      postFilter("all", [], compactChecked());
      return;
    }
    if (action === "clear-all") {
      postFilter("custom", [], compactChecked());
    }
  }

  /** 브랜치 선택 목록 검색어 입력을 처리한다. */
  function handleMenuInput(event) {
    const input = event.target.closest?.("[data-branch-filter-search]");
    if (!input) {
      return;
    }
    branchQuery = input.value || "";
    focusBranchSearch = true;
    render();
  }

  /** 체크박스 변경을 필터 상태로 변환해 확장으로 보낸다. */
  function handleMenuChange(event) {
    if (event.target.closest?.("[data-branch-filter-compact]")) {
      postFilter(snapshot.mode, snapshot.mode === "all" ? [] : checkedBranches(), compactChecked());
      return;
    }
    if (event.target.closest?.("[data-branch-filter-checkbox]")) {
      postFilter("custom", checkedBranches(), compactChecked());
    }
  }

  /** 현재 체크된 브랜치 이름 목록을 읽는다. */
  function checkedBranches() {
    const checked = new Map(snapshot.branches.map((branch) => [branch.name, branch.checked]));
    menuEl.querySelectorAll("[data-branch-filter-checkbox]").forEach((input) => {
      checked.set(input.value, input.checked);
    });
    return snapshot.branches.filter((branch) => checked.get(branch.name)).map((branch) => branch.name);
  }

  /** compact graph 체크박스의 현재 값을 읽는다. */
  function compactChecked() {
    const input = menuEl.querySelector("[data-branch-filter-compact]");
    return input ? input.checked : snapshot.compact;
  }

  /** 브랜치 필터 변경 메시지를 확장으로 보낸다. */
  function postFilter(mode, branches, compact) {
    window.GscGraphPostMessage?.({
      type: "setBranchFilter",
      mode,
      branches,
      compact,
    });
  }

  /** 확장에서 받은 최신 스냅샷으로 버튼/메뉴를 다시 그린다. */
  function applySnapshot(next) {
    snapshot = {
      mode: next?.mode || "all",
      selected: Array.isArray(next?.selected) ? next.selected : [],
      compact: next?.compact !== false,
      branches: Array.isArray(next?.branches) ? next.branches : [],
    };
    render();
  }

  /** 필터 버튼 상태와 popover 내용을 렌더링한다. */
  function render() {
    if (!buttonEl || !menuEl) {
      return;
    }
    const checkedCount = snapshot.branches.filter((branch) => branch.checked).length;
    buttonEl.classList.toggle("active", snapshot.mode !== "all");
    buttonEl.dataset.activeCount = snapshot.mode === "all" ? "" : String(checkedCount);
    buttonEl.title = buttonTitle(checkedCount);
    buttonEl.dataset.tooltip = buttonEl.title;
    menuEl.innerHTML = menuHtml(checkedCount);
    if (focusBranchSearch) {
      requestAnimationFrame(focusSearchInput);
    }
  }

  /** 현재 필터 상태를 설명하는 버튼 tooltip 문구를 만든다. */
  function buttonTitle(checkedCount) {
    if (snapshot.mode === "all") {
      return "Filter visible branches: all branches are shown";
    }
    return `Filter visible branches: ${checkedCount} checked branches are shown`;
  }

  /** 필터 popover HTML 을 만든다. */
  function menuHtml(checkedCount) {
    const visibleBranches = filteredBranches();
    const emptyText = branchQuery.trim() ? "No branches match" : "No branches found";
    const branches = visibleBranches.length
      ? visibleBranches.map(branchRowHtml).join("")
      : `<div class="branch-filter-empty">${esc(emptyText)}</div>`;
    return (
      `<div class="branch-filter-header">` +
        `<span>Visible branches</span>` +
        `<span>${esc(checkedCount)} / ${esc(snapshot.branches.length)}</span>` +
      `</div>` +
      `<div class="branch-filter-shortcuts">` +
        shortcutButton("select-all", "Select All", "Show every local and remote branch in the graph", snapshot.mode === "all") +
        shortcutButton("clear-all", "Clear All", "Hide every branch from the graph", snapshot.mode === "custom" && checkedCount === 0) +
      `</div>` +
      branchSearchHtml(visibleBranches.length) +
      compactToggleHtml() +
      `<div class="branch-filter-list" role="group" aria-label="Visible branches">` +
        branches +
      `</div>`
    );
  }

  /** 브랜치 선택 목록 검색 입력 HTML 을 만든다. */
  function branchSearchHtml(visibleCount) {
    const title = "Search visible branch selection";
    return `<label class="branch-filter-search" title="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-search" aria-hidden="true"></span>` +
      `<input type="search" data-branch-filter-search value="${esc(branchQuery)}" ` +
      `placeholder="Search branches" aria-label="${esc(title)}" />` +
      `<span>${esc(visibleCount)} shown</span></label>`;
  }

  /** shortcut 버튼 HTML 을 만든다. */
  function shortcutButton(action, label, tooltip, active) {
    const activeClass = active ? " active" : "";
    return `<button class="branch-filter-shortcut${activeClass}" type="button" ` +
      `data-branch-filter-shortcut="${esc(action)}" title="${esc(tooltip)}" ` +
      `aria-label="${esc(tooltip)}" data-tooltip="${esc(tooltip)}">${esc(label)}</button>`;
  }

  /** compact graph 토글 HTML 을 만든다. */
  function compactToggleHtml() {
    const tooltip = "Limit graph width by folding overflow lanes into a compact lane";
    return `<label class="branch-filter-compact" title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}">` +
      `<input type="checkbox" data-branch-filter-compact${snapshot.compact ? " checked" : ""} />` +
      `<span class="codicon codicon-list-tree" aria-hidden="true"></span>` +
      `<span>Compact graph</span>` +
      `</label>`;
  }

  /** 브랜치 체크박스 한 줄 HTML 을 만든다. */
  function branchRowHtml(branch) {
    const tooltip = branchTooltip(branch);
    const icon = branch.kind === "remote" ? "cloud" : "git-branch";
    return `<label class="branch-filter-row${branch.current ? " current" : ""}" ` +
      `title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}">` +
      `<input type="checkbox" data-branch-filter-checkbox value="${esc(branch.name)}"` +
      `${branch.checked ? " checked" : ""} />` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
      `<span class="branch-filter-name">${esc(branch.name)}</span>` +
      `<span class="branch-filter-kind">${esc(branch.current ? "current" : branch.kind)}</span>` +
      `</label>`;
  }

  /** 브랜치 체크박스 row 의 tooltip 문구를 만든다. */
  function branchTooltip(branch) {
    const parts = [`Show branch ${branch.name} in the graph`];
    if (branch.current) {
      parts.push("current branch");
    }
    parts.push(branch.kind);
    return parts.join(" | ");
  }

  /** 현재 검색어에 맞는 브랜치 선택 항목만 반환한다. */
  function filteredBranches() {
    const terms = normalized(branchQuery).split(/\s+/).filter(Boolean);
    if (!terms.length) {
      return snapshot.branches;
    }
    return snapshot.branches.filter((branch) => {
      const haystack = normalized(`${branch.name} ${branch.kind} ${branch.current ? "current" : ""}`);
      return terms.every((term) => haystack.includes(term));
    });
  }

  /** 렌더링 뒤 브랜치 검색 입력의 포커스와 커서를 복원한다. */
  function focusSearchInput() {
    focusBranchSearch = false;
    const input = menuEl?.querySelector("[data-branch-filter-search]");
    if (!input) {
      return;
    }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** 검색 비교용 문자열로 정규화한다. */
  function normalized(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "branchFilterOptions") {
      applySnapshot(event.data.filter);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
