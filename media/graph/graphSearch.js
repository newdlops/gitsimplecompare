// git graph 검색 UI.
// - 로드된 DOM row 는 즉시 검색하고, 전체 저장소 검색은 debounce 후 확장에 요청한다.
// - 원격 최신화는 사용자가 명시적으로 누른 fetch 버튼에서만 수행한다.
(function () {
  "use strict";

  const DEBOUNCE_MS = 300;
  let bound = false;
  let graphEl;
  let rootEl;
  let debounceTimer = 0;
  let sequence = 0;
  let latestRequestId = "";
  let pendingJump;
  let repoState = { status: "idle", query: "", scope: "all", matches: [], skippedCommitSearch: false };

  /** 검색 입력/후보 목록 이벤트를 한 번만 연결한다. */
  function init(graph, root) {
    if (bound) {
      return;
    }
    graphEl = graph;
    rootEl = root;
    const input = document.getElementById("graph-search-input");
    const results = document.getElementById("graph-search-results");
    if (!input || !results) {
      return;
    }
    bound = true;
    input.addEventListener("input", () => startSearch(input, results));
    input.addEventListener("focus", () => render(input, results));
    document.getElementById("graph-search-scope")?.addEventListener("change", () => startSearch(input, results));
    results.addEventListener("click", (event) => handleResultClick(event, input, results));
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.("#graph-search")) {
        results.hidden = true;
      }
    });
  }

  /** 그래프가 다시 그려진 뒤 열려 있는 검색 후보 목록을 현재 row 기준으로 갱신한다. */
  function update(graph, root) {
    graphEl = graph || graphEl;
    rootEl = root || rootEl;
    const input = document.getElementById("graph-search-input");
    const results = document.getElementById("graph-search-results");
    if (input && results && input.value.trim()) {
      render(input, results);
    }
  }

  /** 입력값 변경을 즉시 렌더링하고 repository-wide 검색은 debounce 한다. */
  function startSearch(input, results) {
    const query = input.value.trim();
    const scope = currentScope();
    window.clearTimeout(debounceTimer);
    if (!query) {
      latestRequestId = "";
      repoState = { status: "idle", query: "", scope, matches: [], skippedCommitSearch: false };
      render(input, results);
      return;
    }
    latestRequestId = nextRequestId("search");
    repoState = { status: "loading", query, scope, matches: [], skippedCommitSearch: false };
    render(input, results);
    debounceTimer = window.setTimeout(() => {
      window.GscGraphPostMessage?.({ type: "graphRepositorySearch", requestId: latestRequestId, query, scope });
    }, DEBOUNCE_MS);
  }

  /** 결과 목록 클릭을 commit 이동 또는 remote ref fetch 로 변환한다. */
  function handleResultClick(event, input, results) {
    const fetch = event.target.closest?.("[data-search-fetch]");
    if (fetch) {
      event.preventDefault();
      fetchSearchRefs(input, results, fetch.dataset.searchFetch === "tags" ? "tags" : "refs");
      return;
    }
    const item = event.target.closest?.("[data-hash]");
    if (!item) {
      return;
    }
    jumpOrRequest(item.dataset.hash || "");
    results.hidden = true;
  }

  /** 명시적 fetch 후 같은 검색어로 repository-wide 검색을 다시 요청한다. */
  function fetchSearchRefs(input, results, target) {
    const query = input.value.trim();
    const scope = currentScope();
    if (!query) {
      return;
    }
    window.clearTimeout(debounceTimer);
    latestRequestId = nextRequestId("fetch");
    repoState = { status: "loading", query, scope, matches: [], skippedCommitSearch: false, fetching: target };
    render(input, results);
    window.GscGraphPostMessage?.({ type: "fetchGraphSearchRefs", requestId: latestRequestId, query, scope, target });
  }

  /** 검색어에 맞는 loaded/repository 후보 목록을 렌더링한다. */
  function render(input, results) {
    const query = input.value.trim();
    const scope = currentScope();
    const terms = normalized(query).split(/\s+/).filter(Boolean);
    if (!terms.length) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const loaded = localCandidates(terms, scope).slice(0, 30);
    results.hidden = false;
    results.innerHTML =
      sectionHtml("Loaded matches", loaded, "No matches in loaded commits") +
      repositorySection(query, scope) +
      footerHtml(scope);
  }

  /** 현재 로드된 row 에서 검색 후보를 만든다. */
  function localCandidates(terms, scope) {
    if (!rootEl) {
      return [];
    }
    return Array.from(rootEl.querySelectorAll(".row")).flatMap((row) => {
      const hash = row.dataset.hash || "";
      const subject = row.dataset.subject || "";
      const refs = (row.dataset.refs || "").split("\t").filter(Boolean);
      const commitText = `${hash} ${subject}`.toLowerCase();
      const matches = [];
      if (scopeAllows(scope, "commit") && terms.every((term) => commitText.includes(term))) {
        matches.push({ type: "Commit", hash, label: subject || hash, meta: searchMeta(hash, refs) });
      }
      refs
        .map((ref) => refCandidate(ref))
        .filter((candidate) => candidate && scopeAllows(scope, candidate.kind))
        .filter((candidate) => terms.every((term) => candidate.searchText.includes(term)))
        .forEach((candidate) => matches.push({
          type: candidate.kind === "tag" ? "Tag" : "Branch",
          hash,
          label: candidate.label,
          meta: searchMeta(hash, refs),
        }));
      return matches;
    });
  }

  /** repository-wide 검색 상태를 HTML 로 변환한다. */
  function repositorySection(query, scope) {
    if (repoState.query !== query || repoState.scope !== scope || repoState.status === "idle") {
      return sectionHtml("Repository matches", [], "Preparing repository search...");
    }
    if (repoState.status === "loading") {
      return sectionHtml(
        "Repository matches",
        [],
        repoState.fetching === "tags" ? "Fetching tags..." : repoState.fetching ? "Fetching remote refs..." : "Searching repository..."
      );
    }
    if (repoState.status === "error") {
      return sectionHtml("Repository matches", [], repoState.message || "Repository search failed.");
    }
    const note = repoState.skippedCommitSearch && scopeAllows(scope, "commit")
      ? '<div class="search-note">Commit message search starts after 3 non-hash characters.</div>'
      : "";
    return sectionHtml("Repository matches", repoState.matches || [], "No repository matches") + note;
  }

  /** 검색 결과 section HTML 을 만든다. */
  function sectionHtml(title, items, empty) {
    return `<div class="search-section"><div class="search-section-title">${esc(title)}</div>` +
      (items.length ? items.map(searchResultHtml).join("") : `<div class="search-empty">${esc(empty)}</div>`) +
      `</div>`;
  }

  /** 검색 결과 하단의 명시적 remote fetch 액션을 만든다. */
  function footerHtml(scope) {
    const note = scope === "tag"
      ? "Repository search uses local tags."
      : scope === "branch"
        ? "Repository search uses local refs."
        : "Repository search uses local refs and tags.";
    const buttons = [];
    if (scopeAllows(scope, "branch") || scopeAllows(scope, "commit")) {
      buttons.push(fetchButtonHtml("refs", "Fetch remote refs, then search again", "repo-fetch", "Fetch remote refs"));
    }
    if (scopeAllows(scope, "tag") || scopeAllows(scope, "commit")) {
      buttons.push(fetchButtonHtml("tags", "Fetch tags, then search again", "tag", "Fetch tags"));
    }
    return `<div class="search-footer"><span>${esc(note)}</span><div class="search-footer-actions">${buttons.join("")}</div></div>`;
  }

  /** 검색 결과 하단의 fetch 액션 버튼 HTML 을 만든다. */
  function fetchButtonHtml(target, title, icon, label) {
    return `<button type="button" data-search-fetch="${esc(target)}" title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span><span>${esc(label)}</span></button>`;
  }

  /** 검색 결과 한 줄 HTML 을 만든다. */
  function searchResultHtml(item) {
    const type = item.type || kindLabel(item.kind);
    const title = `${type}: ${item.label} | ${item.meta}`;
    return `<button class="search-result" type="button" data-hash="${esc(item.hash)}" ` +
      `title="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="search-kind">${esc(type)}</span>` +
      `<span class="search-label">${esc(item.label)}</span>` +
      `<span class="search-meta">${esc(item.meta)}</span></button>`;
  }

  /** 검색 후보 선택 시 loaded row 로 이동하거나 graph window 로드를 요청한다. */
  function jumpOrRequest(hash) {
    if (!hash) {
      return;
    }
    if (jumpToHash(hash)) {
      return;
    }
    const requestId = nextRequestId("jump");
    pendingJump = { requestId, hash };
    window.GscGraphPostMessage?.({ type: "ensureCommitVisible", requestId, hashes: [hash] });
  }

  /** 검색 후보 선택 시 해당 row 로 이동하고 잠깐 강조한다. */
  function jumpToHash(hash) {
    const row = rootEl ? Array.from(rootEl.querySelectorAll(".row")).find((item) => item.dataset.hash === hash) : null;
    if (!row || !graphEl) {
      return false;
    }
    graphEl.scrollTop = Math.max(0, row.offsetTop - 80);
    rootEl.querySelectorAll(".search-hit").forEach((item) => item.classList.remove("search-hit"));
    row.classList.add("search-hit");
    window.setTimeout(() => row.classList.remove("search-hit"), 2200);
    return true;
  }

  /** 검색 결과 오른쪽 메타 영역에 표시할 해시와 브랜치 요약을 만든다. */
  function searchMeta(hash, refs) {
    const branches = refs.filter((ref) =>
      ref !== "HEAD" && !ref.startsWith("tag:") && !ref.startsWith("virtual:")
    );
    return branches.length
      ? `${hash.slice(0, 10)} | ${branches.join(", ")}`
      : `${hash.slice(0, 10)} | no branch ref`;
  }

  /** repository result kind 를 사람이 읽는 레이블로 변환한다. */
  function kindLabel(kind) {
    return kind === "branch" ? "Branch" : kind === "tag" ? "Tag" : kind === "hash" ? "Hash" : "Commit";
  }

  /** ref 문자열을 검색 후보로 변환한다. */
  function refCandidate(ref) {
    const tag = ref.indexOf("tag:") === 0;
    const label = tag ? ref.replace(/^tag:/, "") : ref;
    const kind = tag ? "tag" : ref === "HEAD" || ref.startsWith("virtual:") ? "" : "branch";
    if (!kind) {
      return undefined;
    }
    return { kind, label, searchText: `${label} ${kind}`.toLowerCase() };
  }

  /** 현재 검색 범위 select 값을 반환한다. */
  function currentScope() {
    const value = document.getElementById("graph-search-scope")?.value || "all";
    return value === "commit" || value === "branch" || value === "tag" ? value : "all";
  }

  /** 검색 범위가 특정 결과 종류를 포함하는지 확인한다. */
  function scopeAllows(scope, kind) {
    return scope === "all" || scope === kind || (scope === "commit" && kind === "hash");
  }

  /** 대소문자/공백 차이를 줄인 검색 문자열로 바꾼다. */
  function normalized(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /** 최신 요청 판별에 쓸 request id 를 만든다. */
  function nextRequestId(prefix) {
    sequence += 1;
    return `graph-${prefix}-${Date.now()}-${sequence}`;
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "graphRepositorySearchResult" && msg.requestId === latestRequestId) {
      repoState = Object.assign({ status: "ready", scope: currentScope() }, msg.result || {});
      update();
    } else if (msg.type === "graphRepositorySearchError" && msg.requestId === latestRequestId) {
      repoState = { status: "error", query: msg.query || "", scope: currentScope(), matches: [], message: msg.message };
      update();
    } else if (msg.type === "commitVisibility" && pendingJump?.requestId === msg.requestId) {
      const hash = msg.hash || pendingJump.hash;
      pendingJump = undefined;
      if (msg.found) {
        requestAnimationFrame(() => jumpToHash(hash));
      }
    }
  });

  window.GscGraphSearch = { init, update };
})();
