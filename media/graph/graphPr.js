// graph Pull Request POC UI.
// - PR 목록 패널, row/node decoration, PR 열기/preview 버튼을 graph.js 와 분리한다.
(function () {
  "use strict";

  let overview = { available: false, pullRequests: [] };
  let panel;

  /** PR UI 이벤트와 웹뷰 메시지 수신을 초기화한다. */
  function init() {
    panel = document.getElementById("graph-pr-panel");
    bindButton("graph-pr-list", togglePanel);
    bindButton("graph-pr-preview", () => {
      window.GscGraphPostMessage?.({ type: "previewStagedPullRequest" });
    });
    document.getElementById("graph-content")?.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-pr-number]");
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      window.GscGraphPostMessage?.({
        type: "openPullRequest",
        number: Number(target.dataset.prNumber),
      });
    }, true);
    panel?.addEventListener("click", handlePanelClick);
    window.addEventListener("message", handleMessage);
  }

  /** 버튼 click handler 를 연결한다. */
  function bindButton(id, handler) {
    document.getElementById(id)?.addEventListener("click", handler);
  }

  /** 확장에서 온 graph/PR 메시지를 반영한다. */
  function handleMessage(event) {
    const msg = event.data;
    if (msg.type === "pullRequestOverview") {
      overview = msg.overview || { available: false, pullRequests: [] };
      renderPanel();
      applyDecorations();
    } else if (msg.type === "graph") {
      requestAnimationFrame(applyDecorations);
    }
  }

  /** PR 목록 패널 열림 상태를 토글한다. */
  function togglePanel() {
    if (!panel) {
      return;
    }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderPanel();
      window.GscGraphPostMessage?.({ type: "refreshPullRequests" });
    }
  }

  /** PR 패널 내부 버튼 클릭을 처리한다. */
  function handlePanelClick(event) {
    const open = event.target.closest?.("[data-open-pr]");
    if (open) {
      window.GscGraphPostMessage?.({ type: "openPullRequest", number: Number(open.dataset.openPr) });
      return;
    }
    const preview = event.target.closest?.("[data-preview-pr]");
    if (preview) {
      window.GscGraphPostMessage?.({
        type: "previewStagedPullRequest",
        number: Number(preview.dataset.previewPr),
      });
    }
  }

  /** graph row/node 에 PR badge 와 강조 class 를 반영한다. */
  function applyDecorations() {
    const root = document.getElementById("graph-content");
    if (!root) {
      return;
    }
    root.querySelectorAll(".pr-badges").forEach((el) => el.remove());
    root.querySelectorAll(".pr-row").forEach((el) => el.classList.remove("pr-row"));
    root.querySelectorAll(".node.pr-node").forEach((el) => {
      el.classList.remove("pr-node", ...prColorClasses());
    });
    const byHash = pullRequestsByHash();
    root.querySelectorAll(".row[data-hash]").forEach((row) => {
      const prs = byHash.get(row.dataset.hash || "") || [];
      if (!prs.length) {
        return;
      }
      row.classList.add("pr-row");
      row.insertBefore(badges(prs), row.firstChild);
      const node = root.querySelector(`.node[data-hash="${cssEscape(row.dataset.hash || "")}"]`);
      node?.classList.add("pr-node", prColorClass(prs[0]?.number));
    });
  }

  /** commit hash 별 PR 목록 map 을 만든다. */
  function pullRequestsByHash() {
    const map = new Map();
    for (const pr of overview.pullRequests || []) {
      for (const hash of pr.commitHashes || []) {
        const list = map.get(hash) || [];
        list.push(pr);
        map.set(hash, list);
      }
    }
    return map;
  }

  /** row 에 붙일 PR badge 묶음을 만든다. */
  function badges(prs) {
    const box = document.createElement("span");
    box.className = "pr-badges";
    for (const pr of prs.slice(0, 3)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `pr-row-button ${prColorClass(pr.number)}`;
      button.dataset.prNumber = String(pr.number);
      button.dataset.tooltip = `Open PR #${pr.number}: ${pr.title} (${commentCount(pr)} comments)`;
      button.title = button.dataset.tooltip;
      button.setAttribute("aria-label", button.dataset.tooltip);
      button.innerHTML = `<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
        `<span>#${pr.number}</span>` +
        `<span class="pr-comment-count"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>${commentCount(pr)}</span>`;
      box.appendChild(button);
    }
    return box;
  }

  /** PR 목록 패널을 현재 overview 로 렌더링한다. */
  function renderPanel() {
    if (!panel) {
      return;
    }
    const prs = overview.pullRequests || [];
    const status = overview.available
      ? `${prs.length} pull requests`
      : `PR data unavailable${overview.error ? ": " + overview.error : ""}`;
    panel.innerHTML =
      `<div class="pr-panel-header"><span>${esc(status)}</span>` +
      `<button type="button" class="pr-panel-close" title="Close pull request list" data-tooltip="Close pull request list" aria-label="Close pull request list">` +
      `<span class="codicon codicon-close" aria-hidden="true"></span></button></div>` +
      (prs.length ? prs.map(prCard).join("") : `<p class="pr-empty">${esc(status)}</p>`);
    panel.querySelector(".pr-panel-close")?.addEventListener("click", () => {
      panel.hidden = true;
    });
  }

  /** PR 카드 HTML 을 만든다. */
  function prCard(pr) {
    const comments = (pr.comments || []).map((comment) =>
      `<li><strong>${esc(comment.author || "comment")}</strong> ${esc(trim(comment.body || "", 120))}</li>`
    ).join("");
    return `<article class="pr-card ${prColorClass(pr.number)}">` +
      `<div class="pr-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<strong>#${pr.number}</strong><span>${esc(pr.title)}</span></div>` +
      `<div class="pr-meta">${esc(pr.state)} · ${esc(pr.headRefName)} → ${esc(pr.baseRefName)} · comments ${commentCount(pr)}</div>` +
      `<div class="pr-actions">` +
      actionButton("open-pr", pr.number, "Open PR", `Open pull request #${pr.number}`) +
      actionButton("preview-pr", pr.number, "Preview staged PR", `Preview staged content against ${pr.baseRefName || "target branch"}`) +
      `</div>` +
      (comments ? `<ul class="pr-comments">${comments}</ul>` : "") +
    `</article>`;
  }

  /** PR 카드 액션 버튼 HTML 을 만든다. */
  function actionButton(kind, number, label, tooltip) {
    const attr = kind === "open-pr" ? "data-open-pr" : "data-preview-pr";
    return `<button type="button" ${attr}="${number}" title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}">${esc(label)}</button>`;
  }

  /** PR 번호를 안정적인 팔레트 class 로 바꾼다. */
  function prColorClass(number) {
    const value = Math.abs(Number(number) || 0) % 8;
    return `pr-color-${value}`;
  }

  /** 기존 색상 class 를 지울 때 쓰는 전체 팔레트 목록을 반환한다. */
  function prColorClasses() {
    return Array.from({ length: 8 }, (_, index) => `pr-color-${index}`);
  }

  /** badge/card 에 표시할 PR 댓글 총 개수를 반환한다. */
  function commentCount(pr) {
    return Number.isFinite(Number(pr.commentCount)) ? Number(pr.commentCount) : (pr.comments || []).length;
  }

  /** CSS selector 에 들어갈 값을 escape 한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  /** 긴 텍스트를 한 줄 preview 로 줄인다. */
  function trim(value, max) {
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  }

  init();
})();
