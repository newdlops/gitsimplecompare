// Reviews Personal/Management queue가 공유하는 local search·sort control.
// - GitHub query를 다시 쓰지 않고 현재 snapshot의 목록만 좁혀, 입력 중 network refresh와 selection 혼선을 막는다.
(function () {
  "use strict";

  /** main renderer의 state/DOM helper를 받아 queue control과 안정 정렬기를 만든다. */
  window.__gscReviewsQueueControls = function createReviewsQueueControls(deps) {
    const { T, state, element, render, queueWindow } = deps;

    /** 현재 tab 위에 동일한 검색·정렬 표면을 렌더한다. */
    function renderControls() {
      const current = controls();
      const section = element("section", "reviews__queue-controls");
      const searchField = element("label", "gsc-field");
      searchField.append(element("span", "gsc-field__label", T.filterPullRequests));
      const search = element("input", "gsc-input");
      search.name = "review-queue-filter";
      search.type = "search";
      search.placeholder = T.filterPullRequestsHint;
      search.autocomplete = "off";
      search.value = current.query;
      search.addEventListener("input", () => update("query", search.value));
      searchField.append(search);
      const sortField = element("label", "gsc-field");
      sortField.append(element("span", "gsc-field__label", T.sortPullRequests));
      const sort = element("select", "gsc-select");
      sort.name = "review-queue-sort";
      [["updated", T.sortByUpdated], ["title", T.sortByTitle], ["number", T.sortByNumber]].forEach(([value, label]) => {
        const option = element("option", "", label);
        option.value = value;
        sort.append(option);
      });
      sort.value = current.sort;
      sort.addEventListener("change", () => update("sort", sort.value));
      sortField.append(sort);
      const statusField = element("label", "gsc-field");
      statusField.append(element("span", "gsc-field__label", T.filterQueueStatus));
      const status = element("select", "gsc-select");
      status.name = "review-queue-status";
      [["all", T.statusAll], ["changes-requested", T.statusChangesRequested], ["merge-blocked", T.statusMergeBlocked], ["stale", T.statusStale], ["draft", T.statusDraft]].forEach(([value, label]) => {
        const option = element("option", "", label);
        option.value = value;
        status.append(option);
      });
      status.value = current.status;
      status.addEventListener("change", () => update("status", status.value));
      statusField.append(status);
      section.append(searchField, sortField, statusField);
      return section;
    }

    /** 검색어와 선택 sort를 적용한 새 배열을 반환해 원본 snapshot을 절대 수정하지 않는다. */
    function items(pullRequests) {
      const current = controls();
      const query = current.query.trim().toLocaleLowerCase();
      return pullRequests.filter((pullRequest) => (!query || searchable(pullRequest).includes(query)) && matchesStatus(pullRequest, current.status)).slice().sort(comparator(current.sort));
    }

    /** UI 값 변경은 persisted state에 저장하고 재렌더해 Personal/Management 전환에도 유지한다. */
    function update(key, value) {
      controls()[key] = value;
      queueWindow.reset();
      render();
    }

    /** 이전 webview state도 안전하게 새 control 기본값으로 보정한다. */
    function controls() {
      if (!state.queueControls) state.queueControls = { query: "", sort: "updated", status: "all" };
      if (!["updated", "title", "number"].includes(state.queueControls.sort)) state.queueControls.sort = "updated";
      if (!["all", "changes-requested", "merge-blocked", "stale", "draft"].includes(state.queueControls.status)) state.queueControls.status = "all";
      return state.queueControls;
    }

    /** title뿐 아니라 번호·author·repo·metadata token까지 검색 가능한 문자열로 합친다. */
    function searchable(pullRequest) {
      return [pullRequest.number, pullRequest.title, pullRequest.author, pullRequest.repository, pullRequest.reviewDecision, ...(pullRequest.labels || []), ...(pullRequest.assignees || []), ...(pullRequest.requestedReviewers || [])].filter(Boolean).join(" ").toLocaleLowerCase();
    }

    /** 공개 queue 요약만으로 확정할 수 있는 상태만 필터하며, 알 수 없는 checks를 차단으로 추측하지 않는다. */
    function matchesStatus(pullRequest, status) {
      if (status === "changes-requested") return pullRequest.reviewDecision === "CHANGES_REQUESTED";
      if (status === "merge-blocked") return ["BLOCKED", "DIRTY"].includes(pullRequest.mergeStateStatus);
      if (status === "stale") return isStale(pullRequest.updatedAt);
      if (status === "draft") return Boolean(pullRequest.isDraft);
      return true;
    }

    /** 문서에서 고정한 7일 기준으로 stale을 계산하고, 시간이 없으면 stale로 간주하지 않는다. */
    function isStale(updatedAt) {
      const updated = Date.parse(updatedAt || "");
      return Number.isFinite(updated) && Date.now() - updated >= 7 * 24 * 60 * 60 * 1000;
    }

    /** 최신순 기본을 유지하면서 title/number 선택도 deterministic하게 정렬한다. */
    function comparator(sort) {
      if (sort === "title") return (left, right) => left.title.localeCompare(right.title) || right.number - left.number;
      if (sort === "number") return (left, right) => right.number - left.number;
      return (left, right) => (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0) || right.number - left.number;
    }

    return { renderControls, items };
  };
}());
