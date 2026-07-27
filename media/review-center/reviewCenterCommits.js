// Review Center Commits 탭의 lazy renderer.
// - commit 데이터는 탭이 실제로 열릴 때만 요청하며, 100개 cap과 오류/빈 상태를 명시한다.
(function () {
  "use strict";

  /** shared state/DOM primitive를 받아 Commits 탭의 독립 renderer를 만든다. */
  window.__gscReviewCenterCommits = function createReviewCenterCommits(deps) {
    const { T, state, vscode, el, button, render, section } = deps;

    /** lazy 결과, skeleton, 오류, cap notice를 포함한 commit 목록 surface를 만든다. */
    function renderCommits(content) {
      const commits = section(T.commitsTitle);
      const current = state.commits;
      if (current.loading && !current.data) commits.append(renderLoading());
      if (current.error) {
        const error = el("div", "gsc-banner gsc-banner--warning review-center__notice", current.error);
        error.setAttribute("role", "alert");
        commits.append(error, button("gsc-button review-center__commits-retry", T.retry, T.retryTitle, load));
      }
      if (current.data) {
        const list = el("div", "review-center__commits");
        if (!current.data.commits.length) list.append(el("div", "review-center__empty", T.noCommits));
        current.data.commits.forEach((commit) => list.append(renderCommit(commit)));
        commits.append(list);
        if (current.data.hasNextPage) commits.append(el("div", "gsc-banner gsc-banner--warning review-center__commits-note", T.commitsTruncated));
      }
      content.classList.add("review-center__content--single");
      content.append(commits);
    }

    /** 수신 전에도 tab 전환이 비어 보이지 않도록 commit-row skeleton을 만든다. */
    function renderLoading() {
      const loading = el("div", "review-center__commits-loading");
      loading.setAttribute("aria-label", T.loadingCommits);
      for (let index = 0; index < 4; index += 1) loading.append(el("span", "gsc-skeleton gsc-skeleton--row"));
      return loading;
    }

    /** commit subject, short SHA, author/time을 long-text-safe compact row로 만든다. */
    function renderCommit(commit) {
      const row = el("div", "review-center__commit");
      const detail = el("div", "review-center__commit-detail");
      detail.append(el("div", "review-center__commit-message", commit.message));
      const meta = el("div", "review-center__commit-meta");
      if (commit.author) meta.append(el("span", "", `@${commit.author}`));
      if (commit.authoredAt) meta.append(el("span", "", formatDate(commit.authoredAt)));
      detail.append(meta);
      const oid = el("span", "review-center__commit-oid gsc-code", commit.oid.slice(0, 12));
      oid.title = commit.oid;
      oid.setAttribute("aria-label", commit.oid);
      row.append(detail, oid);
      return row;
    }

    /** tab이 보일 때만 commit read를 요청하고 duplicate 요청을 막는다. */
    function load() {
      if (state.commits.loading) return;
      state.commits.loading = true;
      state.commits.error = "";
      render();
      vscode.postMessage({ type: "loadReviewCommits" });
    }

    /** locale에 맞춘 짧은 commit 시각을 안전하게 만든다. */
    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return T.updatedUnavailable;
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
    }

    return { renderCommits, load };
  };
}());
