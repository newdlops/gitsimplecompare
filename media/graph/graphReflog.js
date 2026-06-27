// 그래프 toolbar 의 reflog 복구 패널.
// - HEAD reflog 를 보여주고, 각 지점에서 브랜치 생성/checkout/hash 복사를 직접 실행한다.
(function () {
  "use strict";

  const button = document.getElementById("graph-reflog");
  const panel = document.getElementById("graph-reflog-panel");
  let entries = [];
  let loading = false;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 패널을 열고 최신 reflog 를 요청한다. */
  function openPanel() {
    if (!panel) {
      return;
    }
    panel.hidden = false;
    button?.classList.add("active");
    requestReflog();
  }

  /** 패널을 닫는다. */
  function closePanel() {
    if (!panel) {
      return;
    }
    panel.hidden = true;
    button?.classList.remove("active");
  }

  /** 패널 표시 상태를 토글한다. */
  function togglePanel() {
    if (!panel || panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  }

  /** 확장 호스트에 reflog refresh 를 요청한다. */
  function requestReflog() {
    loading = true;
    render();
    window.GscGraphPostMessage?.({ type: "refreshReflog" });
  }

  /** reflog 패널을 렌더링한다. */
  function render() {
    if (!panel || panel.hidden) {
      return;
    }
    panel.innerHTML =
      `<header>` +
      `<div><strong>Reflog Recovery</strong><span>${esc(statusText())}</span></div>` +
      `<div class="reflog-actions">` +
      iconButton("refresh-reflog", "refresh", "Refresh reflog") +
      iconButton("close-reflog", "close", "Close reflog") +
      `</div></header>` +
      `<div class="reflog-help">Create a branch at a reflog entry before experimenting with checkout or rebase recovery.</div>` +
      `<div class="reflog-list">${entriesHtml()}</div>`;
    panel.querySelector("#refresh-reflog")?.addEventListener("click", requestReflog);
    panel.querySelector("#close-reflog")?.addEventListener("click", closePanel);
    panel.querySelectorAll("[data-reflog-action]").forEach((action) => {
      action.addEventListener("click", () => postEntryAction(action));
    });
  }

  /** 현재 패널 상태 문구를 만든다. */
  function statusText() {
    if (loading) {
      return "Loading HEAD reflog...";
    }
    return `${entries.length} entries`;
  }

  /** reflog 항목 리스트 HTML 을 만든다. */
  function entriesHtml() {
    if (loading && entries.length === 0) {
      return `<div class="reflog-empty">Loading...</div>`;
    }
    if (entries.length === 0) {
      return `<div class="reflog-empty">No reflog entries.</div>`;
    }
    return entries.map((entry, index) => entryHtml(entry, index)).join("");
  }

  /** reflog 항목 한 줄 HTML 을 만든다. */
  function entryHtml(entry, index) {
    const hash = shortHash(entry.hash);
    const message = entry.message || "reflog entry";
    const date = formatDate(entry.dateIso);
    return `<article class="reflog-entry">` +
      `<div class="reflog-index">${esc(index + 1)}</div>` +
      `<div class="reflog-main">` +
      `<div class="reflog-title"><code>${esc(hash)}</code><strong>${esc(message)}</strong></div>` +
      `<div class="reflog-meta"><span>${esc(entry.shortSelector || entry.selector)}</span><span>${esc(date)}</span></div>` +
      `</div>` +
      `<div class="reflog-entry-actions">` +
      entryButton("createBranch", "git-branch-create", "Create branch at this reflog entry", entry.hash) +
      entryButton("checkoutCommit", "debug-restart", "Checkout this reflog commit detached", entry.hash) +
      entryButton("copyCommitHash", "copy", "Copy reflog commit hash", entry.hash) +
      `</div>` +
      `</article>`;
  }

  /** toolbar/panel icon button HTML 을 만든다. */
  function iconButton(id, icon, title) {
    return `<button id="${id}" class="icon-button" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** reflog 항목 액션 버튼 HTML 을 만든다. */
  function entryButton(action, icon, title, hash) {
    return `<button class="reflog-entry-button" type="button" data-reflog-action="${esc(action)}" ` +
      `data-hash="${esc(hash)}" title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** reflog 항목 버튼 클릭을 기존 graph action 메시지로 변환한다. */
  function postEntryAction(button) {
    const hash = button.dataset.hash || "";
    if (!hash) {
      return;
    }
    const action = button.dataset.reflogAction;
    if (action === "createBranch") {
      window.GscGraphPostMessage?.({ type: "createBranch", hash });
    } else if (action === "checkoutCommit") {
      window.GscGraphPostMessage?.({ type: "checkoutCommit", hash });
    } else if (action === "copyCommitHash") {
      window.GscGraphPostMessage?.({ type: "copyCommitHash", hash });
    }
  }

  /** 커밋 해시를 짧게 줄인다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 10);
  }

  /** reflog selector 날짜를 보기 좋은 짧은 형태로 만든다. */
  function formatDate(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  button?.addEventListener("click", togglePanel);
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type !== "graphReflog") {
      return;
    }
    entries = Array.isArray(msg.entries) ? msg.entries : [];
    loading = false;
    if (!panel?.hidden) {
      render();
    }
  });
})();
