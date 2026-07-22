// Changes 웹뷰 PR Stacks 섹션 렌더/이벤트 모듈.
// - GitHub PR의 base/head 연결을 작은 트리로 표시하고 원격 토폴로지 명령만 host에 전달한다.
(function () {
  "use strict";

  const T = Object.assign(
    {
      pullRequestStacks: "PR Stacks",
      noPullRequestStacks: "No open pull requests. Create one to start a stack.",
      loadingPullRequestStacks: "Loading pull request stacks...",
      refreshPullRequestStacks: "Refresh pull request stacks",
      createStackPullRequest: "Create stack pull request",
      createPullRequestAbove: "Create a pull request above this PR",
      changeStackParent: "Change stack parent (base branch)",
      openPullRequest: "Open pull request on GitHub",
      retry: "Retry",
      draft: "draft",
      approved: "approved",
      changesRequested: "changes requested",
      reviewRequired: "review required",
      behind: "behind",
      blocked: "blocked",
      conflicts: "conflicts",
      checksPending: "checks pending",
      branchLabel: "Branch",
      baseLabel: "Base",
      authorLabel: "Author",
    },
    window.__gscI18n || {}
  );

  /** HTML 특수문자를 텍스트/속성에 안전하게 넣도록 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 버튼에 즉시 tooltip과 접근성 이름을 함께 넣는 공통 속성을 만든다. */
  function tooltip(label) {
    const value = esc(label);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  /** section header 오른쪽에 표시할 refresh/create 액션 HTML을 만든다. */
  function headerActions() {
    return (
      `<button class="header-action pr-stack-header-action codicon codicon-add" type="button" ` +
      `data-pr-stack-action="create" ${tooltip(T.createStackPullRequest)}></button>` +
      `<button class="header-action pr-stack-header-action codicon codicon-refresh" type="button" ` +
      `data-pr-stack-action="refresh" ${tooltip(T.refreshPullRequestStacks)}></button>`
    );
  }

  /** PR review/merge 상태를 짧은 배지 목록으로 정규화한다. */
  function statusLabels(pr) {
    const labels = [];
    if (pr.isDraft) {
      labels.push({ text: T.draft, tone: "muted" });
    } else if (pr.reviewDecision === "APPROVED") {
      labels.push({ text: T.approved, tone: "ok" });
    } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
      labels.push({ text: T.changesRequested, tone: "danger" });
    } else if (pr.reviewDecision === "REVIEW_REQUIRED") {
      labels.push({ text: T.reviewRequired, tone: "warn" });
    }
    if (pr.mergeStateStatus === "DIRTY") {
      labels.push({ text: T.conflicts, tone: "danger" });
    } else if (pr.mergeStateStatus === "BEHIND") {
      labels.push({ text: T.behind, tone: "warn" });
    } else if (pr.mergeStateStatus === "BLOCKED") {
      labels.push({ text: T.blocked, tone: "warn" });
    } else if (pr.mergeStateStatus === "UNSTABLE") {
      labels.push({ text: T.checksPending, tone: "warn" });
    }
    return labels;
  }

  /** 상태 배지 배열을 행 안의 HTML로 변환한다. */
  function statusHtml(pr) {
    return statusLabels(pr)
      .map((status) => `<span class="pr-stack-badge ${status.tone}">${esc(status.text)}</span>`)
      .join("");
  }

  /** fork PR은 owner:branch로, 같은 저장소 PR은 branch로 구분해 표시한다. */
  function headLabel(pr) {
    return pr.isCrossRepository && pr.headRepositoryOwner
      ? `${pr.headRepositoryOwner}:${pr.headRefName}`
      : pr.headRefName;
  }

  /** PR 행 hover에 표시할 branch/작성자/상태 설명을 만든다. */
  function rowTitle(pr) {
    return [
      `${T.openPullRequest}: #${pr.number} ${pr.title}`,
      `${T.branchLabel}: ${headLabel(pr)}`,
      `${T.baseLabel}: ${pr.baseRefName}`,
      pr.author ? `${T.authorLabel}: ${pr.author}` : undefined,
      ...statusLabels(pr).map((status) => status.text),
    ].filter(Boolean).join("\n");
  }

  /** PR 행 오른쪽의 base 변경/create child/browser 액션을 만든다. */
  function rowActions(pr) {
    return (
      `<span class="row-actions pr-stack-row-actions">` +
      `<button class="row-action pr-stack-action codicon codicon-git-branch" type="button" ` +
      `data-pr-stack-action="changeBase" ${tooltip(T.changeStackParent)}></button>` +
      `<button class="row-action pr-stack-action codicon codicon-add" type="button" ` +
      `data-pr-stack-action="createAbove" ${tooltip(T.createPullRequestAbove)}></button>` +
      `<button class="row-action pr-stack-action codicon codicon-link-external" type="button" ` +
      `data-pr-stack-action="open" ${tooltip(T.openPullRequest)}></button>` +
      `</span>`
    );
  }

  /** 중첩 깊이를 제한된 CSS class로 바꿔 인라인 style 없이 들여쓰기를 적용한다. */
  function depthClass(depth) {
    const safeDepth = Math.max(0, Math.min(8, Number(depth) || 0));
    return `depth-${safeDepth}`;
  }

  /** 스택 안의 Pull Request 한 건을 접근 가능한 버튼형 행으로 렌더링한다. */
  function rowHtml(pr, repoRoot) {
    const title = rowTitle(pr);
    return (
      `<div class="row pr-stack-row ${depthClass(pr.depth)}" role="button" tabindex="0" ` +
      `data-repo-root="${esc(repoRoot)}" data-pr-number="${esc(pr.number)}" ` +
      `data-pr-url="${esc(pr.url)}" data-base-branch="${esc(pr.baseRefName)}" ` +
      `${tooltip(title)}>` +
      `<span class="pr-stack-rail" aria-hidden="true"></span>` +
      `<span class="icon codicon ${pr.isDraft ? "codicon-git-pull-request-draft" : "codicon-git-pull-request"}"></span>` +
      `<span class="pr-stack-number">#${esc(pr.number)}</span>` +
      `<span class="name pr-stack-title">${esc(pr.title)}</span>` +
      `<span class="pr-stack-branches"><span>${esc(pr.baseRefName)}</span>` +
      `<span class="codicon codicon-arrow-right" aria-hidden="true"></span>` +
      `<strong>${esc(headLabel(pr))}</strong>` +
      statusHtml(pr) + `</span>` +
      rowActions(pr) +
      `</div>`
    );
  }

  /** 스택 root base와 하나 이상의 leaf branch를 요약하는 제목을 만든다. */
  function stackTitle(stack, leaves) {
    return `${stack.rootBaseRefName || "?"} → ${leaves || "?"}`;
  }

  /** stack entry에서 fork owner까지 포함한 leaf branch 라벨을 계산한다. */
  function stackLeafLabels(stack) {
    const entries = Array.isArray(stack.pullRequests) ? stack.pullRequests : [];
    const labels = entries
      .filter((pr) => !Array.isArray(pr.childNumbers) || !pr.childNumbers.length)
      .map(headLabel);
    return labels.length
      ? labels.join(", ")
      : (stack.leafHeadRefNames || []).join(", ");
  }

  /** 연결된 PR 묶음 한 개를 summary와 중첩 행 목록으로 렌더링한다. */
  function stackHtml(stack, repoRoot) {
    const pullRequests = Array.isArray(stack.pullRequests) ? stack.pullRequests : [];
    const leaves = stackLeafLabels(stack);
    const summary = stackTitle(stack, leaves);
    return (
      `<section class="pr-stack-group" aria-label="${esc(summary)}">` +
      `<div class="pr-stack-summary" title="${esc(summary)}">` +
      `<span class="codicon codicon-layers" aria-hidden="true"></span>` +
      `<span class="pr-stack-root">${esc(stack.rootBaseRefName || "?")}</span>` +
      `<span class="codicon codicon-arrow-right" aria-hidden="true"></span>` +
      `<span class="pr-stack-leaves">${esc(leaves)}</span>` +
      `<span class="count">${pullRequests.length}</span></div>` +
      `<div class="pr-stack-rows">${pullRequests.map((pr) => rowHtml(pr, repoRoot)).join("")}</div>` +
      `</section>`
    );
  }

  /** 오류 상태에서 진단 문구와 tooltip이 있는 재시도 버튼을 렌더링한다. */
  function errorHtml(message) {
    return (
      `<div class="pr-stack-message error"><span class="codicon codicon-error" aria-hidden="true"></span>` +
      `<span>${esc(message)}</span>` +
      `<button class="pr-stack-message-action" type="button" data-pr-stack-action="refresh" ` +
      `${tooltip(T.retry)}>${esc(T.retry)}</button></div>`
    );
  }

  /** 열린 PR이 없을 때 안내와 첫 PR 생성 버튼을 렌더링한다. */
  function emptyHtml() {
    return (
      `<div class="pr-stack-message"><span>${esc(T.noPullRequestStacks)}</span>` +
      `<button class="pr-stack-message-action" type="button" data-pr-stack-action="create" ` +
      `${tooltip(T.createStackPullRequest)}>${esc(T.createStackPullRequest)}</button></div>`
    );
  }

  /** provider의 idle/loading/error/ready 상태에 맞춰 PR Stacks 섹션 본문을 만든다. */
  function body(view) {
    const state = view || { status: "idle" };
    if (state.status === "loading" || state.status === "idle") {
      return (
        `<div class="pr-stack-message loading"><span class="codicon codicon-loading codicon-modifier-spin" ` +
        `aria-hidden="true"></span><span>${esc(T.loadingPullRequestStacks)}</span></div>`
      );
    }
    if (state.status === "error") {
      return errorHtml(state.error || "Pull request stack data is unavailable.");
    }
    const stacks = state.snapshot?.stacks || [];
    if (!stacks.length) {
      return emptyHtml();
    }
    return `<div class="pr-stack-list">${stacks.map((stack) => stackHtml(stack, state.repoRoot || "")).join("")}</div>`;
  }

  /** DOM PR 행의 data 속성을 extension host 메시지 필드로 변환한다. */
  function rowArg(row) {
    return {
      repoRoot: row?.dataset.repoRoot || undefined,
      number: row?.dataset.prNumber ? Number(row.dataset.prNumber) : undefined,
      url: row?.dataset.prUrl || undefined,
      baseBranch: row?.dataset.baseBranch || undefined,
    };
  }

  /** PR Stacks 섹션의 행/인라인/header 액션 이벤트를 extension host 메시지에 연결한다. */
  function bind(rootEl, vscode) {
    rootEl.querySelectorAll(".pr-stack-row").forEach((row) => {
      const open = () => vscode.postMessage(Object.assign({ type: "openStackPullRequest" }, rowArg(row)));
      row.addEventListener("click", (event) => {
        if (!event.target.closest(".pr-stack-action")) {
          open();
        }
      });
      row.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button")) {
          event.preventDefault();
          open();
        }
      });
    });
    rootEl.querySelectorAll("[data-pr-stack-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.prStackAction;
        const row = button.closest(".pr-stack-row");
        const arg = rowArg(row);
        if (action === "refresh") {
          vscode.postMessage({ type: "refreshPullRequestStacks" });
        } else if (action === "create" || action === "createAbove") {
          vscode.postMessage(Object.assign({ type: "createStackPullRequest" }, arg));
        } else if (action === "changeBase") {
          vscode.postMessage(Object.assign({ type: "changeStackPullRequestBase" }, arg));
        } else if (action === "open") {
          vscode.postMessage(Object.assign({ type: "openStackPullRequest" }, arg));
        }
      });
    });
  }

  window.__gscPullRequestStacks = { body, bind, headerActions };
})();
