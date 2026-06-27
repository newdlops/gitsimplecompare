// Pull Request label 렌더링 유틸.
// - graphPr.js 가 PR 상세/목록 흐름에 집중하도록 label chip 생성과 색상 적용을 분리한다.
(function () {
  "use strict";

  const MAX_VISIBLE_LABELS = 6;

  /** PR 카드/상세 메타 영역에 넣을 label chip HTML 을 만든다. */
  function render(pr) {
    const labels = labelsFor(pr);
    if (!labels.length) {
      return "";
    }
    const visible = labels.slice(0, MAX_VISIBLE_LABELS);
    const hidden = labels.slice(MAX_VISIBLE_LABELS);
    return visible.map(labelChip).join("") + hiddenChip(hidden);
  }

  /** PR 검색 haystack 에 포함할 label 이름/설명 문자열을 만든다. */
  function searchText(pr) {
    return labelsFor(pr)
      .map((label) => [label.name, label.description].filter(Boolean).join(" "))
      .join(" ");
  }

  /**
   * 특정 DOM 아래 label chip 의 data 색상 값을 CSS 변수로 반영한다.
   * @param root 새로 렌더링된 drawer/hover 영역. 없으면 document 전체를 처리한다.
   */
  function hydrate(root) {
    (root || document).querySelectorAll?.("[data-pr-label-color]").forEach(applyLabelColor);
  }

  /** PR 객체에서 렌더링 가능한 label 배열만 추린다. */
  function labelsFor(pr) {
    return (Array.isArray(pr?.labels) ? pr.labels : [])
      .map((label) => ({
        name: String(label?.name || "").trim(),
        color: normalizeColor(label?.color),
        description: String(label?.description || "").trim(),
      }))
      .filter((label) => label.name);
  }

  /** label 한 건을 GitHub 색상 chip 으로 렌더링한다. */
  function labelChip(label) {
    const title = label.description ? `Label: ${label.name} - ${label.description}` : `Label: ${label.name}`;
    const color = label.color ? ` data-pr-label-color="${esc(label.color)}"` : "";
    return `<span class="pr-label-chip"${color} ${tooltipAttrs(title)}>` +
      `<span class="pr-label-name">${esc(label.name)}</span></span>`;
  }

  /** 표시 개수를 넘긴 label 이 있으면 접힌 개수 chip 을 만든다. */
  function hiddenChip(hidden) {
    if (!hidden.length) {
      return "";
    }
    const title = `More labels: ${hidden.map((label) => label.name).join(", ")}`;
    return `<span class="pr-label-chip pr-label-more" ${tooltipAttrs(title)}>+${hidden.length}</span>`;
  }

  /** data attribute 에 저장된 label 색상을 chip CSS 변수로 적용한다. */
  function applyLabelColor(el) {
    const color = normalizeColor(el.dataset.prLabelColor);
    if (!color) {
      return;
    }
    el.style.setProperty("--pr-label-background", `#${color}`);
    el.style.setProperty("--pr-label-border", `#${color}`);
    el.style.setProperty("--pr-label-foreground", readableTextColor(color));
  }

  /** GitHub label 색상을 6자리 hex 문자열로 정규화한다. */
  function normalizeColor(value) {
    const hex = String(value || "").replace(/^#/, "");
    return /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : "";
  }

  /** label 배경색 위에서 읽히는 흑/백 전경색을 계산한다. */
  function readableTextColor(hex) {
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
    return luminance >= 150 ? "#1f2328" : "#ffffff";
  }

  /** 동적 렌더링으로 새 label chip 이 들어올 때 색상을 자동 적용한다. */
  function observeLabels() {
    hydrate(document);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            hydrate(node);
          }
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /** tooltip/title/aria-label 속성을 함께 만든다. */
  function tooltipAttrs(title) {
    const value = esc(title);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  window.GscGraphPrLabels = { hydrate, render, searchText };
  observeLabels();
})();
