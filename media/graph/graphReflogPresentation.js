// reflog 패널 요약과 공통 아이콘 버튼 마크업. 조회·선택·패널 수명은 graphReflog가 소유한다.
(function () {
  "use strict";
  /** 외부 라벨을 HTML 본문과 속성에 안전하게 넣는다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  /** @param {object[]} entries 현재 항목 @param {boolean} objectScan 객체 검사 포함 여부 @returns {string} 상태별 요약 */
  function summaryHtml(entries, objectScan) {
    const counts = window.GscGraphReflogModel?.counts?.(entries) || { flow: 0, dropped: 0, timeline: 0, object: 0 };
    const note = objectScan ? "Objects come from git fsck and may disappear after garbage collection."
      : "Fast loading reads HEAD and branch reflogs.";
    return `<span class="reflog-summary-chip reflog-relation-flow">Branch flow ${esc(counts.flow)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-dropped">Dropped ${esc(counts.dropped)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-timeline">Timeline ${esc(counts.timeline)}</span>` +
      `<span class="reflog-summary-chip reflog-relation-object">Objects ${esc(counts.object || 0)}</span>` +
      `<span class="reflog-summary-note">${esc(note)}</span>`;
  }
  /** @returns {string} 즉시 tooltip과 접근성 이름을 함께 제공하는 패널 아이콘 버튼 */
  function iconButton(id, icon, title) {
    return `<button id="${esc(id)}" class="icon-button" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }
  window.GscGraphReflogPresentation = { summaryHtml, iconButton };
})();
