// Pull Request 목록 drawer 검색 UI.
// - graphPr.js 의 PR 렌더링 책임이 커지지 않도록 검색 상태/필터링을 별도 모듈로 둔다.
(function () {
  "use strict";

  const DEBOUNCE_MS = 300;
  let query = "";
  let focusAfterRender = false;
  let rerender;
  let debounceTimer = 0;
  let sequence = 0;
  let latestRequestId = "";
  let composing = false;
  let pendingAppend = false;
  let repositoryState = { status: "idle", query: "", pullRequests: [], hasMore: false, totalCount: 0 };

  /** PR 목록 헤더에 들어갈 검색 컨트롤 HTML 을 만든다. */
  function render(total, filtered) {
    const active = hasQuery();
    const summary = active ? searchSummary(total, filtered) : `${total} loaded pull requests`;
    return `<div class="pr-list-search-row">` +
      `<label class="pr-list-search" role="search">` +
      `<span class="codicon codicon-search" aria-hidden="true"></span>` +
      `<input type="search" value="${esc(query)}" data-pr-search-input placeholder="Search pull requests" ` +
      `title="Search all pull requests by number, commit hash, title, author, branch, label, or state" ` +
      `aria-label="Search all pull requests by number, commit hash, title, author, branch, label, or state" />` +
      `<button type="button" data-pr-search-clear ${active ? "" : "hidden"} ` +
      tooltipAttrs("Clear pull request search") + `>` +
      `<span class="codicon codicon-close" aria-hidden="true"></span></button></label>` +
      `<span class="pr-list-search-summary" aria-live="polite">${esc(summary)}</span>` +
      repositoryMoreButton() +
      `</div>`;
  }

  /** 검색 입력/초기화 버튼 이벤트를 현재 drawer DOM 에 연결한다. */
  function bind(root, onChange) {
    rerender = onChange;
    const input = root.querySelector("[data-pr-search-input]");
    const clear = root.querySelector("[data-pr-search-clear]");
    if (!input) {
      return;
    }
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => {
      composing = false;
      update(input.value, onChange);
    });
    input.addEventListener("input", (event) => {
      if (composing || event.isComposing) {
        query = input.value;
        return;
      }
      update(input.value, onChange);
    });
    input.addEventListener("search", () => {
      if (!composing) {
        update(input.value, onChange);
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && query) {
        event.preventDefault();
        update("", onChange);
      }
    });
    clear?.addEventListener("click", () => update("", onChange));
    root.querySelector("[data-pr-search-more]")?.addEventListener("click", () => loadMore(onChange));
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
    const loaded = (pullRequests || []).filter((pr) => {
      const haystack = normalized([
        `#${pr.number}`,
        pr.number,
        pr.title,
        pr.author,
        pr.headRefName,
        pr.baseRefName,
        pr.state,
        pr.reviewDecision,
        pr.headHash,
        pr.mergeHash,
        ...(pr.commitHashes || []),
        window.GscGraphPrLabels?.searchText?.(pr),
      ].join(" "));
      return terms.every((term) => haystack.includes(term));
    });
    return mergeByNumber(loaded, repositoryMatches());
  }

  /** 검색 결과가 비었을 때 표시할 문구를 만든다. */
  function emptyMessage(fallback) {
    if (!hasQuery()) {
      return fallback;
    }
    if (repositoryState.status === "loading") {
      return `Searching all pull requests for "${query.trim()}"...`;
    }
    if (repositoryState.status === "error") {
      return repositoryState.message || "Pull request search failed.";
    }
    return `No pull requests match "${query.trim()}".`;
  }

  /** 검색어가 입력된 상태인지 반환한다. */
  function hasQuery() {
    return Boolean(query.trim());
  }

  /** 검색어를 갱신하고 목록 재렌더링을 요청한다. */
  function update(next, onChange) {
    query = String(next || "");
    focusAfterRender = true;
    scheduleRepositorySearch();
    onChange?.();
  }

  /** repository-wide PR 검색을 debounce 해서 요청한다. */
  function scheduleRepositorySearch() {
    window.clearTimeout(debounceTimer);
    const trimmed = query.trim();
    if (!trimmed) {
      latestRequestId = "";
      repositoryState = { status: "idle", query: "", pullRequests: [], hasMore: false, totalCount: 0 };
      return;
    }
    latestRequestId = nextRequestId();
    pendingAppend = false;
    repositoryState = { status: "loading", query: trimmed, pullRequests: [], hasMore: false, totalCount: 0 };
    debounceTimer = window.setTimeout(() => {
      window.GscGraphPostMessage?.({ type: "searchPullRequests", requestId: latestRequestId, query: trimmed });
    }, DEBOUNCE_MS);
  }

  /** 검색 결과가 너무 많아 자동 수집을 멈춘 경우 다음 묶음을 요청한다. */
  function loadMore(onChange) {
    const trimmed = query.trim();
    if (!trimmed || repositoryState.status === "loading" || !repositoryState.hasMore || !repositoryState.nextCursor) {
      return;
    }
    latestRequestId = nextRequestId();
    pendingAppend = true;
    repositoryState = Object.assign({}, repositoryState, { status: "loading", query: trimmed });
    window.GscGraphPostMessage?.({
      type: "searchPullRequests",
      requestId: latestRequestId,
      query: trimmed,
      cursor: repositoryState.nextCursor,
    });
    onChange?.();
  }

  /** 현재 repository-wide 검색 결과 중 현재 검색어에 대응하는 PR 목록을 반환한다. */
  function repositoryMatches() {
    return repositoryState.query === query.trim() && repositoryState.status !== "idle"
      ? repositoryState.pullRequests || []
      : [];
  }

  /** PR 번호로 loaded/search 결과에서 PR 을 찾는다. */
  function find(number) {
    return repositoryMatches().find((pr) => Number(pr.number) === Number(number));
  }

  /** loaded PR 목록과 repository-wide 결과를 합쳐 반환한다. */
  function all(pullRequests) {
    return mergeByNumber(pullRequests || [], repositoryMatches());
  }

  /** 검색 summary 를 만든다. */
  function searchSummary(total, filtered) {
    if (repositoryState.query === query.trim() && repositoryState.status === "loading") {
      return pendingAppend
        ? `${filtered} shown, loading more of ${repositoryState.totalCount || "unknown"} repository matches`
        : `${filtered} loaded matches, searching all pull requests`;
    }
    if (repositoryState.query === query.trim() && repositoryState.status === "error") {
      return `${filtered} matches, repository search failed`;
    }
    const repoCount = repositoryMatches().length;
    const totalCount = repositoryState.totalCount || repoCount;
    return repositoryState.hasMore
      ? `${filtered} shown (${repoCount} of ${totalCount} repository matches loaded, ${total} loaded locally)`
      : `${filtered} shown (${totalCount} repository matches total, ${total} loaded locally)`;
  }

  /** repository-wide 검색 결과가 남아 있을 때 추가 로드 버튼을 만든다. */
  function repositoryMoreButton() {
    if (!hasQuery() || repositoryState.query !== query.trim() || !repositoryState.hasMore || !repositoryState.nextCursor) {
      return "";
    }
    const title = `Load more pull request matches (${repositoryMatches().length} of ${repositoryState.totalCount || "unknown"} loaded)`;
    return `<button type="button" class="pr-icon-action" data-pr-search-more ${tooltipAttrs(title)}>` +
      `<span class="codicon codicon-arrow-down" aria-hidden="true"></span></button>`;
  }

  /** PR 번호 기준으로 중복 없이 목록을 합친다. */
  function mergeByNumber(a, b) {
    const byNumber = new Map();
    for (const pr of [...(a || []), ...(b || [])]) {
      byNumber.set(Number(pr.number), pr);
    }
    return Array.from(byNumber.values());
  }

  /** 최신 검색 요청 ID 를 만든다. */
  function nextRequestId() {
    sequence += 1;
    return `pr-search-${Date.now()}-${sequence}`;
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

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "pullRequestSearchResult" && msg.requestId === latestRequestId) {
      const previous = pendingAppend ? repositoryMatches() : [];
      repositoryState = Object.assign({ status: "ready" }, msg.result || {}, {
        pullRequests: mergeByNumber(previous, msg.result?.pullRequests || []),
      });
      pendingAppend = false;
      rerender?.();
    } else if (msg.type === "pullRequestSearchError" && msg.requestId === latestRequestId) {
      repositoryState = Object.assign({}, repositoryState, {
        status: "error",
        query: msg.query || "",
        message: msg.message,
      });
      pendingAppend = false;
      rerender?.();
    }
  });

  window.GscGraphPrSearch = { all, bind, emptyMessage, filter, find, hasQuery, render };
})();
