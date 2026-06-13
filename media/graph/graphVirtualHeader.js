// git graph 의 HEAD/ongoing/staged 상태를 스크롤 중에도 보이게 유지하는 보조 스크립트.
// - 실제 row 를 복제하지 않고 현재 렌더된 row 의 hash/subject 만 읽어 sticky header 버튼으로 표시한다.
(function () {
  "use strict";

  const graphEl = document.getElementById("graph");
  const contentEl = document.getElementById("graph-content");
  let headerEl;
  let syncQueued = false;

  if (!graphEl || !contentEl) {
    return;
  }

  /** HTML 특수문자를 이스케이프해 sticky header 에 안전하게 넣는다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** sticky header DOM 을 한 번만 만들고 반환한다. */
  function ensureHeader() {
    if (headerEl) {
      return headerEl;
    }
    headerEl = document.createElement("div");
    headerEl.id = "graph-virtual-header";
    headerEl.hidden = true;
    headerEl.setAttribute("aria-label", "Current graph state");
    graphEl.insertBefore(headerEl, contentEl);
    headerEl.addEventListener("click", handleClick);
    return headerEl;
  }

  /** 현재 렌더된 HEAD/가상 커밋 row 를 sticky header 항목으로 동기화한다. */
  function syncVirtualHeader() {
    syncQueued = false;
    syncScrollableWidth();
    const items = pinnedRows().map(toHeaderItem);
    const header = ensureHeader();
    header.hidden = items.length === 0;
    header.innerHTML = items.join("");
  }

  /** MutationObserver 에서 발생하는 잦은 row 변경을 한 프레임에 한 번으로 합친다. */
  function scheduleSync() {
    if (syncQueued) {
      return;
    }
    syncQueued = true;
    requestAnimationFrame(syncVirtualHeader);
  }

  /** row 내용이 많을 때 가로 스크롤로 전체 내용을 볼 수 있도록 캔버스 폭을 확장한다. */
  function syncScrollableWidth() {
    const rowsRight = Array.from(contentEl.querySelectorAll(".row")).reduce(
      (max, row) => Math.max(max, row.offsetLeft + row.scrollWidth + 24),
      0
    );
    const svg = contentEl.querySelector("svg");
    const graphRight = svg ? Number(svg.getAttribute("width") || 0) + 680 : 0;
    const width = Math.max(graphEl.clientWidth, rowsRight, graphRight);
    if (width > 0) {
      contentEl.style.width = `${width}px`;
      contentEl.style.minWidth = `${width}px`;
    }
  }

  /** ongoing, staged, HEAD 순서로 현재 row 요소를 찾는다. */
  function pinnedRows() {
    const rows = [
      contentEl.querySelector(".row.ongoing-row"),
      contentEl.querySelector(".row.staged-row"),
      headRow(),
    ].filter(Boolean);
    return Array.from(new Map(rows.map((row) => [row.dataset.hash, row])).values());
  }

  /** 현재 렌더된 실제 HEAD row 를 찾는다. */
  function headRow() {
    return Array.from(contentEl.querySelectorAll(".row")).find((row) =>
      (row.dataset.refs || "").split("\t").includes("HEAD")
    );
  }

  /** pinned row 를 sticky header 버튼 HTML 로 변환한다. */
  function toHeaderItem(row) {
    const kind = rowKind(row);
    const label = kind === "ongoing" ? "Ongoing" : kind === "staged" ? "Staged" : "HEAD";
    const icon =
      kind === "ongoing"
        ? "codicon-edit"
        : kind === "staged"
          ? "codicon-checklist"
          : "codicon-target";
    const subject = row.dataset.subject || label;
    const hash = row.dataset.hash || "";
    return `<button class="virtual-head-item ${kind}" type="button" ` +
      `data-hash="${esc(hash)}" title="Jump to ${esc(label)}" ` +
      `aria-label="Jump to ${esc(label)}">` +
      `<span class="codicon ${icon}" aria-hidden="true"></span>` +
      `<span class="virtual-head-label">${esc(label)}</span>` +
      `<span class="virtual-head-subject">${esc(subject)}</span></button>`;
  }

  /** row class/ref 에서 sticky header 항목 종류를 구한다. */
  function rowKind(row) {
    if (row.classList.contains("ongoing-row")) {
      return "ongoing";
    }
    if (row.classList.contains("staged-row")) {
      return "staged";
    }
    return "head";
  }

  /** sticky header 클릭 시 해당 가상 row 로 이동하고 상세 정보를 요청한다. */
  function handleClick(event) {
    const item = event.target.closest?.("[data-hash]");
    if (!item?.dataset.hash) {
      return;
    }
    const row = Array.from(contentEl.querySelectorAll(".row")).find(
      (candidate) => candidate.dataset.hash === item.dataset.hash
    );
    if (row) {
      graphEl.scrollTop = Math.max(0, row.offsetTop - 72);
      contentEl
        .querySelectorAll(".row.selected")
        .forEach((selected) => selected.classList.remove("selected"));
      row.classList.add("selected");
    }
    window.GscGraphPostMessage?.({
      type: "selectCommit",
      hash: item.dataset.hash,
    });
  }

  new MutationObserver(scheduleSync).observe(contentEl, {
    childList: true,
    subtree: false,
  });
  window.addEventListener("resize", scheduleSync);
  syncVirtualHeader();
})();
