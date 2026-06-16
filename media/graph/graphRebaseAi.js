// 그래프 rebase 계획에 AI 제안을 적용하는 웹뷰 보강 스크립트.
// - 기본 rebase 는 수동으로 유지하고, 사용자가 AI Plan 버튼을 눌렀을 때만 동작한다.
(function () {
  "use strict";

  const ACTIONS = new Set(["pick", "reword", "edit", "squash", "fixup", "drop"]);
  let loading = false;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text == null ? "" : text).replace(/[&<>"]/g, (ch) => map[ch]);
  }

  /** rebase bar 에 AI 계획 버튼을 삽입한다. */
  function injectButton() {
    const bar = document.getElementById("graph-rebase-bar");
    const run = document.getElementById("graph-rebase-run");
    if (!bar || !run || document.getElementById("graph-rebase-ai")) {
      updateButton();
      decorateModules();
      return;
    }
    const button = document.createElement("button");
    button.id = "graph-rebase-ai";
    button.type = "button";
    button.title = "Generate AI rebase plan";
    button.setAttribute("aria-label", "Generate AI rebase plan");
    button.dataset.tooltip = "Ask AI to reorder commits, improve messages, and group files by module";
    button.innerHTML = '<span class="codicon codicon-sparkle" aria-hidden="true"></span><span>AI Plan</span>';
    button.addEventListener("click", requestAiPlan);
    bar.insertBefore(button, run);
    updateButton();
    decorateModules();
  }

  /** 버튼의 loading 상태를 반영한다. */
  function updateButton() {
    const button = document.getElementById("graph-rebase-ai");
    if (!button) {
      return;
    }
    button.disabled = loading;
    button.classList.toggle("loading", loading);
    button.querySelector("span:last-child").textContent = loading ? "Planning..." : "AI Plan";
  }

  /** 현재 rebase 계획 스냅샷을 extension host 에 보낸다. */
  function requestAiPlan() {
    const context = window.GscGraphRebaseContext;
    const plan = context?.plan?.();
    const items = context?.items?.() || [];
    if (!plan || !items.length || loading) {
      return;
    }
    loading = true;
    updateButton();
    window.GscGraphPostMessage?.({
      type: "generateGraphRebaseAiPlan",
      plan: {
        branch: plan.branch || "",
        base: plan.base || "",
        root: Boolean(plan.root),
        onto: plan.onto || "",
        commits: items.map((item) => ({
          hash: item.hash,
          subject: item.subject || "",
          body: item.body || "",
          action: item.action || "pick",
          message: item.message || "",
          files: item.files || [],
        })),
      },
    });
  }

  /** extension host 가 보낸 AI 계획을 현재 todo 에 반영한다. */
  function applyAiPlan(result) {
    const context = window.GscGraphRebaseContext;
    const items = context?.items?.();
    if (!items?.length || !result?.items?.length) {
      return;
    }
    const byHash = new Map(items.map((item) => [item.hash, item]));
    const ordered = [];
    const seen = new Set();
    result.items.forEach((suggestion, index) => {
      const item = byHash.get(suggestion.hash);
      if (!item || seen.has(item.hash)) {
        return;
      }
      seen.add(item.hash);
      applySuggestion(item, suggestion, index === 0);
      ordered.push(item);
    });
    items.forEach((item) => {
      if (!seen.has(item.hash)) {
        ordered.push(item);
      }
    });
    items.splice(0, items.length, ...ordered);
    context.render?.();
    window.GscGraphDetail?.refresh?.();
    window.setTimeout(decorateModules, 0);
  }

  /** AI 제안 한 건을 기존 item 에 반영한다. */
  function applySuggestion(item, suggestion, first) {
    let action = ACTIONS.has(suggestion.action) ? suggestion.action : "pick";
    const message = String(suggestion.message || "").trim();
    if (first && (action === "squash" || action === "fixup")) {
      action = message ? "reword" : "pick";
    }
    if (message && action === "pick") {
      action = "reword";
    }
    item.action = action;
    item.message = message;
    item.module = String(suggestion.module || "").trim();
    item.aiReason = String(suggestion.reason || "").trim();
  }

  /** rebase row 에 module chip 을 표시한다. */
  function decorateModules() {
    const items = window.GscGraphRebaseContext?.items?.() || [];
    const byHash = new Map(items.map((item) => [item.hash, item]));
    document.querySelectorAll(".rebase-ai-module").forEach((el) => el.remove());
    document.querySelectorAll("#graph-content .row.rebase-row").forEach((row) => {
      const item = byHash.get(row.dataset.hash || "");
      if (!item?.module) {
        return;
      }
      const chip = document.createElement("span");
      chip.className = "rebase-ai-module";
      chip.textContent = item.module;
      chip.title = item.aiReason ? `${item.module}: ${item.aiReason}` : item.module;
      row.querySelector(".rebase-action-marker")?.after(chip);
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "graphRebaseAiPlan") {
      loading = false;
      applyAiPlan(msg.result);
      updateButton();
    } else if (msg.type === "error" || msg.type === "graphRebaseClear") {
      loading = false;
      updateButton();
    } else if (msg.type === "graphRebasePlan" || msg.type === "graph" || msg.type === "graphRebaseOperation") {
      window.setTimeout(injectButton, 0);
    }
  });
  new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true });
  window.GscGraphRebaseAi = { injectButton, decorateModules, esc };
  injectButton();
})();
