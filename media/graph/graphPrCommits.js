// PR 커밋 표시를 현재 Graph DOM에서 분리한다. 상세 열기와 그래프 이동은 서로 다른 명시적 액션이다.
(function () {
  "use strict";

  /**
   * PR API 요약을 우선 사용해 현재 Graph 페이지 밖 커밋도 제목·작성 정보와 함께 표시한다.
   * @param pr 현재 선택한 PR snapshot, hashes 기존 우선순위의 원래/머지 커밋, heading 공통 섹션 제목
   * @returns 기존 PR 스타일의 커밋 목록 HTML. 요약이 아직 없더라도 상세 열기는 사용할 수 있다.
   */
  function render(pr, hashes, heading) {
    const summaries = new Map([pr.mergeCommitSummary, ...(pr.commitSummaries || [])].filter(Boolean).map(summary => [summary.hash, summary]));
    const rows = window.GscGraphPrMatching?.findCommitRows?.(hashes);
    const loading = pr.commitHashesComplete === false;
    return `<section class="pr-detail-section">${heading}` +
      (loading ? `<p class="pr-empty" role="status">${esc(window.GscPrStackI18n?.loadingPrCommits || "Loading pull request commits…")}</p>` : "") +
      (hashes.length ? `<div class="pr-commit-list">${hashes.map(hash => item(hash, summaries.get(hash), rows?.get(hash))).join("")}</div>`
        : loading ? "" : `<p class="pr-empty">${esc(window.GscPrStackI18n?.noRelatedCommits || "No related commits.")}</p>`) + `</section>`;
  }

  /**
   * 같은 커밋의 내용 읽기와 Graph 위치 이동을 서로 독립된 버튼으로 만든다.
   * @param hash 전체 OID, summary API 요약, row 요약이 없을 때만 참고할 현재 Graph 행
   * @returns tooltip과 접근성 이름을 포함한 한 커밋의 액션 HTML
   */
  function item(hash, summary, row) {
    const labels = window.GscPrStackI18n || {}, short = hash.slice(0, 8);
    const subject = summary ? summary.title || labels.noCommitMessage || "(No commit message)"
      : row?.dataset.subject || labels.viewCommitDetails || "View commit details";
    const metadata = summary ? [summary.author, formatDate(summary.dateIso)].filter(Boolean).join(" · ")
      : row?.querySelector(".meta")?.textContent || "";
    const openTitle = String(labels.openPrCommit || "Open commit {0} details").replace("{0}", short);
    const jumpTitle = String(labels.jumpToCommit || "Jump to commit {0} in the graph").replace("{0}", short);
    return `<div class="pr-commit-row"><button type="button" class="pr-commit-item" data-open-pr-commit="${esc(hash)}" ${tooltip(`${openTitle}: ${subject}`)}>` +
      `<span class="codicon codicon-git-commit" aria-hidden="true"></span><span class="pr-commit-hash">${esc(short)}</span>` +
      `<span class="pr-commit-text"><span>${esc(subject)}</span>${metadata ? `<small>${esc(metadata)}</small>` : ""}</span></button>` +
      `<button type="button" class="pr-icon-action" data-focus-commit="${esc(hash)}" ${tooltip(jumpTitle)}>` +
      `<span class="codicon codicon-target" aria-hidden="true"></span></button></div>`;
  }

  /** @param iso 선택적인 실제 ISO 시각 @returns 현재 UI 언어의 날짜·시각, 누락·오류 값이면 빈 문자열 */
  function formatDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(window.GscPrStackI18n?.locale || "en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  /** @param value 동작과 대상을 설명하는 문자열 @returns 동일한 hover tooltip·접근성 이름의 안전한 속성 HTML */
  function tooltip(value) { const text = esc(value); return `title="${text}" data-tooltip="${text}" aria-label="${text}"`; }
  /** @param value 외부 GitHub 메타데이터 또는 누락 값 @returns 속성·본문에 삽입할 HTML 특수문자 이스케이프 문자열 */
  function esc(value) { return String(value ?? "").replace(/[&<>\"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }

  window.GscGraphPrCommits = { render };
})();
