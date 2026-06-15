// Pull Request 목록 drawer 검색 UI.
// - graphPr.js 의 PR 렌더링 책임이 커지지 않도록 검색 상태/필터링을 별도 모듈로 둔다.
(function () {
  "use strict";

  let query = "";
  let focusAfterRender = false;

  /** PR 목록 헤더에 들어갈 검색 컨트롤 HTML 을 만든다. */
  function render(total, filtered) {
    const active = hasQuery();
    const summary = active ? `${filtered} of ${total} loaded matches` : `${total} loaded pull requests`;
    return `<div class="pr-list-search-row">` +
      `<label class="pr-list-search" role="search">` +
      `<span class="codicon codicon-search" aria-hidden="true"></span>` +
      `<input type="search" value="${esc(query)}" data-pr-search-input placeholder="Search pull requests" ` +
      `title="Search loaded pull requests by number, title, author, branch, or state" ` +
      `aria-label="Search loaded pull requests by number, title, author, branch, or state" />` +
      `<button type="button" data-pr-search-clear ${active ? "" : "hidden"} ` +
      tooltipAttrs("Clear pull request search") + `>` +
      `<span class="codicon codicon-close" aria-hidden="true"></span></button></label>` +
      `<span class="pr-list-search-summary" aria-live="polite">${esc(summary)}</span></div>`;
  }

  /** 검색 입력/초기화 버튼 이벤트를 현재 drawer DOM 에 연결한다. */
  function bind(root, onChange) {
    const input = root.querySelector("[data-pr-search-input]");
    const clear = root.querySelector("[data-pr-search-clear]");
    if (!input) {
      return;
    }
    input.addEventListener("input", () => update(input.value, onChange));
    input.addEventListener("search", () => update(input.value, onChange));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && query) {
        event.preventDefault();
        update("", onChange);
      }
    });
    clear?.addEventListener("click", () => update("", onChange));
    if (focusAfterRender) {
      requestAnimationFrame(() => focusInput(input));
    }
  }

  /** 현재 검색어로 PR 배열을 필터링한다. */
  function filter(pullRequests) {
    const terms = normalized(query).split(/\s+/).filter(Boolean);
    if (!terms.length) {
      return pullRequests || [];
    }
    return (pullRequests || []).filter((pr) => {
      const haystack = normalized([
        `#${pr.number}`,
        pr.number,
        pr.title,
        pr.author,
        pr.headRefName,
        pr.baseRefName,
        pr.state,
        pr.reviewDecision,
      ].join(" "));
      return terms.every((term) => haystack.includes(term));
    });
  }

  /** 검색 결과가 비었을 때 표시할 문구를 만든다. */
  function emptyMessage(fallback) {
    return hasQuery() ? `No loaded pull requests match "${query.trim()}".` : fallback;
  }

  /** 검색어가 입력된 상태인지 반환한다. */
  function hasQuery() {
    return Boolean(query.trim());
  }

  /** 검색어를 갱신하고 목록 재렌더링을 요청한다. */
  function update(next, onChange) {
    query = String(next || "");
    focusAfterRender = true;
    onChange?.();
  }

  /** 재렌더링 후 검색 입력에 포커스와 커서를 복원한다. */
  function focusInput(input) {
    focusAfterRender = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** 대소문자/공백 차이를 줄인 검색 문자열로 바꾼다. */
  function normalized(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /** tooltip/title/aria-label 속성을 함께 만든다. */
  function tooltipAttrs(title) {
    const value = esc(title);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  window.GscGraphPrSearch = { bind, emptyMessage, filter, hasQuery, render };
})();
