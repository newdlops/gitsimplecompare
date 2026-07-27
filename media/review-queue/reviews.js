// Reviews 사이드바의 렌더러.
// - 상태는 extension host가 소유하고, 이 파일은 안전한 DOM API로 Personal/Management 탭을 그린다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const T = window.__gscReviewsI18n || {};
  const state = Object.assign({
    tab: "personal", snapshot: null, loading: false, error: "", failureKind: "error",
    cachedCounts: null,
    queueControls: { query: "", sort: "updated", status: "all" },
    savedQueues: { queues: [], activeId: "", error: "", name: "", query: "", editId: "", editName: "", editQuery: "", confirmDelete: false },
    queueWindows: {},
    managementScope: { kind: "repository", value: "", error: "" },
    bulk: { selected: {}, anchorKey: "", kind: "addLabels", values: "", preview: null, pending: false, error: "", result: "", cancellationWarning: "", verificationWarning: "", verificationDetails: [], retryableCount: 0 }
  }, vscode.getState() || {});
  state.reviewWritesEnabled = window.__gscReviewWritesEnabled === true;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(label, text, onClick) {
    const button = element("button", "gsc-icon-button", text);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.addEventListener("click", onClick);
    return button;
  }

  /** visible label과 tooltip/accessibility name을 함께 갖는 일반 action button을 만든다. */
  function actionButton(className, label, onClick) {
    const button = element("button", className, label);
    button.type = "button";
    button.title = label;
    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  }

  const queueWindow = window.__gscReviewsQueueWindow({ T, state, element, actionButton, render, template });
  const cachedSummary = window.__gscReviewsCachedSummary({ T, element, actionButton, template, formatRefreshTime });
  const queueControls = window.__gscReviewsQueueControls({ T, state, element, render, queueWindow });
  const queuePagination = window.__gscReviewsQueuePagination({ T, state, vscode, element, actionButton, render });
  const savedQueues = window.__gscReviewsSavedQueues({ T, state, vscode, element, iconButton, actionButton, render });
  const queueKeyboard = window.__gscReviewsQueueKeyboard({
    root,
    toggleManagementSelection: toggleBulkTarget,
    dismissManagementInteraction: dismissBulkKeyboardInteraction,
  });

  function render() {
    vscode.setState(state);
    root.replaceChildren();
    root.append(renderPrimaryNavigation());
    if (state.snapshot) root.append(renderSkipLink());
    root.appendChild(renderHeader());
    if (state.snapshot) {
      root.appendChild(renderContent());
      queueKeyboard.bind();
      return;
    }
    if (state.cachedCounts) {
      root.appendChild(cachedSummary.render(state.cachedCounts, () => vscode.postMessage({ type: "refresh" }), state.error));
      return;
    }
    if (state.loading) {
      root.appendChild(renderLoading());
      return;
    }
    if (state.error) {
      root.appendChild(renderError());
      return;
    }
  }

  /** Changes/Reviews contributed view를 전환하는 공통 sidebar navigation을 만든다. */
  function renderPrimaryNavigation() {
    return window.__gscSidebarShell.renderPrimaryNavigation({
      mode: "reviews",
      labels: {
        navigation: T.sidebarNavigation,
        changes: T.changes,
        reviews: T.reviews,
      },
      onSelect: (mode) => vscode.postMessage({ type: "selectSidebarMode", mode }),
    });
  }

  /** 키보드 사용자가 큐 header와 scope 탭을 건너뛰고 현재 큐 본문으로 이동할 링크를 만든다. */
  function renderSkipLink() {
    const link = element("a", "gsc-skip-link", T.skipToContent);
    link.href = "#reviews-tabpanel";
    link.title = T.skipToContent;
    link.dataset.tooltip = T.skipToContent;
    link.setAttribute("aria-label", T.skipToContent);
    return link;
  }

  function renderHeader() {
    const header = element("header", "reviews__header");
    const titleRow = element("div", "reviews__title-row");
    titleRow.append(element("h1", "reviews__title", T.title));
    const refresh = iconButton(T.refresh, "↻", () => vscode.postMessage({ type: "refresh" }));
    refresh.disabled = state.loading;
    refresh.setAttribute("aria-busy", String(state.loading));
    titleRow.append(refresh);
    header.append(titleRow);
    const identity = state.snapshot || state.cachedCounts;
    if (identity) {
      const meta = element("div", "reviews__meta");
      meta.append(element("span", "reviews__repo gsc-code", identity.repository));
      meta.append(element("span", "", `@${identity.viewer}`));
      header.append(meta);
    }
    const tabs = element("div", "reviews__tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", T.scopeTabs);
    tabs.append(renderTab("personal", T.personal), renderTab("management", T.management));
    header.append(tabs);
    return header;
  }

  function renderTab(id, label) {
    const tab = element("button", "reviews__tab", label);
    tab.type = "button";
    tab.id = `reviews-tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(state.tab === id));
    tab.setAttribute("aria-controls", "reviews-tabpanel");
    tab.tabIndex = state.tab === id ? 0 : -1;
    tab.title = template(T.showQueue, label);
    tab.dataset.tooltip = tab.title;
    tab.setAttribute("aria-label", tab.title);
    tab.addEventListener("click", () => selectTab(id, true));
    tab.addEventListener("keydown", (event) => handleTabKeydown(event, id));
    return tab;
  }

  /** 키보드 사용자가 두 동등한 queue 범위를 탭 순서 없이 바로 전환하게 한다. */
  function handleTabKeydown(event, current) {
    const tabOrder = ["personal", "management"];
    const index = tabOrder.indexOf(current);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabOrder[(index + 1) % tabOrder.length];
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabOrder[(index + tabOrder.length - 1) % tabOrder.length];
    if (event.key === "Home") next = tabOrder[0];
    if (event.key === "End") next = tabOrder[tabOrder.length - 1];
    if (next) {
      event.preventDefault();
      selectTab(next, true);
    }
  }

  /** 선택 상태를 보존하고 재렌더 뒤 현재 tab으로 포커스를 되돌린다. */
  function selectTab(tab, focus) {
    if (state.tab === tab) return;
    state.tab = tab;
    render();
    if (focus) document.getElementById(`reviews-tab-${tab}`)?.focus();
  }

  function renderLoading() {
    const loading = element("section", "reviews__loading");
    loading.id = "reviews-tabpanel";
    loading.tabIndex = -1;
    loading.setAttribute("role", "tabpanel");
    loading.setAttribute("aria-labelledby", `reviews-tab-${state.tab}`);
    loading.setAttribute("aria-label", T.loading);
    for (let index = 0; index < 5; index++) loading.append(element("span", "gsc-skeleton gsc-skeleton--row"));
    return loading;
  }

  function renderError() {
    const panel = element("div", "reviews__error-panel");
    panel.id = "reviews-tabpanel";
    panel.tabIndex = -1;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `reviews-tab-${state.tab}`);
    const error = element("section", "gsc-error-state reviews__error");
    error.setAttribute("role", "alert");
    error.append(element("span", "gsc-error-state__icon", "!"));
    error.append(element("h2", "gsc-error-state__title", failureTitle()));
    error.append(element("p", "gsc-error-state__body", state.error));
    const retry = element("button", "gsc-button", T.retry);
    retry.type = "button";
    retry.title = T.retryTitle;
    retry.dataset.tooltip = retry.title;
    retry.setAttribute("aria-label", retry.title);
    retry.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    error.append(retry);
    if (state.failureKind === "authRequired") {
      const signIn = actionButton("gsc-button gsc-button--ghost", T.signInWithGh, () => vscode.postMessage({ type: "startGitHubAuth" }));
      signIn.title = T.signInWithGhTitle;
      signIn.dataset.tooltip = signIn.title;
      signIn.setAttribute("aria-label", signIn.title);
      error.append(signIn);
    }
    const output = actionButton("gsc-button gsc-button--ghost", T.openOutput, () => vscode.postMessage({ type: "showOutputLog" }));
    output.title = T.openOutputTitle;
    output.dataset.tooltip = output.title;
    output.setAttribute("aria-label", output.title);
    error.append(output);
    panel.append(error);
    return panel;
  }

  /** typed host failure를 raw diagnostic 없이 shell heading으로 바꾼다. */
  function failureTitle() {
    if (state.failureKind === "authRequired") return T.authenticationRequired;
    if (state.failureKind === "permissionDenied") return T.permissionRequired;
    if (state.failureKind === "offline") return T.connectionUnavailable;
    if (state.failureKind === "rateLimited") return T.rateLimited;
    return T.unavailable;
  }

  function renderContent() {
    const content = element("div", "reviews__content");
    content.id = "reviews-tabpanel";
    content.tabIndex = -1;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `reviews-tab-${state.tab}`);
    content.append(queueControls.renderControls());
    if (state.tab === "personal") {
      content.append(renderLane(T.requestedForYou, queueControls.items(state.snapshot.personal.requested), T.noRequested, false, "personal.requested", laneUnavailable("personal.requested"), laneTruncated("personal.requested"), laneCapped("personal.requested")));
      content.append(renderLane(T.authoredByYou, queueControls.items(state.snapshot.personal.authored), T.noAuthored, false, "personal.authored", laneUnavailable("personal.authored"), laneTruncated("personal.authored"), laneCapped("personal.authored")));
      content.append(renderLane(T.assignedToYou, queueControls.items(state.snapshot.personal.assigned), T.noAssigned, false, "personal.assigned", laneUnavailable("personal.assigned"), laneTruncated("personal.assigned"), laneCapped("personal.assigned")));
      content.append(renderLane(T.mentioned, queueControls.items(state.snapshot.personal.mentioned), T.noMentioned, false, "personal.mentioned", laneUnavailable("personal.mentioned"), laneTruncated("personal.mentioned"), laneCapped("personal.mentioned")));
      content.append(renderLane(T.participated, queueControls.items(state.snapshot.personal.participated), T.noParticipated, false, "personal.participated", laneUnavailable("personal.participated"), laneTruncated("personal.participated"), laneCapped("personal.participated")));
      content.append(renderQueueStatus(Object.values(state.snapshot.personal).flatMap((lane) => queueControls.items(lane))));
    } else {
      content.append(savedQueues.renderSavedQueues());
      content.append(renderBulkManagement());
      content.append(renderLane(T.repositoryManagement, queueControls.items(state.snapshot.management.open), T.noManagement, true, "management.open", laneUnavailable("management.open"), laneTruncated("management.open"), laneCapped("management.open")));
      content.append(renderQueueStatus(queueControls.items(state.snapshot.management.open)));
    }
    return content;
  }

  /** 현재 tab의 filter를 통과해 실제로 읽힌 결과 수와 snapshot 갱신 시각을 footer status로 표시한다. */
  function renderQueueStatus(pullRequests) {
    const status = element("div", "reviews__queue-status");
    status.setAttribute("role", "status");
    const unique = new Set(pullRequests.map((pullRequest) => `${pullRequest.repository || state.snapshot.repository}#${pullRequest.number}`));
    status.textContent = template(T.queueLoadedStatus, unique.size, formatRefreshTime(state.snapshot.refreshedAt));
    return status;
  }

  /** 선택한 Management PR에만 metadata mutation을 preview하고 확인 뒤 실행하는 bulk surface를 만든다. */
  function renderBulkManagement() {
    if (!state.reviewWritesEnabled) {
      return element("div", "gsc-banner gsc-banner--warning", T.reviewWritesDisabled);
    }
    const bulk = state.bulk;
    const section = element("section", "reviews__bulk");
    const heading = element("div", "reviews__lane-header");
    const selected = selectedBulkKeys();
    heading.append(element("h2", "reviews__lane-title", T.bulkManagement), element("span", "reviews__count", template(T.selectedPullRequestsAcrossRepositories, selected.length, selectedBulkRepositoryCount(selected))));
    const selectionActions = element("div", "reviews__saved-actions");
    const selectAll = iconButton(T.selectAllPullRequests, "✓", selectAllBulkTargets);
    selectAll.disabled = bulk.pending || selected.length === state.snapshot.management.open.length;
    const clear = iconButton(T.clearPullRequestSelection, "×", clearBulkTargets);
    clear.disabled = bulk.pending || !selected.length;
    selectionActions.append(selectAll, clear);
    heading.append(selectionActions);
    section.append(heading, element("p", "reviews__saved-note", T.bulkManagementHint));
    if (bulk.error) {
      const error = element("div", "gsc-banner gsc-banner--warning", bulk.error);
      error.setAttribute("role", "alert");
      section.append(error);
    }
    if (bulk.result) {
      const result = element("div", "gsc-banner gsc-banner--success", bulk.result);
      result.setAttribute("role", "status");
      section.append(result);
      if (bulk.verificationWarning) {
        const warning = element("div", "gsc-banner gsc-banner--warning", bulk.verificationWarning);
        warning.setAttribute("role", "alert");
        section.append(warning);
        if (bulk.verificationDetails.length) {
          const details = element("ul", "reviews__bulk-verification-details");
          bulk.verificationDetails.forEach((detail) => details.append(element("li", "", template(T.bulkResultVerificationDetails, detail))));
          section.append(details);
        }
      }
      if (bulk.cancellationWarning) {
        const warning = element("div", "gsc-banner gsc-banner--warning", bulk.cancellationWarning);
        warning.setAttribute("role", "status");
        section.append(warning);
      }
      if (bulk.retryableCount) {
        const retry = actionButton("gsc-button gsc-button--ghost", template(T.retryFailedBulkChanges, bulk.retryableCount), retryFailedBulkManagement);
        retry.disabled = bulk.pending;
        retry.setAttribute("aria-busy", String(bulk.pending));
        section.append(retry);
      }
    }
    const form = element("form", "reviews__bulk-form");
    form.addEventListener("submit", (event) => { event.preventDefault(); previewBulkManagement(); });
    const operation = element("label", "gsc-field");
    operation.append(element("span", "gsc-field__label", T.bulkOperation));
    const select = element("select", "gsc-select");
    select.name = "bulk-management-operation";
    [
      ["addAssignees", T.addAssignees], ["removeAssignees", T.removeAssignees],
      ["addLabels", T.addLabels], ["removeLabels", T.removeLabels],
      ["requestReviewers", T.requestReviewers], ["removeReviewers", T.removeReviewers],
      ["setMilestone", T.setMilestone], ["clearMilestone", T.clearMilestone]
    ].forEach(([value, label]) => {
      const option = element("option", "", label);
      option.value = value;
      select.append(option);
    });
    select.value = bulk.kind;
    select.disabled = bulk.pending;
    select.addEventListener("change", () => { bulk.kind = select.value; bulk.error = ""; bulk.preview = null; vscode.setState(state); render(); });
    operation.append(select);
    form.append(operation);
    if (bulk.kind !== "clearMilestone") {
      const values = element("label", "gsc-field");
      values.append(element("span", "gsc-field__label", bulk.kind === "setMilestone" ? T.milestoneNumber : T.bulkValues));
      const input = element("input", "gsc-input");
      input.name = "bulk-management-values";
      input.autocomplete = "off";
      input.value = bulk.values;
      input.placeholder = bulk.kind === "setMilestone" ? T.milestoneNumber : T.bulkValuesHint;
      input.disabled = bulk.pending;
      input.addEventListener("input", () => { bulk.values = input.value; bulk.error = ""; bulk.preview = null; vscode.setState(state); });
      values.append(input);
      form.append(values);
    }
    const preview = actionButton("gsc-button", bulk.pending ? T.previewingBulkChanges : T.previewBulkChanges, previewBulkManagement);
    preview.disabled = bulk.pending || !selectedBulkKeys().length || (bulk.kind !== "clearMilestone" && !bulk.values.trim());
    preview.setAttribute("aria-busy", String(bulk.pending));
    form.append(preview);
    section.append(form);
    if (bulk.preview) section.append(renderBulkPreview());
    return section;
  }

  /** preview의 per-PR apply/skip 근거를 보여 주고 실제 write는 별도 확인으로 분리한다. */
  function renderBulkPreview() {
    const bulk = state.bulk;
    const preview = bulk.preview.preview;
    const surface = element("div", "reviews__bulk-preview");
    surface.setAttribute("role", "region");
    surface.setAttribute("aria-label", T.bulkPreview);
    surface.append(element("div", "reviews__saved-confirm", template(T.bulkPreviewSummary, preview.eligibleCount, preview.skippedCount)));
    const unavailableCount = preview.items.filter((item) => Boolean(item.error)).length;
    const alreadyUpToDateCount = preview.items.filter((item) => item.preview && !item.preview.canApply).length;
    const counts = element("dl", "reviews__bulk-preview-counts");
    [[T.bulkPreviewWillChange, preview.eligibleCount], [T.bulkPreviewAlreadyUpToDate, alreadyUpToDateCount], [T.bulkPreviewUnavailable, unavailableCount]].forEach(([label, count]) => {
      const item = element("div", "reviews__bulk-preview-count");
      item.append(element("dt", "", label), element("dd", "", String(count)));
      counts.append(item);
    });
    surface.append(counts);
    const items = element("ul", "reviews__bulk-preview-items");
    preview.items.forEach((item) => {
      const label = `${item.target.repository}#${item.target.number}`;
      const detail = item.preview?.canApply ? item.preview.willApply.join(", ") : item.error || item.preview?.alreadySet.join(", ") || T.noManagementChanges;
      items.append(element("li", "reviews__bulk-preview-line", `${label} · ${detail}`));
    });
    surface.append(items);
    const actions = element("div", "reviews__saved-actions");
    const apply = actionButton("gsc-button gsc-button--primary", template(T.applyBulkChanges, preview.eligibleCount), () => applyBulkManagement(bulk.preview.previewId));
    apply.disabled = bulk.pending || !preview.eligibleCount;
    const cancelLabel = bulk.pending ? T.cancelRemainingBulkChanges : T.cancelBulkChanges;
    const cancel = actionButton("gsc-button gsc-button--ghost", cancelLabel, () => cancelBulkManagement(bulk.preview.previewId));
    actions.append(apply, cancel);
    surface.append(actions);
    return surface;
  }

  /** 현재 filter를 통과한 loaded row 안에서 단일 또는 Shift 범위 선택 상태를 바꾼다. */
  function toggleBulkTarget(key, checked, range) {
    const bulk = state.bulk;
    const rows = queueControls.items(state.snapshot.management.open);
    const currentIndex = rows.findIndex((pullRequest) => bulkKey(pullRequest) === key);
    const anchorIndex = range ? rows.findIndex((pullRequest) => bulkKey(pullRequest) === bulk.anchorKey) : -1;
    if (currentIndex >= 0 && anchorIndex >= 0) {
      rows.slice(Math.min(currentIndex, anchorIndex), Math.max(currentIndex, anchorIndex) + 1).forEach((pullRequest) => {
        const rowKey = bulkKey(pullRequest);
        if (checked) bulk.selected[rowKey] = true;
        else delete bulk.selected[rowKey];
      });
    } else if (checked) {
      bulk.selected[key] = true;
    } else {
      delete bulk.selected[key];
    }
    bulk.anchorKey = key;
    state.bulk.error = "";
    state.bulk.preview = null;
    vscode.setState(state);
    render();
  }

  /** 선택 key가 현 Management snapshot에도 남아 있는지 확인해 stale selection을 제거한다. */
  function selectedBulkKeys() {
    const available = new Set(state.snapshot.management.open.map((pullRequest) => bulkKey(pullRequest)));
    Object.keys(state.bulk.selected).forEach((key) => { if (!available.has(key)) delete state.bulk.selected[key]; });
    if (!available.has(state.bulk.anchorKey)) state.bulk.anchorKey = "";
    return Object.keys(state.bulk.selected).filter((key) => state.bulk.selected[key]);
  }

  /** 선택한 PR이 team scope의 몇 개 repository에 걸쳐 있는지 toolbar용으로 계산한다. */
  function selectedBulkRepositoryCount(keys) {
    return new Set(keys.map((key) => key.slice(0, key.lastIndexOf("#")))).size;
  }

  /** 현재 filter를 통과해 로드된 Management row만 선택하고 새 preview를 요구한다. */
  function selectAllBulkTargets() {
    if (state.bulk.pending) return;
    queueControls.items(state.snapshot.management.open).forEach((pullRequest) => { state.bulk.selected[bulkKey(pullRequest)] = true; });
    state.bulk.anchorKey = "";
    state.bulk.error = "";
    state.bulk.preview = null;
    vscode.setState(state);
    render();
  }

  /** 선택 상태와 미확정 preview만 지워 작업을 안전하게 처음부터 다시 고르게 한다. */
  function clearBulkTargets() {
    if (state.bulk.pending) return;
    state.bulk.selected = {};
    state.bulk.anchorKey = "";
    state.bulk.error = "";
    state.bulk.preview = null;
    vscode.setState(state);
    render();
  }

  /** Escape가 preview confirmation과 현재 Management selection을 안쪽부터 닫게 한다. */
  function dismissBulkKeyboardInteraction() {
    const bulk = state.bulk;
    if (bulk.pending) return false;
    if (bulk.preview) {
      cancelBulkManagement(bulk.preview.previewId);
      return true;
    }
    if (!selectedBulkKeys().length) return false;
    clearBulkTargets();
    return true;
  }

  /** team scope의 cross-repository PR도 충돌 없이 구분하는 selection key를 만든다. */
  function bulkKey(pullRequest) {
    return `${pullRequest.repository || state.snapshot.repository}#${pullRequest.number}`;
  }

  /** comma 입력을 transport-safe array로 만들고, 실제 server read를 거친 preview를 요청한다. */
  function previewBulkManagement() {
    const bulk = state.bulk;
    const keys = selectedBulkKeys();
    if (bulk.pending || !keys.length || (bulk.kind !== "clearMilestone" && !bulk.values.trim())) return;
    bulk.pending = true;
    bulk.error = "";
    bulk.result = "";
    bulk.cancellationWarning = "";
    bulk.verificationWarning = "";
    bulk.verificationDetails = [];
    bulk.retryableCount = 0;
    bulk.preview = null;
    render();
    vscode.postMessage({ type: "previewBulkManagement", keys, kind: bulk.kind, values: bulk.values.split(",").map((value) => value.trim()).filter(Boolean) });
  }

  /** preview id가 일치할 때만 bulk write를 요청해 오래된 confirmation을 막는다. */
  function applyBulkManagement(previewId) {
    if (state.bulk.pending || state.bulk.preview?.previewId !== previewId) return;
    state.bulk.pending = true;
    state.bulk.error = "";
    render();
    vscode.postMessage({ type: "applyBulkManagement", previewId });
  }

  /** preview는 즉시 닫고, 실행 중이면 host가 아직 시작하지 않은 write만 취소하게 한다. */
  function cancelBulkManagement(previewId) {
    if (state.bulk.preview?.previewId !== previewId) return;
    if (!state.bulk.pending) state.bulk.preview = null;
    render();
    vscode.postMessage({ type: "cancelBulkManagement", previewId });
  }

  /** 실패했던 PR만 최신 metadata를 다시 읽는 preview로 복구해 성공 항목을 재실행하지 않는다. */
  function retryFailedBulkManagement() {
    const bulk = state.bulk;
    if (bulk.pending || !bulk.retryableCount) return;
    bulk.pending = true;
    bulk.error = "";
    bulk.result = "";
    bulk.cancellationWarning = "";
    bulk.verificationWarning = "";
    bulk.verificationDetails = [];
    bulk.retryableCount = 0;
    render();
    vscode.postMessage({ type: "retryFailedBulkManagement" });
  }

  function renderLane(title, pullRequests, emptyMessage, management, lane, unavailable, truncated, capped) {
    const section = element("section", "reviews__lane");
    const heading = element("div", "reviews__lane-header");
    heading.append(element("h2", "reviews__lane-title", title), element("span", "reviews__count", String(pullRequests.length)));
    section.append(heading);
    if (unavailable) section.append(element("div", "gsc-banner gsc-banner--warning", T.queueLaneUnavailable));
    if (truncated) section.append(element("div", "gsc-banner gsc-banner--warning", T.queueLaneTruncated));
    if (capped) section.append(element("div", "gsc-banner gsc-banner--warning", T.queueLaneCapped));
    if (!pullRequests.length) {
      section.append(element("div", "reviews__empty", emptyMessage));
      section.append(queuePagination.renderControl(lane));
      return section;
    }
    const list = element("div", "reviews__list");
    list.setAttribute("role", "list");
    queueWindow.visible(lane, pullRequests).forEach((pullRequest) => list.append(renderPullRequest(pullRequest, management)));
    section.append(list);
    section.append(queueWindow.renderControl(lane, pullRequests.length));
    section.append(queuePagination.renderControl(lane));
    return section;
  }

  /** host가 partial snapshot으로 표시한 lane만 empty와 구분되는 unavailable banner를 받는다. */
  function laneUnavailable(lane) {
    return Boolean(state.snapshot.unavailableLanes?.includes(lane));
  }

  /** 첫 GitHub search page 뒤 결과가 남은 lane은 completeness를 추정하지 않는 banner를 받는다. */
  function laneTruncated(lane) {
    return Boolean(state.snapshot.truncatedLanes?.includes(lane));
  }

  /** 1,000개 UI 결과 상한에 도달한 lane은 별도 cap 상태를 표시한다. */
  function laneCapped(lane) {
    return Boolean(state.snapshot.cappedLanes?.includes(lane));
  }

  function renderPullRequest(pullRequest, management) {
    const item = element("div", "");
    item.setAttribute("role", "listitem");
    if (management && state.reviewWritesEnabled) {
      item.classList.add("reviews__management-pr");
      const key = bulkKey(pullRequest);
      const select = element("input", "reviews__bulk-select");
      select.type = "checkbox";
      select.checked = Boolean(state.bulk.selected[key]);
      select.title = template(T.selectPullRequest, pullRequest.number);
      select.dataset.tooltip = select.title;
      select.setAttribute("aria-label", `${template(T.selectPullRequest, pullRequest.number)}: ${pullRequest.title}`);
      select.addEventListener("click", (event) => toggleBulkTarget(key, select.checked, Boolean(event.shiftKey)));
      item.append(select);
    }
    const button = element("button", "reviews__pr");
    button.type = "button";
    button.dataset.reviewKey = bulkKey(pullRequest);
    button.dataset.reviewManagement = String(management);
    button.dataset.reviewSelected = String(management && Boolean(state.bulk.selected[bulkKey(pullRequest)]));
    button.title = template(T.openReviewCenter, pullRequest.number);
    button.dataset.tooltip = button.title;
    button.setAttribute("aria-label", `${template(T.openReviewCenter, pullRequest.number)}: ${pullRequest.title}`);
    button.addEventListener("click", () => vscode.postMessage({
      type: "openReviewCenter",
      number: pullRequest.number,
      ...(management && pullRequest.repository && pullRequest.repository !== state.snapshot.repository ? { repository: pullRequest.repository } : {})
    }));
    const topline = element("div", "reviews__pr-topline");
    topline.append(element("span", "reviews__pr-number gsc-code", `#${pullRequest.number}`));
    if (pullRequest.isDraft) topline.append(element("span", "gsc-status-pill", T.draft));
    button.append(topline, element("span", "reviews__pr-title", pullRequest.title));
    const footer = element("div", "reviews__pr-footer");
    footer.append(element("span", "reviews__pr-meta", `@${pullRequest.author}`));
    if (management && pullRequest.repository && pullRequest.repository !== state.snapshot.repository) footer.append(element("span", "reviews__pr-meta gsc-code", pullRequest.repository));
    if (pullRequest.updatedAt) footer.append(element("span", "reviews__pr-meta", formatUpdatedAt(pullRequest.updatedAt)));
    if (pullRequest.reviewDecision) footer.append(element("span", "gsc-status-pill", reviewDecisionLabel(pullRequest.reviewDecision)));
    if (pullRequest.mergeStateStatus) footer.append(element("span", "gsc-status-pill", template(T.mergeState, reviewDecisionLabel(pullRequest.mergeStateStatus))));
    if (pullRequest.requestedReviewers.length) footer.append(element("span", "reviews__reviewers", template(T.reviewRequests, pullRequest.requestedReviewers.join(", "))));
    if (management && pullRequest.assignees.length) footer.append(element("span", "reviews__assignees", template(T.assigned, pullRequest.assignees.join(", "))));
    if (management && pullRequest.labels.length) footer.append(element("span", "reviews__labels", template(T.labels, pullRequest.labels.join(", "))));
    button.append(footer);
    item.append(button);
    return item;
  }

  function reviewDecisionLabel(value) {
    return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  /** ISO 갱신 시각을 locale에 맞는 짧은 절대 날짜로 만들고 손상 값은 숨긴다. */
  function formatUpdatedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return template(T.updated, new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date));
  }

  /** snapshot의 ISO 갱신 시각을 locale에 맞는 compact date/time으로 바꾸고 손상 값은 숨긴다. */
  function formatRefreshTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }

  /** host l10n이 전달한 {0} 형태의 간단한 template을 실제 값으로 치환한다. */
  function template(value, ...values) {
    return String(value || "").replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
  }

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "loading") { state.loading = true; state.error = ""; state.failureKind = "error"; }
    if (message.type === "cachedCounts") { state.cachedCounts = message; }
    if (message.type === "snapshot") { state.loading = false; state.error = ""; state.failureKind = "error"; state.cachedCounts = null; state.snapshot = message.snapshot; }
    if (message.type === "queuePageLoaded" || message.type === "queuePageError") queuePagination.applyResult(message);
    if (message.type === "savedQueues") {
      state.savedQueues.queues = message.queues || [];
      state.savedQueues.activeId = message.activeId || "";
      state.savedQueues.error = "";
      state.savedQueues.confirmDelete = false;
      const active = state.savedQueues.queues.find((queue) => queue.id === state.savedQueues.activeId);
      if (state.savedQueues.editId !== active?.id) savedQueues.setActiveDraft(active);
      if (message.activeId) { state.savedQueues.name = ""; state.savedQueues.query = ""; }
    }
    if (message.type === "savedQueueError") state.savedQueues.error = message.message || T.unavailable;
    if (message.type === "managementScope") {
      state.managementScope.kind = message.kind || "repository";
      state.managementScope.value = message.value || "";
    }
    if (message.type === "bulkManagementPreview") { state.bulk.pending = false; state.bulk.error = ""; state.bulk.preview = message; }
    if (message.type === "bulkManagementResult") {
      state.bulk.pending = false;
      state.bulk.preview = null;
      state.bulk.error = "";
      state.bulk.result = template(T.bulkResultSummary, message.summary.appliedCount, message.summary.skippedCount, message.summary.failedCount);
      state.bulk.cancellationWarning = message.summary.cancelledCount
        ? template(T.bulkResultCancellationWarning, message.summary.cancelledCount)
        : "";
      state.bulk.verificationWarning = message.summary.partiallyVerifiedCount
        ? template(T.bulkResultVerificationWarning, message.summary.partiallyVerifiedCount)
        : "";
      state.bulk.verificationDetails = message.summary.items
        .filter((item) => item.status === "applied" && item.result?.verified === false)
        .map((item) => `${item.target.repository}#${item.target.number} · ${(item.result?.mismatches || []).join(", ")}`);
      state.bulk.retryableCount = Number(message.retryableCount) || 0;
    }
    if (message.type === "bulkManagementError") { state.bulk.pending = false; state.bulk.error = message.message || T.unavailable; }
    if (message.type === "error") { state.loading = false; state.failureKind = message.kind || "error"; state.error = message.message || T.unavailable; }
    render();
  });

  render();
  vscode.postMessage({ type: "ready" });
}());
