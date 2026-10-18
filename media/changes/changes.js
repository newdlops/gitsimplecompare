// CHANGES 사이드바 웹뷰 클라이언트 — VS Code Explorer/Source Control 스타일 아코디언.
//   Repositories · Changes · History · Compare Branches · Stashes · Worktrees.
// - 섹션 접힘/크기는 vscode.getState/setState 로 보존, 폴더 접힘은 일시적.
// - 미트볼(...) 메뉴는 window.__gscMenu(provider 가 주입한 트리)로 드릴다운 드롭다운을 그린다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  window.__gscVscode = vscode;
  const rootEl = document.getElementById("root");
  const SCM_MENU = window.__gscMenu || [];
  const COMMIT_MENU = window.__gscCommitMenu || [];

  const T = Object.assign(
    {
      repositories: "Repositories",
      repositoryContext: "Repository context",
      workingChanges: "Working Changes",
      tools: "Tools",
      resizeRegions: "Resize {0} and {1}",
      compareBranches: "Compare Branches",
      changes: "Changes",
      current: "current",
      from: "From:",
      to: "To:",
      selectBranch: "(select a branch)",
      compare: "Compare",
      toggleSection: "Toggle section",
      collapseSection: "Collapse {0}",
      expandSection: "Expand {0}",
      noCompare: "No changes between the selected branches.",
      noChanges: "No working tree changes.",
      conflicts: "Conflicts",
      noRepos: "No git repository found.",
      change: "Change branch",
      viewAsTree: "View as Tree",
      viewAsList: "View as List",
      stagedChanges: "Staged Changes",
      commitPlaceholder: "Message (Ctrl+Enter to commit)",
      commit: "Commit",
      splitChanges: "Stage Hunks",
      moreActions: "More Actions...",
      stage: "Stage Changes",
      unstage: "Unstage Changes",
      discard: "Discard Changes",
      stageAll: "Stage All Changes",
      unstageAll: "Unstage All Changes",
      discardAll: "Discard All Changes",
      openFile: "Open File",
      openChanges: "Open Changes",
      addToGitignore: "Add to .gitignore",
      addToExclude: "Add to .git/info/exclude",
      history: "History",
      noHistoryFile: "No file is currently open.",
      noHistory: "No commits for the current file.",
      loadingHistory: "Loading file history...",
      loadingEarlierHistory: "Loading earlier commits...",
      openHistoryCommit: "Open File Change",
      stashes: "Stashes",
      stashSelected: "Stash Selected Changes",
      worktrees: "Worktrees",
    },
    window.__gscCompare?.defaults || {},
    window.__gscI18n || {}
  );

  // 화면 상태 보존과 section layout은 하나의 모듈이 소유한다.
  const { state, isCollapsed, disclosureTooltip, syncDisclosureControl, toggleSection,
    normalizeVisibleSections, orderedSections, captureTransientUi, restoreTransientUi,
    applyCollapse, applyResize, bindSectionDrag, consumeHeaderClick } = window.__gscChangesViewState({
      rootEl, vscode, strings: T, getLastPayload: () => lastPayload,
      closeDropdown: () => closeDropdown(),
      scheduleLists: () => { workingList.scheduleRender(); compareList.scheduleRender(); },
    });
  let lastPayload = null;
  let worktreesRequested = false;
  // 화면 HTML과 파일 아이콘 표현은 전용 모듈이 담당한다.
  const presentation = window.__gscChangesPresentation({ rootEl, state, strings: T, isCollapsed, disclosureTooltip, getWorkingList: () => workingList });
  const { esc, statusCodicon, fileIconHtml, loadFileIconFonts, applyFileIconGlyphStyles, statHtml, countFiles, countConflicts, conflictBadgeHtml, section, reposBody, rowActionsHtml, sectionActions, changesBody } = presentation;

  /** webview → 확장 메시지 전송 단축 함수. */
  function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
  }

  // Staged/Changes 파일 목록은 평면 행 모델 + 가상 스크롤 모듈이 그린다(수만 파일에서도 보이는 행만 DOM 유지).
  const workingList = window.__gscChangesWorkingList({
    rootEl,
    state,
    strings: T,
    esc,
    statusCodicon,
    fileIconHtml,
    statHtml,
    conflictBadgeHtml,
    rowActionsHtml,
    bindRows: (container) => bindWorkingRows(container),
    afterRowsRendered: (rows) => afterWorkingRowsRender(rows),
    persistState: () => vscode.setState(state),
  });

  // 비교 결과도 같은 행 모델을 사용하고, 열기/명시적 diff와 파일 tooltip은 Compare 모듈이 맡는다.
  const compareList = window.__gscCompare.createFileTree({
    rootEl, state, strings: T, esc, vscode, statusCodicon, fileIconHtml, statHtml,
    conflictBadgeHtml, applyFileIconGlyphStyles,
  });
  const fileTree = compareList.fileTree;

  // History의 HTML 생성을 별도 module로 유지해 이 파일은 상태 조정과 event binding에 집중한다.
  const { bindHistory, historyBody } = window.__gscChangesHistory({
    strings: T,
    state,
    esc,
    fileIconHtml,
    statHtml,
    statusCodicon,
    rootEl,
    vscode,
    post,
  });

  /** 전체 화면을 그린다. */
  function render(p) {
    const transient = captureTransientUi();
    const previousCommitMessageRevision = state.commitMessageRevision || 0;
    closeDropdown();
    lastPayload = p;
    compareList.beginRender();
    if (!p.repos.length) {
      workingList.beginRender();
      rootEl.innerHTML = window.__gscChangesOnboarding.render(p.onboarding, T, esc);
      window.__gscChangesOnboarding.bind(rootEl, post, p.onboarding);
      return;
    }
    state.visibleSections = normalizeVisibleSections(p.visibleSections);
    presentation.setFileIcons((p.fileIcons && p.fileIcons.icons) || {});
    loadFileIconFonts(p.fileIcons && p.fileIcons.fonts);
    const compareCount =
      p.compare.mode === "comparison" ? countFiles(p.compare.nodes) : 0;
    const changesCount =
      countFiles(p.changes.staged) + countFiles(p.changes.unstaged);
    const changesConflictCount =
      countConflicts(p.changes.staged) + countConflicts(p.changes.unstaged);
    const historyCount = (p.history?.commits || []).length;
    // 트리/리스트 토글은 파일 트리 섹션의 미트볼 메뉴 안에 둔다.
    const sectionHtml = {
      repos: section(
        "repos",
        T.repositories,
        p.repos.length,
        reposBody(p.repos),
        ""
      ),
      changes: section(
        "changes",
        T.changes,
        changesCount,
        changesBody(p.changes, p.commit, p.changes.viewMode),
        sectionActions(),
        changesConflictCount
      ),
      history: section(
        "history",
        T.history,
        historyCount,
        historyBody(p.history),
        ""
      ),
      compare: section(
        "compare",
        T.compareBranches,
        compareCount,
        window.__gscCompare.render(p.compare, p.compare.viewMode, {
          strings: T,
          escape: esc,
          fileTree,
        }),
        p.compare.mode === "comparison" ? sectionActions() : ""
      ),
      stashes: section(
        "stashes",
        T.stashes,
        (p.stashes || []).length,
        window.__gscStashes?.body?.(p.stashes || [], {
          repoRoot: p.commit?.repoRoot,
          expandedByKey: state.stashExpanded,
          fileIconHtml,
        }) || "",
        ""
      ),
      worktrees: section(
        "worktrees",
        T.worktrees,
        (p.worktrees || []).length,
        window.__gscWorktrees?.body?.(p.worktrees || []) || "",
        ""
      ),
    };
    rootEl.innerHTML = orderedSections(sectionHtml);
    window.__gscChangesInformationArchitecture?.organize(rootEl, T);
    // 스크롤 복원 전에 작업트리 spacer 높이를 정해 두어야 scrollTop 이 잘리지 않는다.
    workingList.attach(rootEl);
    compareList.attach(rootEl);

    applyFileIconGlyphStyles();
    applyCollapse();
    bindEvents();
    applyResize();
    applySelection();
    window.__gscApplyWorkingOperation?.();
    restoreTransientUi(transient, previousCommitMessageRevision);
    // 스크롤 위치를 되돌린 뒤에야 보이는 작업트리 행 범위를 정확히 계산할 수 있다.
    workingList.renderVisibleRows();
    compareList.renderVisibleRows();
    state.commitMessageRevision = p.commit?.messageRevision || 0;
    vscode.setState(state);
  }

  /**
   * 로컬 staged/unstaged delta만 받아 Changes 섹션 본문을 교체한다.
   * - History/Compare/Stash DOM과 스크롤은 그대로 두어 큰 보조 섹션의 HTML 생성·이벤트 재연결을 피한다.
   * @param {object} delta host가 보낸 Changes 노드, commit 상태, 파일 아이콘 delta
   */
  function renderWorkingChanges(delta) {
    if (!lastPayload) {
      return;
    }
    const sectionEl = rootEl.querySelector('.section[data-section="changes"]');
    const body = sectionEl?.querySelector(":scope > .section-body");
    const header = sectionEl?.querySelector(":scope > .section-header");
    if (!sectionEl || !body || !header) {
      render({
        ...lastPayload,
        changes: delta.changes,
        commit: { ...lastPayload.commit, ...delta.commit },
      });
      return;
    }
    const transient = captureTransientUi();
    const previousCommitMessageRevision = state.commitMessageRevision || 0;
    closeDropdown();
    lastPayload = {
      ...lastPayload,
      changes: delta.changes,
      commit: { ...lastPayload.commit, ...delta.commit },
    };
    presentation.mergeFileIcons((delta.fileIcons && delta.fileIcons.icons) || {});
    loadFileIconFonts(delta.fileIcons && delta.fileIcons.fonts);
    const count =
      countFiles(delta.changes.staged) + countFiles(delta.changes.unstaged);
    const conflicts =
      countConflicts(delta.changes.staged) + countConflicts(delta.changes.unstaged);
    syncChangesSectionHeader(sectionEl, header, count, conflicts);
    body.innerHTML = changesBody(
      delta.changes,
      lastPayload.commit,
      delta.changes.viewMode
    );
    workingList.attach(body);
    applyFileIconGlyphStyles(body);
    bindMarqueeSelection(body);
    bindCommitBox(body);
    bindGroupActions(body);
    applyResize();
    applySelection();
    window.__gscApplyWorkingOperation?.();
    restoreTransientUi(transient, previousCommitMessageRevision);
    workingList.renderVisibleRows();
    state.commitMessageRevision = lastPayload.commit?.messageRevision || 0;
    vscode.setState(state);
  }

  /** Changes 섹션 header의 파일 수와 충돌 배지를 delta 결과에 맞게 갱신한다. */
  function syncChangesSectionHeader(sectionEl, header, count, conflicts) {
    header.querySelector(":scope > .count")?.remove();
    header.querySelector(":scope > .conflict-badge")?.remove();
    if (count) {
      const countEl = document.createElement("span");
      countEl.className = "count";
      countEl.textContent = String(count);
      header.querySelector(":scope > .title")?.insertAdjacentElement("afterend", countEl);
    }
    if (conflicts) {
      header.insertAdjacentHTML("beforeend", conflictBadgeHtml(conflicts));
    }
    sectionEl.classList.toggle("has-conflicts", conflicts > 0);
  }

  /**
   * button 요소로 바꾸기 어려운 행형 컨트롤에 키보드 동작을 더한다.
   * 행 안의 실제 버튼을 조작할 때는 중복 실행하지 않고, Enter/Space만 행의 주 동작으로 연결한다.
   * @param {HTMLElement} el 키보드로 조작할 행
   * @param {(event: KeyboardEvent) => void} action Enter 또는 Space에서 실행할 행의 주 동작
   */
  function bindRowKeyboardAction(el, action) {
    el.addEventListener("keydown", (event) => {
      if (event.target !== el || (event.key !== "Enter" && event.key !== " ")) {
        return;
      }
      event.preventDefault();
      action(event);
    });
  }

  /**
   * Worktrees 섹션이 실제로 펼쳐진 첫 시점에만 host 조회를 요청한다.
   * - 초기 payload에서 worktree 검사를 생략하므로 새 웹뷰의 접힌 섹션은 Git 프로세스를 만들지 않는다.
   * @returns 반환값 없이 현재 웹뷰 생명주기에서 한 번만 refresh 메시지를 전송한다
   */
  function requestExpandedWorktrees() {
    const section = rootEl.querySelector('.section[data-section="worktrees"]');
    if (
      !section ||
      section.classList.contains("collapsed") ||
      worktreesRequested ||
      !(lastPayload?.repos || []).length
    ) {
      return;
    }
    worktreesRequested = true;
    post("refreshWorktrees");
  }

  /** 렌더 후 이벤트를 연결한다. */
  function bindEvents() {
    rootEl.querySelectorAll(".section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (consumeHeaderClick()) return;
        // 헤더 우측 액션(토글/미트볼) 클릭은 접힘과 분리한다.
        if (e.target.closest(".header-actions")) {
          return;
        }
        toggleSection(h.parentElement.dataset.section);
        applyCollapse();
        window.__gscStashes?.requestExpanded?.(rootEl, vscode);
        requestExpandedWorktrees();
        applyResize();
        workingList.scheduleRender();
        compareList.scheduleRender();
      });
    });
    requestExpandedWorktrees();
    bindSectionDrag();
    // 미트볼(...) → 섹션별 액션 + 아코디언 카테고리 토글 메뉴(다시 누르면 닫힘 토글).
    rootEl.querySelectorAll(".meatball").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isDropdownAnchor(el)) {
          closeDropdown();
        } else {
          const section = el.closest(".section");
          openDropdown(
            el,
            accordionMenuNodes(section?.dataset.section, lastPayload, SCM_MENU, T)
          );
        }
      });
    });
    rootEl.querySelectorAll(".repo").forEach((el) => {
      const selectRepository = () =>
        vscode.postMessage({ type: "selectRepo", root: el.dataset.root });
      el.addEventListener("click", selectRepository);
      bindRowKeyboardAction(el, selectRepository);
    });
    window.__gscCompare.bind(rootEl, vscode);
    // 작업트리 행(단일 클릭=선택+비교, Ctrl/Cmd·Shift=다중 선택)은 가상 스크롤 목록이 위임 연결한다.
    // 파일 트리 끝 너머(그룹 아래 빈 공간)에서도 드래그 선택이 시작되도록 Changes 섹션 본문 전체를
    // 마퀴 표면으로 삼는다. .wt-files 만 쓰면 행 높이 바깥에서는 selectbox 가 그려지지 않는다.
    const marqueeSurface = rootEl.querySelector(
      '.section[data-section="changes"] > .section-body'
    );
    if (marqueeSurface) {
      bindMarqueeSelection(marqueeSurface);
    }
    bindCommitBox();
    bindGroupActions();
    bindRowActions(rootEl);
    bindHistory();
    window.__gscStashes?.bind?.(rootEl, vscode, {
      state,
      menus: {
        openContextMenu,
        openDropdown,
        closeDropdown,
        isDropdownAnchor,
      },
    });
    window.__gscWorktrees?.bind?.(rootEl, vscode);
  }

  // Commit composer가 입력·busy 상태·caret menu를 한 곳에서 소유한다.
  const commitBox = window.__gscChangesCommitBox({
    vscode,
    getMenuApi: () => ({ closeDropdown, isDropdownAnchor, openDropdown }),
    getCommitMenuNodes: () => COMMIT_MENU,
  });
  const { doCommit } = commitBox;

  // 드롭다운·context menu의 keyboard/focus 책임은 전용 모듈이 맡는다.
  const { closeDropdown, isDropdownAnchor, openDropdown, openContextMenu, accordionMenuNodes } = window.__gscChangesMenu({
    vscode,
    esc,
    doCommit,
  });
  const { bindCommitBox, setCommitInProgress } = commitBox;

  // ── 그룹/행 인라인 액션 ──

  /** 그룹 헤더의 전체 stage/unstage/discard 액션(경로 없이 → 전체). */
  function bindGroupActions(scope = rootEl) {
    scope.querySelectorAll(".group-action").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        postWorkingAction(el.dataset.gact);
      });
    });
    // 그룹 헤더 클릭 → 그 그룹만 접기/펼치기(액션 클릭은 제외).
    scope.querySelectorAll(".group-toggle").forEach((toggle) => {
      toggle.addEventListener("click", () => toggleChangesGroup(toggle));
    });
  }

  /**
   * Staged/Changes 그룹의 접힘 상태와 아이콘, tooltip, aria-expanded 를 함께 갱신한다.
   * @param {HTMLElement} toggle 사용자가 누른 그룹 disclosure button
   */
  function toggleChangesGroup(toggle) {
    const group = toggle.closest(".group");
    if (!group) {
      return;
    }
    const key = group.dataset.gkey;
    const collapsed = !state.groups[key];
    state.groups[key] = collapsed;
    vscode.setState(state);
    group.classList.toggle("collapsed", collapsed);
    const tw = toggle.querySelector(".twistie");
    tw?.classList.toggle("codicon-chevron-down", !collapsed);
    tw?.classList.toggle("codicon-chevron-right", collapsed);
    syncDisclosureControl(toggle, !collapsed);
    workingList.scheduleRender();
  }

  /**
   * 행이 가리키는 경로들(파일=자신, 폴더=모든 하위 파일).
   * - 작업트리 폴더는 가상 스크롤로 자식 행이 DOM 에 없을 수 있어 행 모델에서 하위 파일을 모은다.
   */
  function rowPaths(row) {
    if (row.classList.contains("file")) {
      return [row.dataset.path];
    }
    if (row.closest(".wt-files")) {
      return workingList.pathsForRow(row);
    }
    const children = row.nextElementSibling;
    if (!children || !children.classList.contains("children")) {
      return [];
    }
    return Array.from(children.querySelectorAll(".row.file")).map(
      (f) => f.dataset.path
    );
  }

  // 다중 선택, Shift range, 마퀴 드래그는 전용 모듈이 state와 DOM을 함께 소유한다.
  const { actionPaths, applySelection, bindMarqueeSelection, consumeSuppressedRowClick, isSelected, onWorkingRowClick, selectOnly } = window.__gscChangesTreeSelection({
    rootEl,
    closeDropdown,
    openWorkingPath,
    rowPaths,
    model: workingList,
  });

  // 행 action의 DOM 이벤트와 선택 상태 전환은 전용 모듈에 맡긴다.
  const { bindRowActions, bindWorkingRows } = window.__gscChangesWorkingTreeActions({
    actionPaths,
    consumeSuppressedRowClick,
    isSelected,
    onWorkingRowClick,
    openContextMenu,
    postWorkingAction,
    strings: T,
    openWorkingPath,
    selectOnly,
    toggleWorkingFolder: (row) => workingList.toggleFolder(row),
    vscode,
  });

  /**
   * 가상 스크롤이 새로 그린 작업트리 행에 아이콘 글꼴·선택·진행 표시를 적용한다.
   * @param {HTMLElement[]} rows 방금 DOM 에 추가된 행
   */
  function afterWorkingRowsRender(rows) {
    rows.forEach((row) => applyFileIconGlyphStyles(row));
    applySelection();
    window.__gscApplyWorkingOperation?.();
  }

  /** 작업트리 파일 열기: 충돌은 resolver, 그 외 staged/unstaged 는 editable diff 로 연다. */
  function openWorkingPath(path, stage, status) {
    vscode.postMessage({ type: "openWorkingChange", path, stage, status });
  }

  /** stage/unstage 는 즉시 busy 상태를 표시하고 중복 클릭을 막은 뒤 extension host 로 보낸다. */
  function postWorkingAction(type, paths) {
    if (type !== "stage" && type !== "unstage") {
      vscode.postMessage({ type, paths });
      return;
    }
    if (window.__gscIsWorkingOperationActive?.()) {
      return;
    }
    window.__gscBeginWorkingOperation?.(type, paths);
    vscode.postMessage({ type, paths });
  }

  window.addEventListener("message", (event) => {
    if (event.data.type === "render") {
      render(event.data.payload);
    } else if (event.data.type === "workingRender") {
      renderWorkingChanges(event.data.payload);
    } else if (event.data.type === "workingOperation") {
      window.__gscSetWorkingOperation?.(
        event.data.active,
        event.data.action,
        event.data.paths,
        event.data.phase
      );
    } else if (event.data.type === "commitOperation") {
      setCommitInProgress(event.data.active);
    }
  });

})();
