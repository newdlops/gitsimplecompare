// graph 브랜치 배지에 git worktree 점유 상태를 덧붙이는 모듈.
// - graphFeatures 의 refBadge 를 감싸 기존 브랜치/태그 렌더링 규칙은 그대로 재사용한다.
(function () {
  "use strict";

  let worktreesByBranch = new Map();

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 확장에서 받은 worktree 점유 상태를 branch 이름 기준으로 저장한다. */
  function setWorktrees(worktrees) {
    const next = new Map();
    (worktrees || []).forEach((item) => {
      if (!item || !item.branch) {
        return;
      }
      const list = next.get(item.branch) || [];
      list.push(item);
      next.set(item.branch, list);
    });
    next.forEach((list) =>
      list.sort((a, b) =>
        worktreeLabel(a).localeCompare(worktreeLabel(b)) ||
        String(a.path || "").localeCompare(String(b.path || ""))
      )
    );
    worktreesByBranch = next;
  }

  /** branch ref 에 붙일 worktree 보조 배지를 포함해 ref HTML 을 보강한다. */
  function decorateRefBadge(ref, html, escapeHtml) {
    const worktrees = worktreesByBranch.get(ref);
    if (!worktrees?.length || !html) {
      return html;
    }
    const safeEsc = escapeHtml || esc;
    return insertBeforeOuterClose(
      appendTooltip(html, worktreeTooltip(worktrees), safeEsc),
      worktreeBadge(worktrees, safeEsc)
    );
  }

  /** 기존 tooltip 문장 뒤에 worktree 점유 정보를 덧붙인다. */
  function appendTooltip(html, tooltip, safeEsc) {
    const escaped = safeEsc(tooltip);
    return html.replace(/data-tooltip="([^"]*)"/, (_match, oldValue) =>
      `data-tooltip="${oldValue} | ${escaped}"`
    );
  }

  /** branch chip 내부에 삽입할 작은 worktree 배지 HTML 을 만든다. */
  function worktreeBadge(worktrees, safeEsc) {
    const primary = worktrees[0];
    const label =
      worktrees.length > 1 ? String(worktrees.length) : worktreeLabel(primary);
    const tooltip = worktreeTooltip(worktrees);
    return (
      `<span class="ref-worktree-badge" title="${safeEsc(tooltip)}" ` +
      `aria-label="${safeEsc(tooltip)}">` +
      `<span class="codicon codicon-repo-forked" aria-hidden="true"></span>` +
      `<span class="ref-worktree-label">${safeEsc(label)}</span></span>`
    );
  }

  /** worktree 배지 hover 에 표시할 상세 설명을 만든다. */
  function worktreeTooltip(worktrees) {
    if (worktrees.length === 1) {
      const item = worktrees[0];
      return [
        `Worktree: ${worktreeLabel(item)}`,
        item.path ? `Path: ${item.path}` : "",
        item.locked != null ? `locked${item.locked ? `: ${item.locked}` : ""}` : "",
        item.prunable != null ? `prunable${item.prunable ? `: ${item.prunable}` : ""}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }
    return `Worktrees: ${worktrees.map(worktreeLabel).join(", ")}`;
  }

  /** badge 에 짧게 표시할 worktree 이름을 고른다. */
  function worktreeLabel(item) {
    if (!item) {
      return "";
    }
    return item.isMain ? "main" : item.name || basename(item.path) || item.path || "";
  }

  /** 경로 문자열에서 마지막 segment 를 꺼낸다. */
  function basename(value) {
    const path = String(value || "").replace(/\\/g, "/");
    const index = path.lastIndexOf("/");
    return index >= 0 ? path.slice(index + 1) : path;
  }

  /** 기존 ref badge HTML 의 가장 바깥 닫는 span 앞에 내용을 삽입한다. */
  function insertBeforeOuterClose(html, addition) {
    const marker = "</span>";
    const index = html.lastIndexOf(marker);
    return index >= 0
      ? html.slice(0, index) + addition + html.slice(index)
      : html + addition;
  }

  /** graphFeatures refBadge 를 감싸 worktree 배지를 투명하게 추가한다. */
  function install() {
    const features = window.GscGraphFeatures;
    if (!features?.refBadge || features.refBadge.__worktreeDecorated) {
      return;
    }
    const original = features.refBadge;
    const wrapped = function (ref, escapeHtml) {
      return decorateRefBadge(ref, original(ref, escapeHtml), escapeHtml);
    };
    wrapped.__worktreeDecorated = true;
    features.refBadge = wrapped;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "branchStatus") {
      setWorktrees(event.data.worktrees || []);
    }
  });

  window.GscGraphWorktrees = { setWorktrees };
  install();
})();
