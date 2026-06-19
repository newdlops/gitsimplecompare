// 그래프 rebase 실행 진행도를 배너와 row/node 강조로 표시한다.
// - 확장 호스트가 보내는 graphRebaseProgress 메시지를 기준으로 pause/conflict/failure 위치를 보여준다.
(function () {
  "use strict";

  const graphPane = document.getElementById("graph-pane");
  const graphEl = document.getElementById("graph");
  const graphContent = document.getElementById("graph-content");
  const terminalPhases = new Set(["completed", "aborted", "cancelled", "noop"]);
  const focusPhases = new Set(["paused", "conflicts", "failed"]);
  let current = null;
  let hideTimer = null;
  let focusedKey = "";

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text == null ? "" : text).replace(/[&<>"]/g, (ch) => map[ch]);
  }

  /** CSS selector 에 넣을 값을 이스케이프한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  /** 진행 배너 DOM 을 만들거나 기존 것을 반환한다. */
  function ensurePanel() {
    let panel = document.getElementById("graph-rebase-progress");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "graph-rebase-progress";
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      graphPane.insertBefore(panel, graphEl);
    }
    return panel;
  }

  /** 진행 배너를 제거하고 그래프 강조도 정리한다. */
  function removePanel() {
    document.getElementById("graph-rebase-progress")?.remove();
    clearMarks();
  }

  /** 자동 숨김 타이머를 취소한다. */
  function clearHideTimer() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  /** 완료/중단 상태를 잠깐 보여준 뒤 숨긴다. */
  function scheduleHide() {
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      current = null;
      focusedKey = "";
      removePanel();
    }, 4500);
  }

  /** 새 진행 상태를 저장하고 화면에 반영한다. */
  function setProgress(progress) {
    clearHideTimer();
    current = progress || null;
    render();
    if (current && terminalPhases.has(current.phase)) {
      scheduleHide();
    }
  }

  /** 현재 진행 상태 배너를 렌더링한다. */
  function render() {
    if (!current) {
      removePanel();
      return;
    }
    const panel = ensurePanel();
    panel.className = `phase-${current.phase}`;
    panel.setAttribute("aria-label", `${current.title || ""}. ${current.detail || ""}`.trim());
    panel.innerHTML =
      `<span class="codicon codicon-${iconForPhase(current.phase)}" aria-hidden="true"></span>` +
      `<div class="rebase-progress-main">` +
      `<div class="rebase-progress-title">${esc(current.title)}</div>` +
      `<div class="rebase-progress-detail">${esc(current.detail)}</div>` +
      meterHtml(current) +
      todoCardsHtml(current) +
      `</div>` +
      `<span class="rebase-progress-label">${esc(labelForPhase(current.phase))}</span>`;
    applyMarks();
  }

  /** todo 단계가 있으면 짧은 진행 막대를 만든다. */
  function meterHtml(progress) {
    const total = Number(progress.total || 0);
    if (total <= 0) {
      return "";
    }
    const step = Math.max(0, Number(progress.step || 0));
    const width = step > 0
      ? Math.max(6, Math.min(100, Math.round((step / total) * 100)))
      : progress.phase === "running" ? 10 : 0;
    const label = step > 0 ? `${step} / ${total}` : `${total} todo`;
    return `<div class="rebase-progress-meter" title="${esc(label)}">` +
      `<span style="width: ${width}%"></span><em>${esc(label)}</em></div>`;
  }

  /** rebase todo 를 카드 리스트로 렌더링한다. */
  function todoCardsHtml(progress) {
    const todos = Array.isArray(progress.todos) ? progress.todos : [];
    if (todos.length === 0) {
      return "";
    }
    const cards = todos.map((todo) => {
      const role = todo.role === "current" ? "current" : "remaining";
      const title = todo.hash
        ? `${shortHash(todo.hash)}${todo.subject ? ` ${todo.subject}` : ""}`
        : (todo.subject || todo.action || "todo");
      return `<button type="button" class="rebase-todo-card ${role}" data-hash="${esc(todo.hash || "")}" ` +
        `title="${esc(title)}" aria-label="${esc(todoLabel(todo))}" data-tooltip="${esc(todoLabel(todo))}">` +
        `<span class="todo-index">${esc(todo.index)}</span>` +
        `<span class="todo-meta"><strong>${esc(todo.role === "current" ? "Current" : todo.action)}</strong>` +
        `<em>${esc(title)}</em></span>` +
        `</button>`;
    }).join("");
    const omitted = Number(progress.omittedTodoCount || 0);
    const more = omitted > 0
      ? `<span class="rebase-todo-more" title="${esc(`${omitted} more todo item(s)`)}">+${esc(omitted)} more</span>`
      : "";
    return `<div class="rebase-todo-list">${cards}${more}</div>`;
  }

  /** todo 카드의 접근성/tooltip 라벨을 만든다. */
  function todoLabel(todo) {
    const state = todo.role === "current" ? "Current todo" : "Remaining todo";
    const hash = todo.hash ? shortHash(todo.hash) : "";
    return `${state} ${todo.index}: ${todo.action || ""} ${hash} ${todo.subject || ""}`.trim();
  }

  /** 긴 commit hash 를 카드 표시용으로 줄인다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 10);
  }

  /** 현재 hash/originalHash 에 대응하는 row 와 node 를 강조한다. */
  function applyMarks() {
    clearMarks();
    if (!current) {
      return;
    }
    const hashes = targetHashes(current);
    if (hashes.length === 0) {
      return;
    }
    let firstRow = null;
    hashes.forEach((hash) => {
      const escaped = cssEscape(hash);
      const row = graphContent.querySelector(`.row[data-hash="${escaped}"]`);
      const node = graphContent.querySelector(`.node[data-hash="${escaped}"]`);
      row?.classList.add("rebase-progress-target", `rebase-progress-${current.phase}`);
      node?.classList.add("rebase-progress-target-node", `rebase-progress-${current.phase}-node`);
      firstRow = firstRow || row;
    });
    if (firstRow) {
      focusTargetOnce(firstRow);
    }
  }

  /** 이전 진행 강조 클래스를 모두 제거한다. */
  function clearMarks() {
    graphContent.querySelectorAll(".rebase-progress-target").forEach((row) => {
      row.classList.remove(
        "rebase-progress-target",
        "rebase-progress-running",
        "rebase-progress-paused",
        "rebase-progress-conflicts",
        "rebase-progress-failed",
        "rebase-progress-completed",
        "rebase-progress-aborted",
        "rebase-progress-cancelled",
        "rebase-progress-noop"
      );
    });
    graphContent.querySelectorAll(".rebase-progress-target-node").forEach((node) => {
      node.classList.remove(
        "rebase-progress-target-node",
        "rebase-progress-running-node",
        "rebase-progress-paused-node",
        "rebase-progress-conflicts-node",
        "rebase-progress-failed-node",
        "rebase-progress-completed-node",
        "rebase-progress-aborted-node",
        "rebase-progress-cancelled-node",
        "rebase-progress-noop-node"
      );
    });
  }

  /** 멈춤/실패 위치가 보이면 한 번만 가운데로 스크롤한다. */
  function focusTargetOnce(row) {
    if (!focusPhases.has(current.phase)) {
      return;
    }
    const key = `${current.phase}:${current.originalHash || current.hash || ""}`;
    if (focusedKey === key) {
      return;
    }
    focusedKey = key;
    row.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /** 강조할 해시 목록을 중복 없이 반환한다. */
  function targetHashes(progress) {
    const hashes = [];
    [progress.hash, progress.originalHash].forEach((hash) => {
      if (hash && !hashes.includes(hash)) {
        hashes.push(hash);
      }
    });
    return hashes;
  }

  /** progress phase 에 맞는 codicon 이름을 고른다. */
  function iconForPhase(phase) {
    if (phase === "paused") return "debug-pause";
    if (phase === "conflicts") return "warning";
    if (phase === "failed") return "error";
    if (phase === "completed") return "pass";
    if (phase === "aborted") return "debug-stop";
    if (phase === "cancelled") return "circle-slash";
    if (phase === "noop") return "info";
    return "sync";
  }

  /** progress phase 를 짧은 상태 라벨로 바꾼다. */
  function labelForPhase(phase) {
    if (phase === "conflicts") return "Conflicts";
    if (phase === "completed") return "Done";
    if (phase === "aborted") return "Aborted";
    if (phase === "cancelled") return "Cancelled";
    if (phase === "noop") return "No-op";
    return phase.charAt(0).toUpperCase() + phase.slice(1);
  }

  /** 기존 메시지와의 호환을 위해 상세 progress 가 없을 때 기본 상태를 만든다. */
  function fallbackProgress(msg) {
    if (msg.type === "graphRebasePaused") {
      const paused = msg.paused || {};
      return {
        phase: "paused",
        action: "continue",
        title: "Paused at edit commit",
        detail: "Edit files for this commit, then Continue.",
        hash: paused.hash,
        originalHash: paused.originalHash,
        active: true,
      };
    }
    if (msg.type === "graphRebaseOperation" && msg.active) {
      return {
        phase: "conflicts",
        action: "continue",
        title: "Paused with conflicts",
        detail: "Resolve conflicts, then Continue.",
        active: true,
      };
    }
    return null;
  }

  /** 확장에서 받은 rebase 진행 메시지를 처리한다. */
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "graphRebaseProgress") {
      setProgress(msg.progress);
    } else if (msg.type === "graphRebasePlan") {
      current = null;
      focusedKey = "";
      clearHideTimer();
      removePanel();
    } else if (msg.type === "graphRebaseClear") {
      if (terminalPhases.has(current?.phase)) {
        scheduleHide();
      } else {
        current = null;
        focusedKey = "";
        removePanel();
      }
    } else if (msg.type === "graph") {
      window.setTimeout(applyMarks, 0);
    } else if (!current || current.phase === "running") {
      const fallback = fallbackProgress(msg);
      if (fallback) {
        setProgress(fallback);
      }
    }
  });

  graphPane.addEventListener("click", (event) => {
    const card = event.target.closest?.(".rebase-todo-card[data-hash]");
    const hash = card?.dataset?.hash;
    if (!hash) {
      return;
    }
    const row = graphContent.querySelector(`.row[data-hash="${cssEscape(hash)}"]`);
    row?.scrollIntoView({ block: "center", inline: "nearest" });
  });

  window.GscGraphRebaseProgress = {
    applyMarks,
    current: () => current,
  };
})();
