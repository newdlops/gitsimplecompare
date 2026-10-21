// PR 저자·리뷰어 표현. 외부 이미지/개별 PR 요청 없이 현재 overview의 데이터만 사용한다.
(function () {
  "use strict";
  let context = "";
  let dateLocale, dateFormats;
  const expanded = new Set();
  /** 웹뷰에 주입한 번역을 사용하고 테스트/옛 host에서도 영어 fallback을 제공한다. */
  function text(key, fallback) { return window.GscPrStackI18n?.[key] || fallback; }
  /** 저장소가 바뀌면 이전 목록에서 펼친 리뷰어 상태를 해제해 동명 PR의 상태가 섞이지 않게 한다. */
  function setContext(next) { if (context !== next) { context = next; expanded.clear(); } }
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
  /** PR 상태를 읽을 수 있는 이름·아이콘·의미 색상 역할로 바꾼다. */
  function status(pr) {
    if (pr.state === "MERGED") return ["git-merge", text("prMerged", "Merged"), "merged"];
    if (pr.state === "CLOSED") return ["git-pull-request-closed", text("prClosed", "Closed"), "closed"];
    if (pr.isDraft) return ["git-pull-request-draft", text("prDraft", "Draft"), "draft"];
    return ["git-pull-request", text("prOpen", "Open"), "open"];
  }
  /** GitHub의 enum을 UI 문구로 바꾸며 알 수 없는 상태는 원래 값을 보존한다. */
  function decision(pr) {
    return { APPROVED: text("reviewApproved", "Approved"), CHANGES_REQUESTED: text("reviewChanges", "Changes requested"),
      REVIEW_REQUIRED: text("reviewRequired", "Review required") }[pr.reviewDecision] || pr.reviewDecision || "";
  }
  /** 추가 네트워크·타이머 없이 받은 갱신 시각을 날짜와 정확한 시각 툴팁으로 보여준다. 잘못된 날짜는 생략한다. */
  function updated(pr) {
    const date = new Date(pr.updatedAt), locale = window.GscPrStackI18n?.locale || "en";
    if (!Number.isFinite(date.getTime())) return "";
    // 80개 행을 다시 그릴 때 Intl formatter를 매번 생성하지 않고 현재 언어의 두 개만 공유한다.
    if (dateLocale !== locale) {
      let supported; try { supported = Intl.getCanonicalLocales(locale)[0]; } catch { supported = "en"; }
      dateFormats = [new Intl.DateTimeFormat(supported, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        new Intl.DateTimeFormat(supported, { dateStyle: "full", timeStyle: "long" })]; dateLocale = locale;
    }
    const short = dateFormats[0].format(date), full = dateFormats[1].format(date);
    const label = text("prUpdated", "Updated {0}").replace("{0}", short);
    return `<time class="pr-updated" datetime="${esc(date.toISOString())}" title="${esc(full)}">${esc(label)}</time>`;
  }
  /** 저자와 리뷰어 상태를 명확히 구분하고 펼친 목록에서도 받은 데이터만 표시한다. */
  function render(pr, loading) {
    const author = pr.author ? `@${pr.author}` : text("unknownAuthor", "Unknown author"), people = pr.reviewers || [];
    const isExpanded = expanded.has(Number(pr.number)), visible = isExpanded ? people : people.slice(0, 2);
    const items = visible.map(person => {
      const [icon, label, kind] = state(person), name = `@${person.login}`;
      const title = `${person.name || name} · ${label}${person.kind === "team" ? ` · ${text("reviewTeam", "Team")}` : ""}`;
      return `<span class="pr-person pr-reviewer is-${kind}" title="${esc(title)}"><span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
        (person.kind === "team" ? `<span class="codicon codicon-organization" aria-hidden="true"></span>` : "") +
        `<span class="pr-person-name">${esc(name)}</span><span class="pr-review-state">${esc(label)}</span></span>`;
    });
    if (people.length > 2) {
      const label = isExpanded ? text("reviewShowLess", "Show fewer reviewers") : text("reviewShowAll", "Show all {0} loaded reviewers").replace("{0}", people.length);
      items.push(`<button type="button" class="pr-review-more" data-pr-reviewers-toggle="${Number(pr.number)}" aria-expanded="${isExpanded}" ` +
        `title="${esc(label)}" aria-label="${esc(label)}">${isExpanded ? esc(text("reviewLess", "Show less")) : `+${people.length - 2}`}</button>`);
    }
    if (pr.reviewersComplete === false && people.length) items.push(`<span class="pr-people-empty" title="${esc(text("reviewMore", "More reviewers are not shown"))}">${esc(text("reviewPartial", "Partial reviewer list"))}</span>`);
    return `<div class="pr-people${isExpanded ? " is-expanded" : ""}"><div class="pr-author-row"><span class="pr-people-group pr-author"><span class="pr-people-label">${esc(text("prAuthor", "Author"))}</span>` +
      `<span class="pr-person" title="${esc(author)}"><span class="codicon codicon-account" aria-hidden="true"></span><span class="pr-person-name">${esc(author)}</span></span></span>${updated(pr)}</div>` +
      `<span class="pr-people-group pr-reviewers"><span class="pr-people-label">${esc(text("prReviewers", "Reviewers"))}</span>` +
      `<span class="pr-reviewer-items">` + (items.length ? items.join("") : `<span class="pr-people-empty">${esc(empty(pr, loading))}</span>`) + `</span></span></div>`;
  }
  /** 펼치기 버튼만 처리하고 PR 상세 열기 이벤트로 전파되지 않게 호출자에게 처리 여부를 반환한다. */
  function toggle(event) {
    const button = event.target.closest?.("[data-pr-reviewers-toggle]");
    if (!button) return false;
    const number = Number(button.dataset.prReviewersToggle);
    if (expanded.has(number)) expanded.delete(number); else expanded.add(number);
    return true;
  }
  /** 카드의 접근성 이름에도 같은 저자·리뷰 상태를 넣어 키보드 탐색 시 문맥을 잃지 않는다. */
  function summary(pr, loading) {
    return `${text("prAuthor", "Author")}: ${pr.author || text("unknownAuthor", "Unknown author")}. ` +
      `${text("prReviewers", "Reviewers")}: ${(pr.reviewers || []).slice(0,2).map(person => `${person.login}, ${state(person)[1]}`).join("; ") || empty(pr, loading)}`;
  }
  window.GscGraphPrPeople = { render, summary, status, decision, setContext, toggle };
})();
