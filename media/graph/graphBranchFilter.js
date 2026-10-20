// git graph 검색 헤더의 브랜치 표시 필터 UI.
// - 확장에서 받은 브랜치 목록을 체크박스 popover 로 보여주고, 선택 변경을 setBranchFilter 로 보낸다.
(function () {
  "use strict";

  let buttonEl;
  let menuEl;
  let bound = false;
  let snapshot = { mode: "all", selected: [], compact: true, branches: [], remoteStatus: "ready" };
  let branchQuery = "";
  let menuDirty = true;

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
    buttonEl.addEventListener("keydown", handleMenuKeydown);
    menuEl.addEventListener("keydown", handleMenuKeydown);
    menuEl.addEventListener("click", handleMenuClick);
    menuEl.addEventListener("input", handleMenuInput);
    menuEl.addEventListener("change", handleMenuChange);
    document.addEventListener("click", (event) => {
      // 같은 click에서 항목 DOM을 교체해도 원래 메뉴 안에서 시작한 이벤트는 outside click이 아니다.
      if (!event.composedPath().some(target => target === buttonEl || target === menuEl)) {
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
      render();
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

  /** 메뉴 안/열기 버튼의 Escape는 해당 메뉴만 닫고 같은 웹뷰의 버튼으로 키보드 탐색을 돌려준다. */
  function handleMenuKeydown(event) {
    if (event.key !== "Escape" || menuEl.hidden) return;
    event.preventDefault(); event.stopPropagation(); closeMenu(); buttonEl.focus({ preventScroll: true });
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
    menuDirty = true;
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
    const checked = new Map(snapshot.branches.map((branch) => [branch.name, snapshot.mode === "custom" ? snapshot.selected.includes(branch.name) : branch.checked]));
    menuEl.querySelectorAll("[data-branch-filter-checkbox]").forEach((input) => {
      checked.set(input.value, input.checked);
    });
    const visible = snapshot.branches.filter((branch) => checked.get(branch.name)).map((branch) => branch.name);
    // 원격 hydration 전의 선택은 아직 checkbox가 없어도 보존한다. Clear All만 그 사용자 의도를 명시적으로 비운다.
    return snapshot.mode === "custom" ? [...visible, ...snapshot.selected.filter(name => !checked.has(name))] : visible;
  }

  /** compact graph 체크박스의 현재 값을 읽는다. */
  function compactChecked() {
    const input = menuEl.querySelector("[data-branch-filter-compact]");
    return input ? input.checked : snapshot.compact;
  }

  /** 브랜치 필터 변경 메시지를 확장으로 보낸다. */
  function postFilter(mode, branches, compact) {
    // 선택은 사용자 의도이므로 host의 Git 읽기를 기다리지 않고 반영한다. 연속 compact 변경도 같은 선택을 사용한다.
    const selected = mode === "all" ? [] : [...branches], checked = new Set(selected);
    snapshot = { ...snapshot, mode, selected, compact, branches: snapshot.branches.map(branch => ({ ...branch,
      checked: mode === "all" || checked.has(branch.name) })) };
    menuDirty = true; render();
    window.GscGraphPostMessage?.({
      type: "setBranchFilter",
      mode,
      branches,
      compact,
    });
  }

  /** 확장에서 받은 최신 스냅샷으로 버튼/메뉴를 다시 그린다. */
  function applySnapshot(next) {
    const updated = {
      mode: next?.mode || "all",
      selected: Array.isArray(next?.selected) ? next.selected : [],
      compact: next?.compact !== false,
      branches: Array.isArray(next?.branches) ? next.branches : [],
      remoteStatus: next?.remoteStatus || "ready",
      remoteError: next?.remoteError || "",
    };
    // 최소 identity와 상세가 같은 옵션이면 열린 메뉴의 검색·키보드 포커스를 그대로 유지한다.
    if (JSON.stringify(snapshot) === JSON.stringify(updated)) return;
    snapshot = updated;
    menuDirty = true;
    // 숨겨진 이전 목록은 새 snapshot이 도착한 뒤 버린다. 서버 응답 전 다시 열 때는 사용자의 체크 상태를 보존한다.
    if (menuEl?.hidden) menuEl.replaceChildren();
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
    buttonEl.setAttribute("aria-label", buttonEl.title);
    if (menuEl.hidden || !menuDirty) return;
    const focus = captureMenuFocus(), scrollTop = menuEl.querySelector(".branch-filter-list")?.scrollTop || 0;
    menuEl.innerHTML = menuHtml(checkedCount);
    menuDirty = false;
    const list = menuEl.querySelector(".branch-filter-list");
    if (list && scrollTop) list.scrollTop = scrollTop;
    restoreMenuFocus(focus);
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
      remoteStatusHtml() +
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

  /** 원격 목록 hydration 상태를 비차단 안내로 렌더링한다. */
  function remoteStatusHtml() {
    if (snapshot.remoteStatus === "pending") {
      return `<div class="branch-filter-empty" role="status">` +
        `<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>` +
        `<span>Loading remote branches…</span></div>`;
    }
    if (snapshot.remoteStatus === "error") {
      const detail = snapshot.remoteError || "Refresh to retry remote branches.";
      return `<div class="branch-filter-empty" role="status" title="${esc(detail)}" data-tooltip="${esc(detail)}">` +
        `<span class="codicon codicon-warning" aria-hidden="true"></span>` +
        `<span>Remote branches unavailable. Refresh to retry.</span></div>`;
    }
    return "";
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

  /** @returns 현재 메뉴에서 사용 중인 컨트롤과 검색 커서. 메뉴 밖의 포커스는 건드리지 않는다. */
  function captureMenuFocus() {
    const active = document.activeElement;
    if (!menuEl.contains(active)) return undefined;
    if (active.matches("[data-branch-filter-search]")) return { selector: "[data-branch-filter-search]",
      start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
    if (active.matches("[data-branch-filter-checkbox]")) return {
      selector: `[data-branch-filter-checkbox][value="${CSS.escape(active.value)}"]` };
    if (active.matches("[data-branch-filter-compact]")) return { selector: "[data-branch-filter-compact]" };
    if (active.matches("[data-branch-filter-shortcut]")) return {
      selector: `[data-branch-filter-shortcut="${CSS.escape(active.dataset.branchFilterShortcut)}"]` };
    return undefined;
  }

  /** @param focus 교체 전 컨트롤 identity와 선택 범위. DOM 교체 직후 복원해 늦은 RAF가 사용자 포커스를 빼앗지 않는다. */
  function restoreMenuFocus(focus) {
    const target = focus && menuEl.querySelector(focus.selector);
    if (!target) return;
    target.focus({ preventScroll: true });
    if (focus.start !== undefined) target.setSelectionRange(focus.start, focus.end, focus.direction);
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
