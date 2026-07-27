// Review Center renderer: host가 전송한 실제 PR 스냅샷을 파일 탐색/대화 읽기 화면으로 바꾼다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const T = window.__gscReviewCenterI18n || {};
  const tabs = ["overview", "files", "commits", "checks", "activity"];
  const CHECKS_POLL_INTERVAL_MS = 10_000;
  let checksPollTimer;
  const state = Object.assign(
    {
      tab: "overview", loading: false, error: "", snapshot: null,
      activeFilePath: "",
      filesLoadingMore: false, threadsLoadingMore: false,
      filesPageError: "", threadsPageError: "", viewedPending: {}, filesViewedError: "",
      threadPending: {}, threadsUpdateError: "", managementKind: "addLabels", managementValues: "",
      managementPreview: null, managementPending: false, managementError: "", managementResult: "",
      draft: { reconcile: null, body: "", event: "COMMENT", pending: false, error: "", confirmDiscard: false, confirmSubmit: false },
      fileComment: { path: "", body: "", pending: false, error: "", success: "" },
      lineComment: { open: false, path: "", line: "", startLine: "", body: "", isSuggestion: false, suggestion: "", pending: false, error: "", success: "" },
      threadReply: { threadId: "", body: "", pending: false, error: "", success: "" },
      commentAction: { commentId: "", body: "", pending: false, confirmDelete: false, error: "", success: "" },
      suggestionApply: { threadId: "", commentId: "", pending: false, preview: null, error: "" },
      commits: { loading: false, error: "", data: null },
      checks: { loading: false, error: "", data: null },
      activity: { loading: false, error: "", data: null, kind: "all" }
    },
    vscode.getState() || {}
  );
  state.reviewWritesEnabled = window.__gscReviewWritesEnabled === true;

  /** 안전한 textContent만 사용해 화면 node를 만든다. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** tooltip과 접근성 이름을 빠뜨리지 않는 webview action button을 만든다. */
  function button(className, label, text, onClick) {
    const node = el("button", className, text);
    node.type = "button";
    node.title = label;
    node.dataset.tooltip = label;
    node.setAttribute("aria-label", label);
    node.addEventListener("click", onClick);
    return node;
  }

  const { title, decision, formatDate, formatNumber, template } = window.__gscReviewCenterFormat({ T });

  const draft = window.__gscReviewCenterDraft({ T, state, vscode, el, button, render });
  const fileComment = window.__gscReviewCenterFileComment({ T, state, vscode, el, button, render });
  const lineComment = window.__gscReviewCenterLineComment({ T, state, vscode, el, button, render });
  const threadReply = window.__gscReviewCenterThreadReply({ T, state, vscode, el, button, render });
  const commentActions = window.__gscReviewCenterCommentActions({ T, state, vscode, el, button, render });
  const suggestionApply = window.__gscReviewCenterSuggestionApply({ T, state, vscode, el, button, render });
  const commits = window.__gscReviewCenterCommits({ T, state, vscode, el, button, render, section });
  const checks = window.__gscReviewCenterChecks({ T, state, vscode, el, button, render, section });
  const activityTimeline = window.__gscReviewCenterActivity({ T, state, vscode, el, button, render, section });
  const management = window.__gscReviewCenterManagement({ T, state, vscode, el, button, template, formatNumber, render });
  const keyboard = window.__gscReviewCenterKeyboard({ state, tabs, selectTab, render, vscode });
  const files = window.__gscReviewCenterFiles({
    T, state, el, button, template, formatNumber, section, render,
    postMessage: (message) => {
      vscode.setState(state);
      vscode.postMessage(message);
    },
    fileComment, lineComment, renderPageControl
  });

  /** 현재 비동기 상태를 보존하고 header와 본문을 한번에 교체한다. */
  function render() {
    vscode.setState(state);
    root.replaceChildren(...(state.snapshot ? [renderSkipLink(), renderHeader()] : [renderHeader()]));
    if (state.loading && !state.snapshot) root.append(renderLoading());
    else if (state.error) root.append(renderError());
    else if (state.snapshot) root.append(renderPanel());
  }

  /** 키보드 사용자가 sticky header와 탭을 건너뛰고 현재 tabpanel로 이동할 링크를 만든다. */
  function renderSkipLink() {
    const link = el("a", "gsc-skip-link", T.skipToContent);
    link.href = "#review-center-panel";
    link.title = T.skipToContent;
    link.dataset.tooltip = T.skipToContent;
    link.setAttribute("aria-label", T.skipToContent);
    return link;
  }

  /** PR 정체성, refresh/browser action, 키보드 탭을 포함한 고정 header를 만든다. */
  function renderHeader() {
    const header = el("header", "review-center__header");
    const row = el("div", "review-center__title-row");
    const heading = el("h1", "review-center__title", state.snapshot ? state.snapshot.title : T.reviewCenter);
    if (state.snapshot) heading.prepend(document.createTextNode(`#${state.snapshot.number} `));
    row.append(heading);

    const actions = el("div", "review-center__meta");
    const refresh = button("gsc-icon-button", T.refresh, "↻", () => vscode.postMessage({ type: "refresh" }));
    refresh.disabled = state.loading;
    actions.append(refresh);
    if (state.snapshot) {
      actions.append(button("gsc-button gsc-button--ghost", T.openGitHubTitle, T.openGitHub, () => {
        vscode.postMessage({ type: "openGitHub" });
      }));
    }
    row.append(actions);
    header.append(row);

    if (state.snapshot) {
      const meta = el("div", "review-center__meta", `@${state.snapshot.author} · ${formatDate(state.snapshot.updatedAt)}`);
      if (state.snapshot.isDraft) meta.append(el("span", "gsc-status-pill", T.draft));
      if (state.snapshot.reviewDecision) {
        meta.append(el("span", "gsc-status-pill", template(T.reviewDecisionSummary, decision(state.snapshot.reviewDecision))));
      }
      if (state.snapshot.mergeStateStatus) {
        meta.append(el("span", "gsc-status-pill", template(T.mergeStateSummary, decision(state.snapshot.mergeStateStatus))));
      }
      header.append(meta);

      const branches = el("div", "review-center__branches");
      branches.append(
        el("span", "review-center__branch gsc-code", state.snapshot.baseRefName || T.baseUnavailable),
        el("span", "", "→"),
        el("span", "review-center__branch gsc-code", state.snapshot.headRefName || T.headUnavailable)
      );
      header.append(branches);
    }

    const tablist = el("div", "review-center__tablist");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", T.contentTabs);
    tabs.forEach((tab) => tablist.append(renderTab(tab)));
    header.append(tablist);
    return header;
  }

  /** roving tabindex 규칙을 지키는 탭 button 하나를 만든다. */
  function renderTab(id) {
    const label = title(id);
    const tab = button("review-center__tab", template(T.showTab, label), label, () => selectTab(id, true));
    tab.id = `review-center-tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(state.tab === id));
    tab.setAttribute("aria-controls", "review-center-panel");
    tab.tabIndex = state.tab === id ? 0 : -1;
    tab.addEventListener("keydown", (event) => handleTabKey(event, id));
    return tab;
  }

  /** 화살표·Home·End로 탭을 이동하고 브라우저 기본 스크롤을 막는다. */
  function handleTabKey(event, id) {
    const index = tabs.indexOf(id);
    let next;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  }

  /** 선택 탭을 저장한 뒤 다시 그려 focus가 탭에 남도록 한다. */
  function selectTab(tab, shouldFocus) {
    if (state.tab === tab) return;
    state.tab = tab;
    render();
    syncChecksPolling();
    if (shouldFocus) document.getElementById(`review-center-tab-${tab}`)?.focus();
    if (tab === "commits") commits.load();
    if (tab === "checks") checks.load();
    if (tab === "activity") activityTimeline.load();
  }

  /** Checks tab이 보이는 동안에만 10초 간격으로 최신 head의 check rollup을 다시 읽는다. */
  function syncChecksPolling() {
    if (checksPollTimer) {
      clearInterval(checksPollTimer);
      checksPollTimer = undefined;
    }
    if (state.tab !== "checks" || !state.snapshot || document.visibilityState === "hidden") return;
    checksPollTimer = setInterval(() => {
      if (!state.checks.loading) checks.load();
    }, CHECKS_POLL_INTERVAL_MS);
  }

  /** 첫 snapshot 요청 중 보여 줄 무의미하지 않은 skeleton 영역을 만든다. */
  function renderLoading() {
    const section = el("section", "review-center__loading");
    section.id = "review-center-panel";
    section.tabIndex = -1;
    section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", `review-center-tab-${state.tab}`);
    section.setAttribute("aria-label", T.loading);
    for (let index = 0; index < 7; index += 1) section.append(el("span", "gsc-skeleton gsc-skeleton--row"));
    return section;
  }

  /** host 오류와 재시도 action을 한 영역에 표시한다. */
  function renderError() {
    const panel = el("div", "review-center__error-panel");
    panel.id = "review-center-panel";
    panel.tabIndex = -1;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `review-center-tab-${state.tab}`);
    const section = el("section", "gsc-error-state review-center__error");
    section.setAttribute("role", "alert");
    section.append(
      el("span", "gsc-error-state__icon", "!"),
      el("h2", "gsc-error-state__title", T.unavailable),
      el("p", "gsc-error-state__body", state.error)
    );
    section.append(button("gsc-button", T.retryTitle, T.retry, () => vscode.postMessage({ type: "refresh" })));
    panel.append(section);
    return panel;
  }

  /** 선택 탭과 연결된 단일 tabpanel 본문을 만든다. */
  function renderPanel() {
    const content = el("div", "review-center__content");
    content.id = "review-center-panel";
    content.tabIndex = -1;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `review-center-tab-${state.tab}`);
    if (!state.reviewWritesEnabled) content.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.reviewWritesDisabled));
    if (state.tab === "overview") renderOverview(content);
    if (state.tab === "files") files.renderFiles(content);
    if (state.tab === "commits") commits.renderCommits(content);
    if (state.tab === "checks") checks.renderChecks(content);
    if (state.tab === "activity") renderActivity(content);
    return content;
  }

  /** description, review progress, 후속 page가 남은 상태를 두 개의 surface로 표시한다. */
  function renderOverview(content) {
    const summary = section(T.description);
    summary.append(el("div", "review-center__body", state.snapshot.body || T.noDescription));
    const status = section(T.reviewState);
    status.append(el("div", "review-center__body", template(
      T.changedFilesAndThreads,
      formatNumber(state.snapshot.files.length),
      formatNumber(state.snapshot.threads.length)
    )));
    if (state.snapshot.filesTruncated || state.snapshot.threadsTruncated) {
      status.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.additionalResultsAvailable));
    }
    const metadata = renderMetadata();
    metadata.classList.add("review-center__section--wide");
    content.append(summary, status);
    if (state.reviewWritesEnabled) content.append(draft.renderReviewDraft());
    content.append(metadata);
  }

  /** 현재 assignee/label과 관리 preview form을 Overview의 독립 표면으로 만든다. */
  function renderMetadata() {
    const sectionNode = section(T.metadata);
    const values = el("div", "review-center__metadata-values");
    values.append(
      renderMetadataValue(T.reviewers, state.snapshot.requestedReviewers.map((reviewer) => reviewer.kind === "team" ? `team:${reviewer.label}` : reviewer.label)),
      renderMetadataValue(T.assignees, state.snapshot.assignees),
      renderMetadataValue(T.labels, state.snapshot.labels),
      renderMetadataValue(T.milestone, state.snapshot.milestone ? [`#${state.snapshot.milestone.number} ${state.snapshot.milestone.title}`] : []),
      renderMetadataValue(T.draftStage, [state.snapshot.isDraft ? T.draft : T.readyForReview])
    );
    sectionNode.append(values);
    if (state.reviewWritesEnabled) sectionNode.append(management.renderManagementForm());
    return sectionNode;
  }

  /** metadata 종류 하나를 긴 값도 줄바꿈 가능한 compact definition 행으로 표시한다. */
  function renderMetadataValue(label, values) {
    const row = el("div", "review-center__metadata-row");
    row.append(el("span", "review-center__metadata-label", label));
    const value = el("div", "review-center__metadata-chips");
    if (!values.length) value.append(el("span", "review-center__metadata-empty", T.none));
    values.forEach((item) => {
      const chip = el("span", "gsc-status-pill", item);
      chip.title = item;
      chip.setAttribute("aria-label", item);
      value.append(chip);
    });
    row.append(value);
    return row;
  }

  /** 파일 thread와 댓글을 표시하며 위치가 있으면 해당 native diff로 진입시킨다. */
  function renderActivity(content) {
    activityTimeline.renderTimeline(content);
    const activity = section(template(T.reviewThreads, formatNumber(state.snapshot.threads.length)));
    const list = el("div", "review-center__threads");
    if (!state.snapshot.threads.length) list.append(el("div", "review-center__empty", T.noThreads));
    state.snapshot.threads.forEach((thread) => {
      const item = el("article", "review-center__thread");
      const actions = el("div", "review-center__thread-actions");
      actions.append(renderThreadLocation(thread));
      if (state.reviewWritesEnabled) {
        const pending = Boolean(state.threadPending[thread.id]);
        const toggle = button(
        "gsc-button gsc-button--ghost review-center__thread-toggle",
        thread.isResolved ? T.unresolveThread : T.resolveThread,
        pending ? T.resolvingThread : thread.isResolved ? T.resolved : T.resolveThread,
        () => toggleThreadResolved(thread)
      );
        toggle.disabled = pending;
        toggle.setAttribute("aria-busy", String(pending));
        toggle.setAttribute("aria-pressed", String(thread.isResolved));
        const reply = button("gsc-button gsc-button--ghost review-center__thread-reply-action", T.replyToThread, T.reply, () => threadReply.open(thread.id));
        reply.disabled = state.threadReply.pending;
        actions.append(toggle, reply);
      }
      item.append(actions);
      thread.comments.forEach((comment) => {
        const card = el("div", "review-center__comment");
        card.append(
          el("div", "review-center__comment-head", `@${comment.author} · ${formatDate(comment.createdAt)}`),
          el("div", "review-center__comment-body", comment.body || T.noCommentBody),
          ...(state.reviewWritesEnabled ? [
            commentActions.renderActions(comment), commentActions.renderComposer(comment),
            suggestionApply.renderActions(thread, comment), suggestionApply.renderPreview(comment)
          ] : [])
        );
        item.append(card);
      });
      if (state.reviewWritesEnabled) item.append(threadReply.renderComposer(thread.id));
      list.append(item);
    });
    activity.append(list);
    if (state.threadsUpdateError) activity.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", state.threadsUpdateError));
    activity.append(renderPageControl("threads"));
    content.classList.add("review-center__content--single");
    content.append(activity);
  }

  /** review thread를 즉시 resolved/unresolved로 보이고 host mutation을 요청한다. */
  function toggleThreadResolved(thread) {
    if (state.threadPending[thread.id]) return;
    state.snapshot.threads = state.snapshot.threads.map((item) => item.id === thread.id ? {
      ...item,
      isResolved: !thread.isResolved
    } : item);
    state.threadPending[thread.id] = true;
    state.threadsUpdateError = "";
    render();
    vscode.postMessage({ type: "toggleThreadResolved", threadId: thread.id, resolved: !thread.isResolved });
  }

  /** 남은 GraphQL page가 있을 때 해당 목록 아래의 loading/retry action을 만든다. */
  function renderPageControl(scope) {
    const hasNext = scope === "files" ? state.snapshot.filesTruncated : state.snapshot.threadsTruncated;
    const isLoading = scope === "files" ? state.filesLoadingMore : state.threadsLoadingMore;
    const pageError = scope === "files" ? state.filesPageError : state.threadsPageError;
    if (!hasNext && !pageError) return document.createDocumentFragment();
    const footer = el("div", "review-center__page-control");
    if (pageError) footer.append(el("div", "gsc-banner gsc-banner--warning", pageError));
    if (hasNext) {
      const label = scope === "files" ? T.loadMoreFiles : T.loadMoreThreads;
      const loadingLabel = scope === "files" ? T.loadingMoreFiles : T.loadingMoreThreads;
      const action = button("gsc-button", label, isLoading ? loadingLabel : label, () => loadMore(scope));
      action.disabled = isLoading;
      action.setAttribute("aria-busy", String(isLoading));
      footer.append(action);
    }
    return footer;
  }

  /** 클릭 직후의 disabled state를 반영하고 host에 다음 page 의도를 보낸다. */
  function loadMore(scope) {
    if (scope === "files") {
      if (state.filesLoadingMore) return;
      state.filesLoadingMore = true;
      state.filesPageError = "";
    } else {
      if (state.threadsLoadingMore) return;
      state.threadsLoadingMore = true;
      state.threadsPageError = "";
    }
    render();
    vscode.postMessage({ type: scope === "files" ? "loadMoreFiles" : "loadMoreThreads" });
  }

  /** thread 위치를 정적 문구 또는 바로 열 수 있는 button으로 만든다. */
  function renderThreadLocation(thread) {
    const location = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : T.locationUnavailable;
    const meta = thread.path && state.snapshot.canOpenNativeDiff !== false
      ? button("review-center__thread-location gsc-code", template(T.openFileDiff, thread.path), location, () => openNativeFile(thread.path))
      : el("div", "review-center__thread-meta", location);
    if (thread.isOutdated) meta.append(el("span", "gsc-status-pill gsc-status-pill--warning", T.outdated));
    if (thread.isResolved) meta.append(el("span", "gsc-status-pill gsc-status-pill--success", T.resolved));
    return meta;
  }

  /** 파일 또는 thread가 연 native diff의 path를 workspace 상태로 남기고 host에 open 의도를 보낸다. */
  function openNativeFile(path) {
    if (!path || state.snapshot?.canOpenNativeDiff === false) return;
    state.activeFilePath = path;
    vscode.setState(state);
    render();
    vscode.postMessage({ type: "openFile", path });
  }

  /** surface 제목과 본문을 갖는 semantic section을 만든다. */
  function section(label) {
    const node = el("section", "review-center__section");
    const header = el("header", "review-center__section-header");
    header.append(el("h2", "review-center__section-title", label));
    node.append(header);
    return node;
  }

  /** host lifecycle message를 로컬 상태로 반영하고 화면을 갱신한다. */
  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "loading") {
      state.loading = true;
      state.error = "";
    }
    if (message.type === "snapshot") {
      state.loading = false;
      state.error = "";
      state.filesLoadingMore = false;
      state.threadsLoadingMore = false;
      state.filesPageError = "";
      state.threadsPageError = "";
      state.viewedPending = {};
      state.filesViewedError = "";
      state.threadPending = {};
      state.threadsUpdateError = "";
      state.managementPreview = null;
      state.managementPending = false;
      state.managementError = "";
      state.managementResult = "";
      state.commits = { loading: false, error: "", data: null };
      state.checks = { loading: false, error: "", data: null };
      state.activity = { loading: false, error: "", data: null, kind: state.activity?.kind || "all" };
      state.snapshot = message.snapshot;
      if (!message.snapshot.files.some((file) => file.path === state.activeFilePath)) {
        state.activeFilePath = "";
      }
    }
    if (message.type === "pageLoaded") {
      state.snapshot = message.snapshot;
      if (message.scope === "files") {
        state.filesLoadingMore = false;
        state.filesPageError = "";
      } else {
        state.threadsLoadingMore = false;
        state.threadsPageError = "";
      }
    }
    if (message.type === "error") {
      state.loading = false;
      state.error = message.message || T.unknownError;
    }
    if (message.type === "pageError") {
      if (message.scope === "files") {
        state.filesLoadingMore = false;
        state.filesPageError = message.message || T.loadMoreFilesFailed;
      } else {
        state.threadsLoadingMore = false;
        state.threadsPageError = message.message || T.loadMoreThreadsFailed;
      }
    }
    if (message.type === "viewUpdate" || message.type === "viewError") {
      state.snapshot.files = state.snapshot.files.map((file) => file.path === message.path ? {
        ...file,
        isViewed: message.viewed
      } : file);
      delete state.viewedPending[message.path];
      state.filesViewedError = message.type === "viewError" ? message.message : "";
    }
    if (message.type === "threadUpdate" || message.type === "threadError") {
      state.snapshot.threads = state.snapshot.threads.map((thread) => thread.id === message.threadId ? {
        ...thread,
        isResolved: message.resolved
      } : thread);
      delete state.threadPending[message.threadId];
      state.threadsUpdateError = message.type === "threadError" ? message.message : "";
    }
    if (message.type === "managementPreview") {
      state.managementPending = false;
      state.managementError = "";
      state.managementPreview = message;
    }
    if (message.type === "managementResult") {
      state.snapshot = message.snapshot;
      state.managementPending = false;
      state.managementPreview = null;
      state.managementError = "";
      state.managementResult = message.verified
        ? T.metadataUpdated
        : template(T.metadataPartiallyUpdated, message.mismatches.join(", "));
    }
    if (message.type === "managementError") {
      state.managementPending = false;
      state.managementError = message.message;
    }
    if (message.type === "draftState") {
      state.draft.pending = false;
      state.draft.error = "";
      state.draft.confirmDiscard = false;
      state.draft.confirmSubmit = false;
      state.draft.reconcile = message.state;
      const recoveredBody = message.state.local?.body ?? message.state.server?.body;
      if (!state.draft.body && recoveredBody) state.draft.body = recoveredBody;
      if (message.state.local?.event) state.draft.event = message.state.local.event;
      if (message.state.kind === "none" && !message.state.local && !message.state.server) state.draft.body = "";
    }
    if (message.type === "draftError") {
      state.draft.pending = false;
      state.draft.error = message.message;
    }
    if (message.type === "fileCommentResult" || message.type === "fileCommentError") fileComment.applyResult(message);
    if (message.type === "lineCommentResult" || message.type === "lineCommentError") lineComment.applyResult(message);
    if (message.type === "threadReplyResult" || message.type === "threadReplyError") threadReply.applyResult(message);
    if (message.type === "commentMutationResult" || message.type === "commentMutationError") commentActions.applyResult(message);
    if (["suggestionPreview", "suggestionApplied", "suggestionApplyError"].includes(message.type)) suggestionApply.applyResult(message);
    if (message.type === "commitsLoaded") state.commits = { loading: false, error: "", data: message.commits };
    if (message.type === "commitsError") state.commits = { loading: false, error: message.message || T.commitsUnavailable, data: null };
    if (message.type === "checksLoaded") state.checks = { loading: false, error: "", data: message.checks };
    if (message.type === "checksError") state.checks = { loading: false, error: message.message || T.checksUnavailable, data: null };
    if (message.type === "activityLoaded") state.activity = { ...activityTimeline.state(), loading: false, error: "", data: message.activity };
    if (message.type === "activityError") state.activity = { ...activityTimeline.state(), loading: false, error: message.message || T.activityUnavailable, data: null };
    render();
    if (message.type === "snapshot" && state.tab === "checks") checks.load();
    if (message.type === "snapshot" && state.tab === "commits") commits.load();
    if (message.type === "snapshot" && state.tab === "activity") activityTimeline.load();
    if (message.type === "draftError") document.querySelector('textarea[name="review-draft-body"]')?.focus();
    syncChecksPolling();
  });

  render();
  keyboard.install();
  document.addEventListener("visibilitychange", syncChecksPolling);
  window.addEventListener("unload", () => {
    if (checksPollTimer) clearInterval(checksPollTimer);
  });
  vscode.postMessage({ type: "ready" });
}());
