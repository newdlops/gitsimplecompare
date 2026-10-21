// PR 저자·리뷰어 표현. 외부 이미지/개별 PR 요청 없이 현재 overview의 데이터만 사용한다.
(function () {
  "use strict";
  /** 웹뷰에 주입한 번역을 사용하고 테스트/옛 host에서도 영어 fallback을 제공한다. */
  function text(key, fallback) { return window.GscPrStackI18n?.[key] || fallback; }
  /** GitHub 사용자 입력이 태그나 속성으로 실행되지 않도록 HTML을 이스케이프한다. */
  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
  /** 상태는 색뿐 아니라 사용자에게 읽히는 텍스트와 Codicon으로 구분한다. */
  function state(person) {
    const states = {
      REQUESTED: ["clock", text("reviewAwaiting", "Awaiting review"), "requested"],
      APPROVED: ["check", text("reviewApproved", "Approved"), "approved"],
      CHANGES_REQUESTED: ["edit", text("reviewChanges", "Changes requested"), "changes"],
      COMMENTED: ["comment", text("reviewCommented", "Commented"), "commented"],
      DISMISSED: ["circle-slash", text("reviewDismissed", "Dismissed"), "dismissed"],
    };
    return states[person.state] || ["clock", text("reviewPending", "Pending"), "pending"];
  }
  /** 첫 목록의 미조회·후속 실패·완료한 빈 리뷰어를 서로 다른 문구로 표시한다. */
  function empty(pr, loading) {
    if (pr.reviewersComplete === false && pr.reviewers !== undefined) return text("reviewMore", "More reviewers are not shown");
    return pr.reviewers === undefined ? loading ? text("reviewLoading", "Loading reviewers…") : text("reviewUnavailable", "Reviewers unavailable")
      : text("reviewNone", "No reviewers");
  }
  /** 저자와 최대 두 명의 상태를 노출하고 나머지 이름은 정보 툴팁에 보존한다. */
  function render(pr, loading) {
    const author = pr.author ? `@${pr.author}` : text("unknownAuthor", "Unknown author"), people = pr.reviewers || [];
    const items = people.slice(0, 2).map(person => {
      const [icon, label, kind] = state(person), name = `@${person.login}`;
      const title = `${person.name || name} · ${label}${person.kind === "team" ? ` · ${text("reviewTeam", "Team")}` : ""}`;
      return `<span class="pr-person pr-reviewer is-${kind}" title="${esc(title)}"><span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
        `<span class="pr-person-name">${esc(name)}</span><span class="pr-review-state">${esc(label)}</span></span>`;
    });
    if (people.length > 2 || pr.reviewersComplete === false) {
      const more = people.slice(2).map(person => `@${person.login} · ${state(person)[1]}`).join("\n");
      const title = [more, pr.reviewersComplete === false ? text("reviewMore", "More reviewers are not shown") : ""].filter(Boolean).join("\n");
      items.push(`<span class="pr-review-more" title="${esc(title)}">${people.length > 2 ? `+${people.length - 2}` : ""}${pr.reviewersComplete === false ? "…" : ""}</span>`);
    }
    return `<div class="pr-people"><span class="pr-people-group pr-author"><span class="pr-people-label">${esc(text("prAuthor", "Author"))}</span>` +
      `<span class="pr-person" title="${esc(author)}"><span class="codicon codicon-account" aria-hidden="true"></span><span class="pr-person-name">${esc(author)}</span></span></span>` +
      `<span class="pr-people-group pr-reviewers"><span class="pr-people-label">${esc(text("prReviewers", "Reviewers"))}</span>` +
      `<span class="pr-reviewer-items">` + (items.length ? items.join("") : `<span class="pr-people-empty">${esc(empty(pr, loading))}</span>`) + `</span></span></div>`;
  }
  /** 카드의 접근성 이름에도 같은 저자·리뷰 상태를 넣어 키보드 탐색 시 문맥을 잃지 않는다. */
  function summary(pr, loading) {
    return `${text("prAuthor", "Author")}: ${pr.author || text("unknownAuthor", "Unknown author")}. ` +
      `${text("prReviewers", "Reviewers")}: ${(pr.reviewers || []).slice(0,2).map(person => `${person.login}, ${state(person)[1]}`).join("; ") || empty(pr, loading)}`;
  }
  window.GscGraphPrPeople = { render, summary };
})();
