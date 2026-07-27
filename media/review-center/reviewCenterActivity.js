// Review Center Activity 탭의 lazy timeline renderer.
// - PR comment·review·commit을 날짜와 유형으로 탐색하게 하고, file review thread의 write surface와 분리한다.
(function () {
  "use strict";

  /** shared state와 DOM primitive로 Activity timeline의 독립 renderer를 만든다. */
  window.__gscReviewCenterActivity = function createReviewCenterActivity(deps) {
    const { T, state, vscode, el, button, render, section } = deps;

    /** lazy 결과·필터·오류·first-page 상한을 포함한 timeline section을 만든다. */
    function renderTimeline(content) {
      const timeline = section(T.activityTimeline);
      const current = activityState();
      if (current.loading && !current.data) timeline.append(renderLoading());
      if (current.error) {
        const error = el("div", "gsc-banner gsc-banner--warning review-center__notice", current.error);
        error.setAttribute("role", "alert");
        timeline.append(error, button("gsc-button review-center__activity-retry", T.retryTitle, T.retry, load));
      }
      if (current.data) renderItems(timeline, current);
      content.append(timeline);
    }

    /** 타임라인 결과가 도착하기 전에도 현재 tab이 비어 보이지 않게 skeleton을 만든다. */
    function renderLoading() {
      const loading = el("div", "review-center__activity-loading");
      loading.setAttribute("aria-label", T.loadingActivity);
      for (let index = 0; index < 5; index += 1) loading.append(el("span", "gsc-skeleton gsc-skeleton--row"));
      return loading;
    }

    /** 종류 필터, 날짜 group, 각 activity row를 long-text-safe 형태로 렌더한다. */
    function renderItems(timeline, current) {
      const filter = el("label", "gsc-field review-center__activity-filter");
      filter.append(el("span", "gsc-field__label", T.activityFilter));
      const select = el("select", "gsc-select");
      [["all", T.activityAll], ["comment", T.activityComments], ["review", T.activityReviews], ["commit", T.activityCommits], ["event", T.activityEvents]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        select.append(option);
      });
      select.value = current.kind;
      select.addEventListener("change", () => { current.kind = select.value; render(); });
      filter.append(select);
      timeline.append(filter);
      const items = current.data.items.filter((item) => current.kind === "all" || item.kind === current.kind);
      if (!items.length) timeline.append(el("div", "review-center__empty", T.noActivity));
      const list = el("div", "review-center__activity-list");
      let dateKey = "";
      items.forEach((item) => {
        const nextKey = dateGroup(item.createdAt);
        if (nextKey !== dateKey) {
          dateKey = nextKey;
          list.append(el("h3", "review-center__activity-date", nextKey));
        }
        list.append(renderItem(item));
      });
      timeline.append(list);
      if (!current.data.eventsAvailable) timeline.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.activityEventsUnavailable));
      if (current.data.truncated) timeline.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.activityTruncated));
    }

    /** 유형·작성자·시각·본문을 가진 activity 한 줄을 만든다. */
    function renderItem(item) {
      const row = el("article", "review-center__activity-item");
      const meta = el("div", "review-center__activity-meta");
      meta.append(el("span", "gsc-status-pill", kindLabel(item.kind)));
      if (item.state) meta.append(el("span", "gsc-status-pill", readable(item.state)));
      if (item.author) meta.append(el("span", "", `@${item.author}`));
      if (item.createdAt) meta.append(el("span", "", formatDate(item.createdAt)));
      row.append(meta, el("div", "review-center__activity-body", item.kind === "event" ? eventBody(item) : item.body || T.noCommentBody));
      return row;
    }

    /** Activity 종류 식별자를 번역된 filter label로 바꾼다. */
    function kindLabel(kind) {
      return ({ comment: T.activityComments, review: T.activityReviews, commit: T.activityCommits, event: T.activityEvents })[kind] || kind;
    }

    /** 최신 snapshot이 교체돼도 이전 persisted state를 안전한 기본값으로 보정한다. */
    function activityState() {
      if (!state.activity) state.activity = { loading: false, error: "", data: null, kind: "all" };
      if (!["all", "comment", "review", "commit", "event"].includes(state.activity.kind)) state.activity.kind = "all";
      return state.activity;
    }

    /** tab이 visible일 때만 host에 읽기 의도를 보내며 duplicate request를 막는다. */
    function load() {
      const current = activityState();
      if (current.loading) return;
      current.loading = true;
      current.error = "";
      render();
      vscode.postMessage({ type: "loadReviewActivity" });
    }

    /** locale date group은 날짜가 없을 때도 하나의 명시적인 unknown group을 유지한다. */
    function dateGroup(value) {
      const date = new Date(value || "");
      return Number.isNaN(date.getTime()) ? T.updatedUnavailable : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
    }

    /** locale에 맞는 간결한 activity 시각을 만든다. */
    function formatDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? T.updatedUnavailable : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    }

    /** GitHub enum의 밑줄을 읽기 쉬운 공백으로 표시한다. */
    function readable(value) {
      return String(value).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    /** host가 전달한 event 식별자와 subject를 번역된 운영 이력 문구로 조합한다. */
    function eventBody(item) {
      const subject = item.subject || T.none;
      return ({
        "force-push": template(T.activityEventForcePush, subject),
        "review-requested": template(T.activityEventReviewRequested, subject),
        assigned: template(T.activityEventAssigned, subject),
        labeled: template(T.activityEventLabeled, subject),
        milestoned: template(T.activityEventMilestoned, subject),
        draft: T.activityEventDraft,
        ready: T.activityEventReady,
      })[item.eventType] || T.activityEventUnknown;
    }

    /** host l10n에서 전달된 짧은 {0} template을 안전하게 적용한다. */
    function template(value, ...values) {
      return String(value || "").replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
    }

    return { renderTimeline, load, state: activityState };
  };
}());
