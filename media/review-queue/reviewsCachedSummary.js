// Reviews sidebar가 count-only cache를 PR metadata 없이 읽기 전용으로 보여 주는 renderer.
// - cache 상태에서는 review 행이나 management write action을 만들지 않아 stale count가 실제 권한/대상처럼 보이지 않게 한다.
(function () {
  "use strict";

  /** main renderer의 공용 DOM helper를 받아 cached count panel renderer를 만든다. */
  window.__gscReviewsCachedSummary = function createReviewsCachedSummary(deps) {
    const { T, element, actionButton, template, formatRefreshTime } = deps;

    /** verified identity와 count만 있는 cache panel을 만들고 fresh/stale copy를 분기한다. */
    function render(cached, retry, error) {
      const panel = element("section", "gsc-empty-state reviews__cached-summary");
      panel.id = "reviews-tabpanel";
      panel.tabIndex = -1;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-label", T.cachedSummaryTitle);
      panel.append(element("h2", "gsc-empty-state__title", T.cachedSummaryTitle));
      panel.append(element("p", "gsc-empty-state__body", template(T.cachedSummaryCounts, cached.counts.personal, cached.counts.management)));
      const status = error
        ? T.cachedSummaryError
        : cached.freshness === "stale"
        ? template(T.cachedSummaryStale, formatRefreshTime(cached.fetchedAt))
        : T.cachedSummaryRefreshing;
      panel.append(element("p", "gsc-empty-state__body", status));
      if (error) {
        const warning = element("div", "gsc-banner gsc-banner--warning", error);
        warning.setAttribute("role", "alert");
        panel.append(warning);
      }
      const refresh = actionButton("gsc-button gsc-button--ghost", T.retry, retry);
      refresh.title = T.retryTitle;
      refresh.setAttribute("aria-label", T.retryTitle);
      panel.append(refresh);
      return panel;
    }

    return { render };
  };
}());
