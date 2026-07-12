// Changes 웹뷰 Worktrees 섹션 렌더/이벤트 모듈.
// - 메인 changes.js 가 이미 큰 파일이라 worktree 전용 UI 를 별도 전역 헬퍼로 분리한다.
(function () {
  "use strict";

  const T = Object.assign(
    {
      worktrees: "Worktrees",
      noWorktrees: "No worktrees found.",
      openWorktree: "Open Worktree",
      renameWorktree: "Rename Worktree",
      removeWorktree: "Remove Worktree",
      mainWorktree: "main",
      detached: "detached",
      locked: "locked",
      prunable: "prunable",
      pathLabel: "Path",
      branchLabel: "Branch",
      headLabel: "HEAD",
      repositoryLabel: "Repository",
      yes: "yes",
    },
    window.__gscI18n || {}
  );

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** data-* 속성에 넣을 값을 안전하게 문자열화한다. */
  function dataAttr(value) {
    return esc(value == null ? "" : value);
  }

  /** HEAD 해시를 행 보조 정보로 쓸 짧은 값으로 줄인다. */
  function shortHead(head) {
    return head ? String(head).slice(0, 7) : "";
  }

  /** worktree 상태 배지에 들어갈 짧은 라벨 목록을 만든다. */
  function statusLabels(worktree) {
    return [
      worktree.isMain ? T.mainWorktree : undefined,
      worktree.locked !== undefined ? T.locked : undefined,
      worktree.prunable !== undefined ? T.prunable : undefined,
    ].filter(Boolean);
  }

  /** hover title 에서 경로/브랜치/상태를 확인할 수 있는 설명을 만든다. */
  function worktreeTitle(worktree) {
    const lines = [
      `${T.openWorktree}: ${worktree.path}`,
      worktree.branch ? `${T.branchLabel}: ${worktree.branch}` : T.detached,
      worktree.head ? `${T.headLabel}: ${worktree.head}` : undefined,
      worktree.repoName ? `${T.repositoryLabel}: ${worktree.repoName}` : undefined,
      worktree.locked !== undefined
        ? `${T.locked}: ${worktree.locked || T.yes}`
        : undefined,
      worktree.prunable !== undefined
        ? `${T.prunable}: ${worktree.prunable || T.yes}`
        : undefined,
    ].filter(Boolean);
    return lines.join("\n");
  }

  /** worktree 한 행의 인라인 액션 버튼 HTML 을 만든다. */
  function rowActionsHtml(worktree) {
    let html =
      `<button class="row-action worktree-action codicon codicon-go-to-file" ` +
      `type="button" data-act="openWorktree" title="${esc(T.openWorktree)}" ` +
      `aria-label="${esc(T.openWorktree)}"></button>`;
    if (!worktree.isMain) {
      html +=
        `<button class="row-action worktree-action codicon codicon-edit" ` +
        `type="button" data-act="renameWorktree" title="${esc(T.renameWorktree)}" ` +
        `aria-label="${esc(T.renameWorktree)}"></button>` +
        `<button class="row-action worktree-action codicon codicon-trash" ` +
        `type="button" data-act="removeWorktree" title="${esc(T.removeWorktree)}" ` +
        `aria-label="${esc(T.removeWorktree)}"></button>`;
    }
    return `<span class="row-actions worktree-row-actions">${html}</span>`;
  }

  /** worktree 한 건을 VS Code 리스트 톤의 행 HTML 로 만든다. */
  function rowHtml(worktree) {
    const labels = statusLabels(worktree);
    const branch = worktree.branch || T.detached;
    const head = shortHead(worktree.head);
    const openLabel = `${T.openWorktree}: ${worktree.path}`;
    return (
      `<div class="row worktree-row${worktree.activeRepo ? " active-repo" : ""}" ` +
      `role="button" tabindex="0" data-repo-root="${dataAttr(worktree.repoRoot)}" ` +
      `data-path="${dataAttr(worktree.path)}" data-is-main="${worktree.isMain ? "true" : "false"}" ` +
      `data-branch="${dataAttr(worktree.branch)}" title="${esc(worktreeTitle(worktree))}" ` +
      `aria-label="${esc(openLabel)}">` +
      `<span class="icon codicon ${worktree.isMain ? "codicon-repo" : "codicon-repo-forked"}"></span>` +
      `<span class="name">${esc(worktree.name || worktree.path)}</span>` +
      `<span class="worktree-branch"><span class="codicon codicon-git-branch"></span>${esc(branch)}</span>` +
      (head ? `<span class="worktree-head">${esc(head)}</span>` : "") +
      labels.map((label) => `<span class="worktree-badge">${esc(label)}</span>`).join("") +
      `<span class="worktree-repo">${esc(worktree.repoName || "")}</span>` +
      rowActionsHtml(worktree) +
      `</div>`
    );
  }

  /** Worktrees 섹션 본문 HTML 을 만든다. */
  function body(worktrees) {
    const rows = Array.isArray(worktrees) ? worktrees : [];
    if (!rows.length) {
      return `<p class="empty">${esc(T.noWorktrees)}</p>`;
    }
    return `<div class="worktree-list">${rows.map(rowHtml).join("")}</div>`;
  }

  /** DOM 행에서 extension host 명령에 넘길 worktree 인자를 만든다. */
  function commandArg(row) {
    return {
      repoRoot: row.dataset.repoRoot,
      path: row.dataset.path,
      isMain: row.dataset.isMain === "true",
      branch: row.dataset.branch || undefined,
    };
  }

  /** Worktrees 섹션 행 클릭/키보드/인라인 액션을 extension host 메시지로 연결한다. */
  function bind(rootEl, vscode) {
    rootEl.querySelectorAll(".worktree-row").forEach((row) => {
      const open = () => vscode.postMessage(Object.assign({ type: "openWorktree" }, commandArg(row)));
      row.addEventListener("click", (event) => {
        if (event.target.closest(".worktree-action")) {
          return;
        }
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        open();
      });
    });
    rootEl.querySelectorAll(".worktree-action").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest(".worktree-row");
        if (!row) {
          return;
        }
        vscode.postMessage(Object.assign({ type: button.dataset.act }, commandArg(row)));
      });
    });
  }

  window.__gscWorktrees = { body, bind };
})();
