// 그래프 reflog 항목 상세 패널 렌더러.
// - reflog 목록에서 항목을 선택하면 오른쪽 상세 뷰에 복구 액션과 출처 근거를 보여준다.
(function () {
  "use strict";

  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** reflog hash 의 앞뒤 공백을 제거한다. */
  function cleanHash(hash) {
    return String(hash || "").trim();
  }

  /** ISO 날짜를 상세 뷰에 맞는 짧은 문자열로 바꾼다. */
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

  /** reflog 항목 상세를 오른쪽 detail 영역에 렌더링한다. */
  function show(entry, index, context) {
    const host = window.GscGraphDetailHost;
    if (!host?.root || !entry) {
      return;
    }
    const hash = cleanHash(entry.hash);
    const loaded = Boolean(context?.loaded);
    host.show("reflog entry");
    host.root.innerHTML =
      `<div class="detail-shell reflog-detail">` +
      `<section class="commit-summary reflog-detail-summary">` +
      `<h2>${esc(entry.message || "Reflog entry")}</h2>` +
      metaHtml(entry, index, hash) +
      flowHtml(entry, loaded) +
      `<div class="actions reflog-detail-actions">` +
      actionButton("showInGraph", "target", "Load and show this reflog entry in graph", "Show in Graph", hash) +
      actionButton("createBranch", "git-branch-create", "Create branch at this reflog entry", "Create Branch", hash) +
      actionButton("checkoutCommit", "debug-restart", "Checkout this reflog commit detached", "Checkout", hash) +
      actionButton("copyCommitHash", "copy", "Copy reflog commit hash", "Copy Hash", hash) +
      `</div>` +
      provenanceHtml(entry) +
      messageHtml(entry) +
      `</section></div>`;
    bindActions(host.root);
  }

  /** 상세 상단의 hash, selector, 날짜 메타 정보를 만든다. */
  function metaHtml(entry, index, hash) {
    return `<div class="commit-meta reflog-detail-meta">` +
      `<span>R${esc(index + 1)}</span>` +
      `<span>${esc(hash.slice(0, 10))}</span>` +
      `<span>${esc(entry.shortSelector || entry.selector || "")}</span>` +
      `<span class="commit-date">${esc(formatDate(entry.dateIso))}</span>` +
      `</div>`;
  }

  /** 상세 액션 버튼 HTML 을 만든다. */
  function actionButton(action, icon, title, label, hash) {
    return `<button type="button" data-reflog-detail-action="${esc(action)}" data-hash="${esc(hash)}" ` +
      `title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span>` +
      `<span>${esc(label)}</span></button>`;
  }

  /** 현재 브랜치 흐름과 reflog 이벤트 의미를 상세 상단에 표시한다. */
  function flowHtml(entry, loaded) {
    const flow = flowState(entry);
    const relation = window.GscGraphReflogModel?.relationLabel?.(entry, loaded) || "Timeline";
    const event = window.GscGraphReflogModel?.eventLabel?.(entry) || "Reflog update";
    const summary = window.GscGraphReflogModel?.relationSummary?.(entry, loaded) || "";
    const meaning = window.GscGraphReflogModel?.eventMeaning?.(entry) || "";
    const hint = window.GscGraphReflogModel?.recoveryHint?.(entry, loaded) || "";
    return `<div class="reflog-detail-flow-block reflog-${esc(flow)}">` +
      `<div class="reflog-detail-flow">` +
      `<span class="reflog-graph-state reflog-relation-${esc(flow)}">${esc(relation)}</span>` +
      `<span class="reflog-event-chip">${esc(event)}</span>` +
      `</div>` +
      `<p class="reflog-detail-explain">${esc(summary)} ${esc(meaning)}</p>` +
      `<p class="reflog-detail-hint">${esc(hint)}</p></div>`;
  }

  /** 상세 액션 버튼을 graph 메시지 또는 reflog custom event 에 연결한다. */
  function bindActions(root) {
    root.querySelectorAll("[data-reflog-detail-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const hash = cleanHash(button.dataset.hash);
        const action = button.dataset.reflogDetailAction;
        if (!hash) {
          return;
        }
        if (action === "showInGraph") {
          window.dispatchEvent(new CustomEvent("gsc-reflog-show-in-graph", { detail: { hash } }));
        } else if (action === "createBranch") {
          window.GscGraphPostMessage?.({ type: "createBranch", hash });
        } else if (action === "checkoutCommit") {
          window.GscGraphPostMessage?.({ type: "checkoutCommit", hash });
        } else if (action === "copyCommitHash") {
          window.GscGraphPostMessage?.({ type: "copyCommitHash", hash });
        }
      });
    });
  }

  /** reflog 출처 근거를 상세 섹션으로 만든다. */
  function provenanceHtml(entry) {
    const rows = [];
    const currentRefs = window.GscGraphReflogModel?.currentRefNames?.(entry) || [];
    if (currentRefs.length) {
      rows.push(sourceRow("Current flow", currentRefs.join(", ")));
    }
    const move = entry.checkoutMove;
    if (move?.from || move?.to) {
      rows.push(sourceRow("HEAD checkout", `${move.from || "unknown"} -> ${move.to || "unknown"}`));
    }
    (entry.branchSources || []).forEach((source) => {
      rows.push(sourceRow(
        source.kind === "remote" ? "Remote branch log" : "Branch log",
        `${source.name} · ${source.selector}${source.message ? ` · ${source.message}` : ""}`
      ));
    });
    return `<section class="reflog-detail-section">` +
      `<h3>Reflog Source</h3>` +
      (rows.length ? rows.join("") : `<p class="reflog-detail-muted">No branch reflog evidence.</p>`) +
      `</section>`;
  }

  /** 상세 출처 근거 한 줄을 만든다. */
  function sourceRow(label, value) {
    return `<div class="reflog-detail-source"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  /** 모델이 없거나 오래된 메시지를 받을 때도 안전한 flow 상태를 반환한다. */
  function flowState(entry) {
    return window.GscGraphReflogModel?.flowState?.(entry) || "timeline";
  }

  /** 원본 reflog 메시지를 상세 섹션으로 만든다. */
  function messageHtml(entry) {
    return `<section class="reflog-detail-section">` +
      `<h3>Reflog Message</h3>` +
      `<pre>${esc(entry.message || "")}</pre>` +
      `</section>`;
  }

  window.GscGraphReflogDetail = { show };
})();
