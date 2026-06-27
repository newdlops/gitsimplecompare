// reflog recovery 패널의 항목 목록 HTML 생성 모듈.
// - 패널 상태/이벤트 바인딩은 graphReflog.js 에 두고, row 마크업과 라벨 계산만 담당한다.
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

  /** reflog/object hash 의 앞뒤 공백을 제거한다. */
  function cleanHash(hash) {
    return String(hash || "").trim();
  }

  /**
   * reflog 항목 리스트 HTML 을 만든다.
   * @param {Array<object>} entries reflog/object 항목 목록
   * @param {object} context loading 상태와 hashLoaded 함수
   */
  function entriesHtml(entries, context) {
    if (context?.loading && entries.length === 0) {
      return `<div class="reflog-empty">Loading...</div>`;
    }
    if (entries.length === 0) {
      return `<div class="reflog-empty">No reflog entries.</div>`;
    }
    return entries.map((entry, index) => entryHtml(entry, index, context)).join("");
  }

  /** reflog/object 항목 한 줄 HTML 을 만든다. */
  function entryHtml(entry, index, context) {
    const entryHash = cleanHash(entry.hash);
    const hash = shortHash(entryHash);
    const loaded = Boolean(context?.hashLoaded?.(entryHash));
    const flow = flowState(entry);
    const state = relationLabel(entry, loaded);
    const summary = relationSummary(entry, loaded);
    const expired = entry.recovery?.kind === "expired";
    const canRecover = Boolean(entry.recovery?.available);
    const classes = [
      "reflog-entry",
      `reflog-${flow}`,
      loaded ? "graph-loaded" : "graph-missing",
      entryHash === context?.activeHash ? "graph-active" : "",
      entryHash === context?.hoverHash ? "graph-hover" : "",
    ].filter(Boolean).join(" ");
    return `<article class="${classes}" data-hash="${esc(entryHash)}" data-flow="${esc(flow)}">` +
      `<div class="reflog-index"><span class="reflog-timeline-dot" title="${esc(state)}"></span><span>${esc(entryCode(entry, index))}</span></div>` +
      `<div class="reflog-main" role="button" tabindex="0" data-reflog-detail="1" data-reflog-index="${esc(index)}" ` +
      `title="${esc(state)}: ${esc(summary)}" aria-label="Show reflog details" data-tooltip="${esc(state)}: ${esc(summary)}">` +
      `<div class="reflog-title"><code>${esc(hash)}</code><strong>${esc(entry.message || "reflog entry")}</strong>` +
      `<span class="reflog-graph-state reflog-relation-${esc(flow)}">${esc(state)}</span>` +
      `<span class="reflog-recovery-chip reflog-recovery-${esc(recoveryKind(entry))}">${esc(recoveryLabel(entry))}</span>` +
      `<span class="reflog-event-chip">${esc(eventLabel(entry))}</span></div>` +
      `<div class="reflog-meta"><span>${esc(entry.shortSelector || entry.selector)}</span>` +
      `<span>${esc(formatDate(entry.dateIso))}</span><span>${esc(sourceLabel(entry))}</span></div>` +
      `<div class="reflog-flow-summary">${esc(summary)}</div>` +
      `<div class="reflog-transition">${esc(transitionText(entry))}</div>` +
      provenanceHtml(entry) +
      `</div>` +
      `<div class="reflog-entry-actions">` +
      entryButton("showInGraph", "target", loaded ? "Show this recovery entry in graph" : "Load and show this recovery entry in graph", entryHash, expired) +
      entryButton("createBranch", "git-branch-create", recoverButtonTitle(entry, canRecover), entryHash, !canRecover) +
      entryButton("restoreBranch", "history", restoreButtonTitle(entry, canRecover), entryHash, !canRecover) +
      entryButton("cherryPick", "git-pull-request-create", "Cherry-pick this commit onto the current branch", entryHash, expired) +
      entryButton("checkoutCommit", "debug-restart", "Checkout this commit detached", entryHash, expired) +
      entryButton("copyCommitHash", "copy", "Copy commit hash", entryHash) +
      `</div></article>`;
  }

  /** reflog 항목 액션 버튼 HTML 을 만든다. */
  function entryButton(action, icon, title, hash, disabled) {
    const clean = cleanHash(hash);
    return `<button class="reflog-entry-button" type="button" data-reflog-action="${esc(action)}" ` +
      `data-hash="${esc(clean)}" title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}" ${disabled ? "disabled" : ""}>` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** 항목 출처 근거 chip HTML 을 만든다. */
  function provenanceHtml(entry) {
    const chips = [];
    const currentRefs = model()?.currentRefNames?.(entry) || [];
    if (currentRefs.length) chips.push(chipHtml("Current flow", currentRefs.join(", ")));
    const move = entry.checkoutMove;
    if (move?.from) chips.push(chipHtml("Moved from", move.from));
    if (move?.to && move.to !== move.from) chips.push(chipHtml("To", move.to));
    const local = model()?.branchSourceNames?.(entry, "local") || [];
    if (local.length) chips.push(chipHtml("Branch log", local.join(", ")));
    const remote = model()?.branchSourceNames?.(entry, "remote") || [];
    if (remote.length) chips.push(chipHtml("Remote log", remote.join(", ")));
    const parents = (entry.parentHashes || []).map(shortHash).filter(Boolean);
    if (parents.length) chips.push(chipHtml("Parent", parents.slice(0, 2).join(", ")));
    const drop = firstDropSource(entry);
    if (drop) chips.push(chipHtml("Dropped by", dropLabel(drop)));
    if (entry?.source === "unreachable") chips.push(chipHtml("Object", "git fsck"));
    if (!chips.length) return `<div class="reflog-provenance muted">No branch reflog evidence</div>`;
    return `<div class="reflog-provenance" title="${esc(model()?.provenanceTitle?.(entry) || "")}">${chips.join("")}</div>`;
  }

  /** 브랜치 출처 표시용 chip HTML 을 만든다. */
  function chipHtml(label, value) {
    return `<span class="reflog-origin-chip"><em>${esc(label)}</em><strong>${esc(value)}</strong></span>`;
  }

  function model() { return window.GscGraphReflogModel; }
  function flowState(entry) { return model()?.flowState?.(entry) || "timeline"; }
  function relationLabel(entry, loaded) { return model()?.relationLabel?.(entry, loaded) || (loaded ? "On graph" : "Timeline"); }
  function relationSummary(entry, loaded) { return model()?.relationSummary?.(entry, loaded) || "HEAD reflog entry."; }
  function eventLabel(entry) { return model()?.eventLabel?.(entry) || "Reflog update"; }
  function recoveryKind(entry) { return model()?.recoveryKind?.(entry) || "reachable"; }
  function recoveryLabel(entry) { return model()?.recoveryLabel?.(entry) || "On branch"; }

  /** HEAD/object 전이를 짧은 텍스트로 표시한다. */
  function transitionText(entry) {
    if (entry?.source === "unreachable") {
      const parent = (entry.parentHashes || []).map(shortHash).filter(Boolean).join(", ");
      const drop = firstDropSource(entry);
      if (drop) return `dropped when ${dropLabel(drop)} moved ${shortHash(drop.fromHash)} -> ${shortHash(drop.toHash)}`;
      return parent ? `object ${shortHash(entry.hash)} after parent ${parent}` : `object ${shortHash(entry.hash)} placed by commit date`;
    }
    return `HEAD ${shortHash(entry.transition?.fromHash) || "unknown"} -> ${shortHash(entry.hash)}`;
  }

  function entryCode(entry, index) { return `${entry?.source === "unreachable" ? "O" : "R"}${index + 1}`; }
  function sourceLabel(entry) { return entry?.source === "unreachable" ? "Unreachable object" : "HEAD reflog"; }
  function firstDropSource(entry) { return Array.isArray(entry?.dropSources) ? entry.dropSources[0] : undefined; }
  function dropLabel(source) { return `${source?.name || "unknown branch"}${source?.viaHash ? ` via ${shortHash(source.viaHash)}` : ""}`; }
  function recoverButtonTitle(entry, canRecover) {
    if (!canRecover) return entry.recovery?.reason || "This recovery entry is not a branch target";
    return entry?.source === "unreachable" ? "Recover by creating branch at this object" : "Recover by creating branch at this HEAD state";
  }
  function restoreButtonTitle(entry, canRecover) {
    if (!canRecover) return entry.recovery?.reason || "This recovery entry is not a branch target";
    return "Restore an existing local branch to this recovery entry";
  }
  function shortHash(hash) { return String(hash || "").slice(0, 10); }
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  window.GscGraphReflogList = { entriesHtml };
})();
