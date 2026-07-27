// Reviews queue lane의 다음 GitHub search page를 lazy로 읽는 renderer helper.
// - host cursor가 있을 때만 action을 보이고 refresh/page 오류 뒤에도 다른 lane을 막지 않는다.
(function () {
  "use strict";

  /** shared state와 DOM helper를 받아 lane별 load-more control을 만든다. */
  window.__gscReviewsQueuePagination = function createReviewsQueuePagination(deps) {
    const { T, state, vscode, element, actionButton, render } = deps;

    /** cursor가 남은 lane 또는 그 lane의 page error에만 footer action을 렌더한다. */
    function renderControl(lane) {
      const current = paginationState();
      const hasMore = Boolean(state.snapshot.nextCursors?.[lane]);
      const error = current.errors[lane];
      if (!hasMore && !error) return document.createDocumentFragment();
      const footer = element("div", "reviews__queue-page");
      if (error) {
        const banner = element("div", "gsc-banner gsc-banner--warning", error);
        banner.setAttribute("role", "alert");
        footer.append(banner);
      }
      if (hasMore) {
        const pending = Boolean(current.loading[lane]);
        const label = pending ? T.loadingMorePullRequests : T.loadMorePullRequests;
        const action = actionButton("gsc-button", label, () => load(lane));
        action.disabled = pending;
        action.setAttribute("aria-busy", String(pending));
        footer.append(action);
      }
      return footer;
    }

    /** 한 lane의 cursor read만 pending으로 만들고 host에 다음 page 의도를 보낸다. */
    function load(lane) {
      const current = paginationState();
      if (current.loading[lane] || !state.snapshot.nextCursors?.[lane]) return;
      current.loading[lane] = true;
      delete current.errors[lane];
      render();
      vscode.postMessage({ type: "loadMoreQueue", lane });
    }

    /** host page 결과만 해당 lane의 local loading/error state에 반영한다. */
    function applyResult(message) {
      const current = paginationState();
      if (message.type === "queuePageLoaded") {
        state.snapshot = message.snapshot;
        delete current.loading[message.lane];
        delete current.errors[message.lane];
      }
      if (message.type === "queuePageError") {
        delete current.loading[message.lane];
        current.errors[message.lane] = message.message || T.unavailable;
      }
    }

    /** persisted state가 이전 버전이어도 lane keyed pending/error map을 안전하게 복원한다. */
    function paginationState() {
      if (!state.queuePagination) state.queuePagination = { loading: {}, errors: {} };
      return state.queuePagination;
    }

    return { renderControl, applyResult };
  };
}());
