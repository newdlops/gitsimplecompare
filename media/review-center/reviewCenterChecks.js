// Review Center Checks 탭의 renderer와 lazy-loading UI 상태.
// - main renderer의 tab shell과 분리해 check row/empty/error/loading 책임을 한 모듈에 둔다.
(function () {
  "use strict";

  /** shared state/DOM primitive를 받아 Checks 탭의 독립 renderer를 만든다. */
  window.__gscReviewCenterChecks = function createReviewCenterChecks(deps) {
    const { T, state, vscode, el, button, render, section } = deps;

    /** latest head checks를 Required/All group으로 읽고 policy capability를 사실대로 표시한다. */
    function renderChecks(content) {
      const checks = section(T.checksTitle);
      const current = state.checks;
      if (current.loading && !current.data) checks.append(renderLoading());
      if (current.error) {
        const error = el("div", "gsc-banner gsc-banner--warning review-center__notice", current.error);
        error.setAttribute("role", "alert");
        checks.append(error, button("gsc-button review-center__checks-retry", T.retry, T.retryTitle, load));
      }
      if (current.data) {
        if (!current.data.requiredKnown) checks.append(el("div", "gsc-banner gsc-banner--warning review-center__checks-note", T.requiredChecksUnknown));
        if (current.data.requiredKnown) checks.append(renderRequiredPolicy(current.data));
        checks.append(renderCheckGroup(T.allChecks, current.data.checks, T.noChecks));
      }
      content.classList.add("review-center__content--single");
      content.append(checks);
    }

    /** branch protection에서 확인된 Required check 목록과 strict policy 상태를 요약한다. */
    function renderRequiredPolicy(data) {
      const policy = el("div", "review-center__checks-policy");
      const required = data.checks.filter((check) => check.isRequired);
      policy.append(el("div", "review-center__checks-policy-title", template(T.requiredChecksSummary, required.length)));
      policy.append(el("div", "review-center__checks-policy-detail", data.strict ? T.requiredChecksStrict : T.requiredChecksNotStrict));
      policy.append(renderCheckGroup(T.requiredChecks, required, T.noRequiredChecks));
      return policy;
    }

    /** Required 또는 All check group의 제목과 compact check row 목록을 만든다. */
    function renderCheckGroup(title, values, empty) {
      const group = el("section", "review-center__checks-group");
      group.append(el("h3", "review-center__checks-group-title", title));
      const list = el("div", "review-center__checks");
      if (!values.length) list.append(el("div", "review-center__empty", empty));
      values.forEach((check) => list.append(renderCheck(check)));
      group.append(list);
      return group;
    }

    /** check 목록 수신 전에도 짧은 skeleton을 보여 주어 tab 전환이 비어 보이지 않게 한다. */
    function renderLoading() {
      const loading = el("div", "review-center__checks-loading");
      loading.setAttribute("aria-label", T.loadingChecks);
      for (let index = 0; index < 4; index += 1) loading.append(el("span", "gsc-skeleton gsc-skeleton--row"));
      return loading;
    }

    /** check 한 건의 state, workflow, duration과 GitHub details action을 compact row로 만든다. */
    function renderCheck(check) {
      const row = el("div", "review-center__check");
      const detail = el("div", "review-center__check-detail");
      detail.append(el("div", "review-center__check-name", check.name));
      const meta = el("div", "review-center__check-meta");
      if (check.workflow) meta.append(el("span", "", check.workflow));
      if (check.startedAt && check.completedAt) meta.append(el("span", "", formatDuration(check.startedAt, check.completedAt)));
      detail.append(meta);
      const stateLabel = check.state.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
      const status = el("span", `gsc-status-pill review-center__check-status review-center__check-status--${check.bucket}`, stateLabel);
      row.append(detail, status);
      if (check.url) row.append(button("gsc-button gsc-button--ghost", T.openCheckDetails, T.openCheckDetails, () => vscode.postMessage({ type: "openCheckUrl", url: check.url })));
      return row;
    }

    /** tab이 보일 때만 checks read를 요청하고 duplicate/refresh 중 요청을 방지한다. */
    function load() {
      if (state.checks.loading) return;
      state.checks.loading = true;
      state.checks.error = "";
      render();
      vscode.postMessage({ type: "loadReviewChecks" });
    }

    /** check 시작/완료 시각의 양수 차이만 사람이 빠르게 읽을 duration으로 줄인다. */
    function formatDuration(startedAt, completedAt) {
      const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0) return "";
      if (elapsed < 60000) return `${Math.round(elapsed / 1000)}s`;
      return `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`;
    }

    /** host의 {0} 지역화 template을 간결하게 적용한다. */
    function template(value, ...values) {
      return String(value || "").replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
    }

    return { renderChecks, load };
  };
}());
