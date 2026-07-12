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
      openHistoryCommit: "Open File Change",
      stashes: "Stashes",
      noStashes: "No stashes.",
      stashSelected: "Stash Selected Changes",
      applyStash: "Apply Stash",
      popStash: "Pop Stash",
      dropStash: "Drop Stash",
      branchStash: "Create Branch from Stash",
      worktrees: "Worktrees",
    },
    window.__gscCompare?.defaults || {},
    window.__gscI18n || {}
  );

  let state = vscode.getState() || {};
  state.collapsed = state.collapsed || {};
  state.sizes = state.sizes || {};
  state.groups = state.groups || {}; // Staged/Changes 그룹 접힘 상태
  state.folders = state.folders || {}; // 파일 트리 폴더 접힘 상태(kind:path)
  state.stashExpanded = state.stashExpanded || {}; // stash 펼침 상태(ref/hash별)
  state.historyExpanded = state.historyExpanded || {}; // history 커밋 상세 펼침 상태(hash별)
  state.commitMessageRevision = state.commitMessageRevision || 0;
  const SECTION_IDS = ["repos", "changes", "history", "compare", "stashes", "worktrees"];
  state.sectionOrder = normalizeSectionOrder(state.sectionOrder);
  state.visibleSections = normalizeVisibleSections(state.visibleSections);
  let currentFileIcons = {};
  let lastPayload = null;
  const loadedFileIconFonts = new Set();
  let draggingSectionId = null;
  let suppressHeaderClick = false;
  const isCollapsed = (id) => !!state.collapsed[id];

  /**
   * disclosure 컨트롤의 현재 펼침 상태를 지역화된 다음 동작 tooltip 으로 바꾼다.
   * @param {string} label 사용자가 구분할 수 있는 섹션 또는 그룹 이름
   * @param {boolean} expanded 현재 본문이 펼쳐져 있으면 true
   * @returns {string} 클릭했을 때 수행될 Collapse/Expand 동작 문구
   */
  function disclosureTooltip(label, expanded) {
    const template = expanded ? T.collapseSection : T.expandSection;
    return String(template).replace("{0}", label);
  }

  /**
   * 접기/펼치기 컨트롤의 tooltip, 접근성 이름, aria-expanded 를 한 번에 동기화한다.
   * @param {HTMLElement | null} control 상태를 반영할 button 또는 동등한 컨트롤
   * @param {boolean} expanded 컨트롤이 담당하는 본문이 현재 펼쳐져 있는지 여부
   */
  function syncDisclosureControl(control, expanded) {
    if (!control) {
      return;
    }
    const label = control.dataset.disclosureLabel || control.textContent?.trim() || "Section";
    const tooltip = disclosureTooltip(label, expanded);
    control.title = tooltip;
    control.dataset.tooltip = tooltip;
    control.setAttribute("aria-label", tooltip);
    control.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  function toggleSection(id) {
    state.collapsed[id] = !state.collapsed[id];
    vscode.setState(state);
  }

  /** 저장된 섹션 순서를 현재 섹션 목록에 맞춰 정규화한다. */
  function normalizeSectionOrder(order) {
    const saved = Array.isArray(order) ? order.filter((id) => SECTION_IDS.includes(id)) : [];
    return [...saved, ...SECTION_IDS.filter((id) => !saved.includes(id))];
  }

  /** 현재 저장된 섹션 순서대로 HTML 을 이어 붙인다. */
  function orderedSections(sectionHtml) {
    return state.sectionOrder
      .filter((id) => state.visibleSections[id] !== false)
      .map((id) => sectionHtml[id] || "")
      .join("");
  }

  /** 저장된 섹션 표시 상태를 정규화하고, 모두 숨김이면 기본 섹션을 되살린다. */
  function normalizeVisibleSections(saved) {
    const visible = {};
    for (const id of SECTION_IDS) {
      visible[id] = !(saved && saved[id] === false);
    }
    if (!SECTION_IDS.some((id) => visible[id])) {
      visible.changes = true;
    }
    return visible;
  }

  // 섹션 리사이즈(네이티브 PaneView 풍) 상수: 헤더 높이 / 크기조절 섹션의 최소 높이.
  const HEADER_H = 22;
  const MIN_SECTION = 48;
  // 크기조절(grow) 대상 섹션의 기본 가중치(비율).
  const DEFAULT_WEIGHT = {
    repos: 120,
    changes: 240,
    history: 180,
    compare: 240,
    stashes: 120,
    worktrees: 140,
  };

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 상태 코드에 맞는 codicon 클래스. */
  function statusCodicon(status) {
    switch (status) {
      case "A":
        return "codicon-diff-added";
      case "D":
        return "codicon-diff-removed";
      case "R":
      case "C":
        return "codicon-diff-renamed";
      case "U":
        return "codicon-warning";
      default:
        return "codicon-diff-modified";
    }
  }

  /** 경로에서 파일명(마지막 세그먼트)만 추출한다. */
  function baseName(path) {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  /** 현재 VS Code 파일 아이콘 테마 payload 에 맞는 파일 아이콘 HTML. */
  function fileIconHtml(path) {
    const icon = currentFileIcons[path];
    if (icon && icon.kind === "image" && icon.uri) {
      return (
        `<span class="extension-icon theme-file-icon">` +
        `<img src="${esc(icon.uri)}" alt="" /></span>`
      );
    }
    if (icon && icon.kind === "glyph" && icon.text && icon.fontFamily) {
      return (
        `<span class="extension-icon theme-file-icon theme-file-icon-glyph" ` +
        `data-font-family="${esc(icon.fontFamily)}" ` +
        `data-font-color="${esc(icon.color || "")}" ` +
        `data-font-size="${esc(icon.size || "")}">${esc(icon.text)}</span>`
      );
    }
    const codicon =
      icon && icon.kind === "codicon" && icon.codicon
        ? icon.codicon
        : "codicon-file";
    return `<span class="extension-icon codicon ${esc(codicon)}"></span>`;
  }

  /** 파일 아이콘 테마가 제공한 글꼴을 FontFace API 로 등록한다. */
  function loadFileIconFonts(fonts) {
    if (!("FontFace" in window)) {
      return;
    }
    for (const font of fonts || []) {
      if (!font.family || !font.uri || loadedFileIconFonts.has(font.family)) {
        continue;
      }
      loadedFileIconFonts.add(font.family);
      const face = new FontFace(font.family, `url(${font.uri})`, {
        weight: font.weight || "normal",
        style: font.style || "normal",
      });
      face
        .load()
        .then((loaded) => document.fonts.add(loaded))
        .catch(() => loadedFileIconFonts.delete(font.family));
    }
  }

  /** glyph 기반 파일 아이콘에 동적 글꼴/색/크기를 적용한다. */
  function applyFileIconGlyphStyles() {
    rootEl.querySelectorAll(".theme-file-icon-glyph").forEach((el) => {
      el.style.fontFamily = el.dataset.fontFamily || "";
      el.style.color =
        el.dataset.fontColor || "var(--vscode-descriptionForeground)";
      el.style.fontSize = el.dataset.fontSize || "";
    });
  }

  /** +추가 −삭제 숫자를 색상 span 으로(정보 없으면 빈 문자열). */
  function statHtml(change) {
    if (change.additions === undefined && change.deletions === undefined) {
      return "";
    }
    return (
      `<span class="stat"><span class="add">+${change.additions || 0}</span> ` +
      `<span class="del">−${change.deletions || 0}</span></span>`
    );
  }

  /** 노드 트리에서 파일 개수를 센다(헤더 카운트용). */
  function countFiles(nodes) {
    let n = 0;
    for (const node of nodes) {
      n += node.kind === "folder" ? countFiles(node.children) : 1;
    }
    return n;
  }

  /** 노드 트리에서 충돌 파일 개수를 센다. */
  function countConflicts(nodes) {
    let n = 0;
    for (const node of nodes) {
      n += node.kind === "folder"
        ? countConflicts(node.children)
        : node.change.status === "U" ? 1 : 0;
    }
    return n;
  }

  /** 파일/폴더 노드가 충돌 상태를 포함하는지 확인한다. */
  function hasConflict(node) {
    return node.kind === "folder"
      ? countConflicts(node.children) > 0
      : node.change.status === "U";
  }

  /** 충돌 상태를 표시하는 작은 배지를 만든다. */
  function conflictBadgeHtml(count) {
    const label = count ? `${count} ${T.conflicts}` : T.conflicts;
    return (
      `<span class="conflict-badge" title="${esc(label)}">` +
      `<span class="codicon codicon-warning" aria-hidden="true"></span>` +
      (count ? `<span>${count}</span>` : "") +
      `</span>`
    );
  }

  /** 섹션(헤더 + 본문) HTML. actionsHtml 은 헤더 우측 인라인 액션(hover 노출). */
  function section(id, title, count, bodyHtml, actionsHtml, conflictCount) {
    const expanded = !isCollapsed(id);
    const tooltip = disclosureTooltip(title, expanded);
    const countHtml = count ? `<span class="count">${count}</span>` : "";
    const conflictHtml = conflictCount ? conflictBadgeHtml(conflictCount) : "";
    const actions = actionsHtml
      ? `<span class="header-actions">${actionsHtml}</span>`
      : "";
    return (
      `<div class="section${conflictCount ? " has-conflicts" : ""}" data-section="${id}">` +
      `<button class="section-header" type="button" data-disclosure-label="${esc(title)}" ` +
      `aria-controls="section-body-${esc(id)}" aria-expanded="${expanded ? "true" : "false"}" ` +
      `title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}">` +
      `<span class="twistie codicon codicon-chevron-down"></span>` +
      `<span class="title">${esc(title)}</span>${countHtml}${conflictHtml}</button>${actions}` +
      `<div id="section-body-${esc(id)}" class="section-body">${bodyHtml}</div></div>`
    );
  }

  /** Repositories 섹션 본문(저장소명 + 현재 브랜치). */
  function reposBody(repos) {
    if (!repos.length) {
      return `<p class="empty">${esc(T.noRepos)}</p>`;
    }
    return repos
      .map(
        (r) =>
          `<div class="row repo${r.active ? " active" : ""}" ` +
          `data-root="${esc(r.root)}" title="${esc(r.root)}">` +
          `<span class="icon codicon ${
            r.active ? "codicon-pass-filled" : "codicon-repo"
          }"></span>` +
          `<span class="name">${esc(r.name)}</span>` +
          (r.branch
            ? `<span class="branch"><span class="codicon codicon-git-branch">` +
              `</span>${esc(r.branch)}</span>`
            : "") +
          (r.active ? `<span class="badge">${esc(T.current)}</span>` : "") +
          `</div>`
      )
      .join("");
  }

  /**
   * 행 hover 시 노출되는 인라인 액션 묶음 HTML.
   * - 파일이면 "파일 열기"(편집 화면) 아이콘을 먼저 둔다.
   * - compare 파일은 일반 편집기 클릭과 별개로 명시적인 diff 액션을 제공한다.
   * - staged → unstage, unstaged → discard + stage.
   * @param kind   compare/staged/unstaged
   * @param isFile 파일 행이면 true(폴더면 false)
   */
  function rowActionsHtml(kind, isFile) {
    if (kind === "compare") {
      return window.__gscCompare.rowActionsHtml(T, esc, isFile);
    }
    if (kind !== "staged" && kind !== "unstaged") {
      return "";
    }
    let html = "";
    if (isFile) {
      html +=
        `<button class="row-action codicon codicon-go-to-file" type="button" data-act="openFile" ` +
        `title="${esc(T.openFile)}" aria-label="${esc(T.openFile)}"></button>`;
    }
    if (kind === "staged") {
      html +=
        `<button class="row-action codicon codicon-remove" type="button" data-act="unstage" ` +
        `title="${esc(T.unstage)}" aria-label="${esc(T.unstage)}"></button>`;
    } else {
      html +=
        `<button class="row-action codicon codicon-discard" type="button" data-act="discard" ` +
        `title="${esc(T.discard)}" aria-label="${esc(T.discard)}"></button>` +
        `<button class="row-action codicon codicon-add" type="button" data-act="stage" ` +
        `title="${esc(T.stage)}" aria-label="${esc(T.stage)}"></button>`;
    }
    return `<span class="row-actions">${html}</span>`;
  }

  /** 노드(폴더/파일)를 재귀 HTML 로(들여쓰기는 .children 중첩). kind: compare/staged/unstaged. */
  function nodeHtml(node, viewMode, kind, gutter) {
    if (node.kind === "folder") {
      const conflictCount = countConflicts(node.children);
      const children = node.children
        .map((c) => nodeHtml(c, viewMode, kind, gutter))
        .join("");
      const key = folderKey(kind, node.path);
      const collapsed = !!state.folders[key];
      const title = conflictCount ? `${node.path} - ${T.conflicts}` : node.path;
      return (
        `<div class="row folder${conflictCount ? " conflict" : ""}" ` +
        `data-folder-key="${esc(key)}" data-path="${esc(node.path)}" ` +
        `title="${esc(title)}">` +
        `<span class="twistie codicon ${
          collapsed ? "codicon-chevron-right" : "codicon-chevron-down"
        }"></span>` +
        `<span class="icon codicon ${
          collapsed ? "codicon-folder" : "codicon-folder-opened"
        }"></span>` +
        `<span class="name">${esc(node.name)}</span>` +
        (conflictCount ? conflictBadgeHtml(conflictCount) : "") +
        rowActionsHtml(kind, false) +
        `</div>` +
        `<div class="children${collapsed ? " collapsed" : ""}">${children}</div>`
      );
    }
    const ch = node.change;
    const slash = ch.path.lastIndexOf("/");
    const fileName = slash >= 0 ? ch.path.slice(slash + 1) : ch.path;
    const dir = slash >= 0 ? ch.path.slice(0, slash) : "";
    const dirHtml =
      viewMode === "list" && dir ? `<span class="dir">${esc(dir)}</span>` : "";
    const conflicted = hasConflict(node);
    const title =
      kind === "compare"
        ? `${window.__gscCompare.fileActionLabel(T, ch, gutter)}: ${ch.path}`
        : conflicted
          ? `${ch.path} - ${T.conflicts}`
          : ch.path;
    const compareRowAttrs =
      kind === "compare"
        ? ` role="group" aria-label="${esc(ch.path)}"`
        : "";
    const compareNameAttrs =
      kind === "compare"
        ? ` role="button" tabindex="0" title="${esc(title)}" aria-label="${esc(
            title
          )}"`
        : "";
    return (
      `<div class="row file${conflicted ? " conflict" : ""}" data-status="${esc(ch.status)}" ` +
      `data-path="${esc(ch.path)}" data-stage="${esc(kind)}" ` +
      `title="${esc(title)}"${compareRowAttrs}>` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(ch.status)}"></span>` +
      fileIconHtml(ch.path) +
      `<span class="name"${compareNameAttrs}>${esc(fileName)}</span>` +
      dirHtml +
      statHtml(ch) +
      (conflicted ? conflictBadgeHtml(0) : "") +
      rowActionsHtml(kind, true) +
      `</div>`
    );
  }

  /** 파일 트리 폴더 접힘 상태 키를 만든다. */
  function folderKey(kind, path) {
    return `${kind}:${path}`;
  }

  /**
   * 노드 배열을 가로 스크롤 가능한 파일 트리로 감싸고 필요하면 disclosure 연결용 id를 부여한다.
   * @param {Array} nodes 렌더링할 폴더/파일 노드 배열
   * @param {string} viewMode tree 또는 list 보기 모드
   * @param {string} kind compare/staged/unstaged 동작 구분값
   * @param {string} extraClass 파일 트리 루트에 추가할 CSS class
   * @param {string} emptyText 노드가 없을 때 표시할 안내 문구
   * @param {object | undefined} gutter 비교 파일의 gutter 상태
   * @param {string | undefined} elementId aria-controls가 가리킬 선택적 DOM id
   * @returns {string} 파일 트리 또는 빈 상태 HTML
   */
  function fileTree(
    nodes,
    viewMode,
    kind,
    extraClass,
    emptyText,
    gutter,
    elementId
  ) {
    const idAttribute = elementId ? ` id="${esc(elementId)}"` : "";
    if (!nodes.length) {
      return `<p${idAttribute} class="empty">${esc(emptyText)}</p>`;
    }
    const rows = nodes
      .map((n) => nodeHtml(n, viewMode, kind, gutter))
      .join("");
    return `<div${idAttribute} class="files ${extraClass}"><div class="rows">${rows}</div></div>`;
  }

  /** 헤더 우측 미트볼(...) 버튼 HTML. */
  function meatballAction() {
    return (
      `<button class="header-action meatball codicon codicon-ellipsis" type="button" ` +
      `title="${esc(T.moreActions)}" aria-label="${esc(T.moreActions)}" ` +
      `data-tooltip="${esc(T.moreActions)}" aria-haspopup="menu" aria-expanded="false"></button>`
    );
  }

  /** 섹션 고유 액션에 아코디언 메뉴 미트볼을 더한다. */
  function sectionActions() {
    return meatballAction();
  }

  /** 아코디언 미트볼 메뉴 항목을 만든다(섹션별 보기 토글 + 상단 Changes 액션). */
  function accordionMenuNodes(sectionId) {
    const nodes = [];
    const viewNode = viewModeMenuNode(sectionId);
    if (viewNode) {
      nodes.push(viewNode);
    }
    if (sectionId === "changes") {
      const remoteBranchNode = findMenuNode(SCM_MENU, "configureRemoteBranch");
      if (remoteBranchNode) {
        if (nodes.length) {
          nodes.push({ separator: true });
        }
        nodes.push(remoteBranchNode);
      }
    }
    return nodes;
  }

  /** 주입된 SCM 메뉴 트리에서 특정 액션 ID 의 리프 항목을 찾는다. */
  function findMenuNode(nodes, id) {
    for (const node of nodes || []) {
      if (node && node.id === id) {
        return node;
      }
      if (node && node.submenu) {
        const found = findMenuNode(node.submenu, id);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  /** 파일 트리 섹션의 현재 보기 모드를 뒤집는 메뉴 항목을 만든다. */
  function viewModeMenuNode(sectionId) {
    if (!lastPayload) {
      return undefined;
    }
    if (sectionId === "changes") {
      return viewModeToggleNode("changes", lastPayload.changes.viewMode);
    }
    if (sectionId === "compare" && lastPayload.compare.mode === "comparison") {
      return viewModeToggleNode("compare", lastPayload.compare.viewMode);
    }
    return undefined;
  }

  /** 특정 섹션의 트리/리스트 보기 전환 메뉴 항목. */
  function viewModeToggleNode(section, viewMode) {
    const toTree = viewMode === "list";
    return {
      label: toTree ? T.viewAsTree : T.viewAsList,
      onClick: () => post("toggleViewMode", { section }),
    };
  }

  /** 커밋 입력 박스(메시지 textarea + 커밋 버튼) HTML. */
  function commitBoxHtml(commit) {
    if (!commit || !commit.hasRepo) {
      return "";
    }
    return (
      `<div class="commit-box">` +
      `<textarea id="commit-msg" class="commit-input" rows="1" ` +
      `title="${esc(T.commitPlaceholder)}" aria-label="${esc(T.commitPlaceholder)}" ` +
      `placeholder="${esc(T.commitPlaceholder)}">${esc(commit.message)}</textarea>` +
      `<div class="commit-bar">` +
      `<button id="commit-btn" class="commit-btn" type="button" ` +
      `title="${esc(T.commit)}" aria-label="${esc(T.commit)}">` +
      `<span class="codicon codicon-check"></span>` +
      `<span class="commit-label">${esc(T.commit)}</span></button>` +
      `<button id="commit-caret" class="commit-caret" type="button" ` +
      `title="${esc(T.moreActions)}" aria-label="${esc(T.moreActions)}">` +
      `<span class="codicon codicon-chevron-down"></span></button>` +
      `</div></div>`
    );
  }

  /** Staged/Unstaged 그룹(접기 헤더 + 인라인 액션 + 파일 트리) HTML. */
  function changesGroupHtml(kind, nodes, viewMode) {
    const title = kind === "staged" ? T.stagedChanges : T.changes;
    const count = countFiles(nodes);
    const conflictCount = countConflicts(nodes);
    const collapsed = !!state.groups[kind];
    const expanded = !collapsed;
    const chevron = collapsed ? "codicon-chevron-right" : "codicon-chevron-down";
    const tooltip = disclosureTooltip(title, expanded);
    const bodyId = `changes-group-files-${kind}`;
    let actions;
    if (kind === "staged") {
      actions =
        `<button class="group-action codicon codicon-remove" type="button" data-gact="unstage" ` +
        `title="${esc(T.unstageAll)}" aria-label="${esc(T.unstageAll)}"></button>`;
    } else {
      actions =
        `<button class="group-action codicon codicon-discard" type="button" data-gact="discard" ` +
        `title="${esc(T.discardAll)}" aria-label="${esc(T.discardAll)}"></button>` +
        `<button class="group-action codicon codicon-add" type="button" data-gact="stage" ` +
        `title="${esc(T.stageAll)}" aria-label="${esc(T.stageAll)}"></button>`;
    }
    return (
      `<div class="group${collapsed ? " collapsed" : ""}${conflictCount ? " has-conflicts" : ""}" ` +
      `data-gkey="${kind}">` +
      `<div class="group-header">` +
      `<button class="group-toggle" type="button" data-disclosure-label="${esc(title)}" ` +
      `aria-controls="${esc(bodyId)}" aria-expanded="${expanded ? "true" : "false"}" ` +
      `title="${esc(tooltip)}" ` +
      `data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}">` +
      `<span class="twistie codicon ${chevron}"></span>` +
      `<span class="group-title">${esc(title)}</span>` +
      `<span class="count">${count}</span>` +
      (conflictCount ? conflictBadgeHtml(conflictCount) : "") +
      `</button><span class="group-actions">${actions}</span></div>` +
      fileTree(
        nodes,
        viewMode,
        kind,
        kind + "-files wt-files",
        "",
        undefined,
        bodyId
      ) +
      `</div>`
    );
  }

  /** Changes 섹션 본문(커밋 박스 + Staged 그룹 + Changes 그룹). */
  function changesBody(changes, commit, viewMode) {
    let html = commitBoxHtml(commit);
    if (changes.staged.length) {
      html += changesGroupHtml("staged", changes.staged, viewMode);
    }
    if (changes.unstaged.length) {
      html += changesGroupHtml("unstaged", changes.unstaged, viewMode);
    }
    if (!changes.staged.length && !changes.unstaged.length) {
      html += `<p class="empty">${esc(T.noChanges)}</p>`;
    }
    return html;
  }

  /** 현재 히스토리 대상 파일을 표시하는 고정 헤더. */
  function historyCurrentFileHtml(history) {
    if (!history || !history.path) {
      return "";
    }
    const slash = history.path.lastIndexOf("/");
    const fileName = slash >= 0 ? history.path.slice(slash + 1) : history.path;
    const dir = slash >= 0 ? history.path.slice(0, slash) : "";
    return (
      `<div class="history-current-file" title="${esc(history.path)}">` +
      fileIconHtml(history.path) +
      `<span class="name">${esc(fileName)}</span>` +
      (dir ? `<span class="dir">${esc(dir)}</span>` : "") +
      `</div>`
    );
  }

  /** 커밋 메시지 본문을 상세 영역에 표시한다. */
  function historyMessageHtml(commit) {
    const message = (commit.message || commit.title || "").trim();
    return `<pre class="history-message">${esc(message)}</pre>`;
  }

  /** 히스토리 상세 영역에서 해당 파일 diff 를 여는 링크형 버튼. */
  function historyFileLinkHtml(repoRoot, commit) {
    const label = commit.oldPath
      ? `${commit.oldPath} → ${commit.path}`
      : commit.path;
    const tooltip = `${T.openHistoryCommit}: ${label}`;
    return (
      `<button class="history-file-link" type="button" ` +
      `data-repo-root="${esc(repoRoot || "")}" data-path="${esc(commit.path)}" ` +
      `data-old-path="${esc(commit.oldPath || "")}" ` +
      `data-base-ref="${esc(commit.baseRef)}" data-head-ref="${esc(commit.hash)}" ` +
      `data-short-hash="${esc(commit.shortHash)}" data-title="${esc(commit.title)}" ` +
      `title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" ` +
      `aria-label="${esc(tooltip)}">` +
      `<span class="codicon codicon-diff" aria-hidden="true"></span>` +
      fileIconHtml(commit.path) +
      `<span class="name">${esc(label)}</span>` +
      statHtml(commit) +
      `</button>`
    );
  }

  /** 파일 히스토리 커밋 한 줄(클릭 시 메시지 상세를 펼치고, 상세의 파일 링크가 diff 를 연다). */
  function historyCommitHtml(repoRoot, commit) {
    const key = commit.hash || `${commit.path}:${commit.shortHash || ""}`;
    const expanded = !!state.historyExpanded[key];
    const chevron = expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const title = `${commit.shortHash || commit.hash} ${commit.title || ""}`.trim();
    const meta = [commit.author, commit.relativeDate || commit.dateIso]
      .filter(Boolean)
      .join(" · ");
    const tooltip = `${T.toggleSection}: ${title}`;
    return (
      `<div class="history-item${expanded ? "" : " collapsed"}" data-key="${esc(key)}">` +
      `<div class="row file history-commit" role="button" tabindex="0" ` +
      `data-status="${esc(commit.status)}" data-key="${esc(key)}" ` +
      `title="${esc(tooltip)}" aria-label="${esc(tooltip)}" ` +
      `aria-expanded="${expanded ? "true" : "false"}">` +
      `<span class="twistie codicon ${chevron}"></span>` +
      `<span class="icon codicon ${statusCodicon(commit.status)}"></span>` +
      `<span class="history-hash">${esc(commit.shortHash || commit.hash.slice(0, 7))}</span>` +
      `<span class="name history-title">${esc(commit.title)}</span>` +
      (meta ? `<span class="history-meta">${esc(meta)}</span>` : "") +
      statHtml(commit) +
      `</div>` +
      `<div class="history-details">` +
      historyMessageHtml(commit) +
      historyFileLinkHtml(repoRoot, commit) +
      `</div></div>`
    );
  }

  /** History 섹션 본문(현재 파일 + 관련 커밋 목록). */
  function historyBody(history) {
    if (!history || !history.path) {
      return `<p class="empty">${esc(history?.message || T.noHistoryFile)}</p>`;
    }
    let html = historyCurrentFileHtml(history);
    if (history.message) {
      return html + `<p class="empty">${esc(history.message)}</p>`;
    }
    const commits = history.commits || [];
    if (!commits.length) {
      return html + `<p class="empty">${esc(T.noHistory)}</p>`;
    }
    const rows = commits
      .map((commit) => historyCommitHtml(history.repoRoot, commit))
      .join("");
    return html + `<div class="files history-files"><div class="rows">${rows}</div></div>`;
  }

  /** stash 안의 파일 한 줄(클릭 시 stash 부모 ↔ stash diff). */
  function stashFileHtml(ref, ch) {
    const slash = ch.path.lastIndexOf("/");
    const fileName = slash >= 0 ? ch.path.slice(slash + 1) : ch.path;
    const dir = slash >= 0 ? ch.path.slice(0, slash) : "";
    return (
      `<div class="row file stash-file" data-status="${esc(ch.status)}" ` +
      `data-ref="${esc(ref)}" data-path="${esc(ch.path)}" title="${esc(ch.path)}">` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(ch.status)}"></span>` +
      fileIconHtml(ch.path) +
      `<span class="name">${esc(fileName)}</span>` +
      (dir ? `<span class="dir">${esc(dir)}</span>` : "") +
      `</div>`
    );
  }

  /** stash 한 개(접기 헤더 + 펼치면 파일 목록). */
  function stashItemHtml(s) {
    const key = s.hash || s.ref || String(s.index || "");
    const expanded = state.stashExpanded[key] !== false;
    const chevron = expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const meta = [s.branch, s.date].filter(Boolean).join(" · ");
    const files = s.files.map((f) => stashFileHtml(s.ref, f)).join("");
    return (
      `<div class="stash${expanded ? "" : " collapsed"}" data-ref="${esc(s.ref)}" ` +
      `data-key="${esc(key)}" data-hash="${esc(s.hash)}" data-msg="${esc(s.message)}">` +
      `<div class="row stash-header" title="${esc(`${T.toggleSection}: ${s.message}`)}">` +
      `<span class="twistie codicon ${chevron}"></span>` +
      `<span class="icon codicon codicon-archive"></span>` +
      `<span class="name">${esc(s.message)}</span>` +
      (meta ? `<span class="stash-meta">${esc(meta)}</span>` : "") +
      `<span class="row-actions"><button class="row-action codicon codicon-ellipsis" ` +
      `type="button" data-act="stashMenu" title="${esc(T.moreActions)}" ` +
      `aria-label="${esc(T.moreActions)}"></button></span>` +
      `</div>` +
      `<div class="children stash-files">${files}</div></div>`
    );
  }

  /** Stashes 섹션 본문(stash 리스트, 없으면 안내). */
  function stashesBody(stashes) {
    if (!stashes.length) {
      return `<p class="empty">${esc(T.noStashes)}</p>`;
    }
    return stashes.map(stashItemHtml).join("");
  }

  /** stash 액션 메뉴 항목(Apply/Pop/Branch/Drop). 인라인 ... 및 우클릭 공용. */
  function stashMenuNodes(ref, message) {
    return [
      { label: T.applyStash, onClick: () => post("applyStash", { ref }) },
      { label: T.popStash, onClick: () => post("popStash", { ref }) },
      { separator: true },
      { label: T.branchStash, onClick: () => post("branchStash", { ref }) },
      { separator: true },
      { label: T.dropStash, onClick: () => post("dropStash", { ref, message }) },
    ];
  }

  /** webview → 확장 메시지 전송 단축 함수. */
  function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
  }

  /** 전체 화면을 그린다. */
  function render(p) {
    const transient = captureTransientUi();
    const previousCommitMessageRevision = state.commitMessageRevision || 0;
    closeDropdown();
    lastPayload = p;
    state.visibleSections = normalizeVisibleSections(p.visibleSections);
    currentFileIcons = (p.fileIcons && p.fileIcons.icons) || {};
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
        stashesBody(p.stashes || []),
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

    applyFileIconGlyphStyles();
    applyCollapse();
    bindEvents();
    applyResize();
    applySelection();
    window.__gscApplyWorkingOperation?.();
    restoreTransientUi(transient, previousCommitMessageRevision);
    state.commitMessageRevision = p.commit?.messageRevision || 0;
    vscode.setState(state);
  }

  /** 렌더 직전 사용자가 조작 중인 일시 상태를 캡처한다. */
  function captureTransientUi() {
    const active = document.activeElement;
    const focus =
      active && rootEl.contains(active)
        ? {
            id: active.id || "",
            value: typeof active.value === "string" ? active.value : undefined,
            selectionStart:
              typeof active.selectionStart === "number"
                ? active.selectionStart
                : undefined,
            selectionEnd:
              typeof active.selectionEnd === "number"
                ? active.selectionEnd
                : undefined,
          }
        : null;
    const sectionScroll = {};
    rootEl.querySelectorAll(".section").forEach((sec) => {
      const body = sec.querySelector(".section-body");
      if (body) {
        sectionScroll[sec.dataset.section] = {
          top: body.scrollTop,
          left: body.scrollLeft,
        };
      }
    });
    return {
      rootTop: rootEl.scrollTop,
      rootLeft: rootEl.scrollLeft,
      sectionScroll,
      focus,
    };
  }

  /** 렌더 후 입력 포커스/커서와 스크롤 위치를 되돌린다. */
  function restoreTransientUi(snapshot, previousCommitMessageRevision) {
    if (!snapshot) {
      return;
    }
    rootEl.scrollTop = snapshot.rootTop || 0;
    rootEl.scrollLeft = snapshot.rootLeft || 0;
    rootEl.querySelectorAll(".section").forEach((sec) => {
      const saved = snapshot.sectionScroll[sec.dataset.section];
      const body = sec.querySelector(".section-body");
      if (saved && body) {
        body.scrollTop = saved.top || 0;
        body.scrollLeft = saved.left || 0;
      }
    });
    if (!snapshot.focus?.id) {
      return;
    }
    const next = document.getElementById(snapshot.focus.id);
    if (!next) {
      return;
    }
    const commitRevision = lastPayload?.commit?.messageRevision || 0;
    const hasProgrammaticCommitMessage =
      next.id === "commit-msg" && commitRevision !== previousCommitMessageRevision;
    if (hasProgrammaticCommitMessage) {
      next.focus({ preventScroll: true });
      if (typeof next.setSelectionRange === "function") {
        const end = next.value.length;
        next.setSelectionRange(end, end);
      }
      return;
    }
    if (typeof snapshot.focus.value === "string" && "value" in next) {
      next.value = snapshot.focus.value;
      if (next.id === "commit-msg") {
        vscode.postMessage({
          type: "commitMessageChange",
          message: next.value,
        });
      }
    }
    next.focus({ preventScroll: true });
    if (
      typeof next.setSelectionRange === "function" &&
      snapshot.focus.selectionStart !== undefined &&
      snapshot.focus.selectionEnd !== undefined
    ) {
      next.setSelectionRange(
        snapshot.focus.selectionStart,
        snapshot.focus.selectionEnd
      );
    }
  }

  /** 섹션 접힘 상태를 DOM 에 반영한다. */
  function applyCollapse() {
    rootEl.querySelectorAll(".section").forEach((sec) => {
      const collapsed = isCollapsed(sec.dataset.section);
      sec.classList.toggle("collapsed", collapsed);
      const tw = sec.querySelector(".section-header .twistie");
      tw.classList.toggle("codicon-chevron-down", !collapsed);
      tw.classList.toggle("codicon-chevron-right", collapsed);
      syncDisclosureControl(sec.querySelector(":scope > .section-header"), !collapsed);
    });
  }

  /**
   * 섹션 높이를 flex-grow 가중치(px)로 배분하고, 펼친 섹션 사이에 리사이즈 핸들(sash)을 놓는다.
   * - flex-basis:0 + grow=px 라서 flexbox 가 비율대로 채우고 최소 높이(min-height)도 자동 처리한다.
   * - 사용자가 조절한 섹션은 저장된 px, 아니면 기본 가중치를 쓴다(내용 변화에 흔들리지 않게).
   * - 매 렌더/접힘 변경 후 호출해 새 DOM 에 다시 적용한다.
   */
  function applyResize() {
    const sections = Array.from(rootEl.querySelectorAll(".section"));
    const growable = []; // 크기조절(grow)에 참여하는 펼친 섹션(순서대로)
    sections.forEach((sec) => {
      const id = sec.dataset.section;
      if (sec.classList.contains("collapsed")) {
        sec.style.flex = `0 0 ${HEADER_H}px`;
        return;
      }
      if (id === "repos") {
        const body = sec.querySelector(".section-body");
        sec.style.flex = `0 0 ${HEADER_H + (body ? body.scrollHeight : 0)}px`;
        return;
      }
      const weight =
        state.sizes[id] > 0 ? state.sizes[id] : DEFAULT_WEIGHT[id] || 160;
      sec.style.flex = `${weight} 1 0`;
      growable.push(sec);
    });
    placeSashes(growable);
  }

  /** 인접한 두 크기조절 섹션 사이마다 sash 를 만들어 아래쪽 섹션 상단에 붙인다. */
  function placeSashes(growable) {
    rootEl.querySelectorAll(".sash").forEach((s) => s.remove());
    for (let k = 1; k < growable.length; k++) {
      const above = growable[k - 1];
      const below = growable[k];
      const sash = document.createElement("div");
      sash.className = "sash";
      sash.addEventListener("pointerdown", (e) =>
        startResize(e, sash, above, below)
      );
      below.insertBefore(sash, below.firstChild);
    }
  }

  /** sash 드래그: 위/아래 섹션 높이를 delta 만큼 주고받는다(각자 최소 높이로 클램프). */
  function startResize(e, sash, above, below) {
    e.preventDefault();
    e.stopPropagation();
    sash.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startA = above.getBoundingClientRect().height;
    const startB = below.getBoundingClientRect().height;
    // 드래그 중 나머지 크기조절 섹션이 흔들리지 않도록 현재 px 로 고정한다.
    rootEl.querySelectorAll(".section:not(.collapsed)").forEach((sec) => {
      sec.style.flex = `${sec.getBoundingClientRect().height} 1 0`;
    });
    sash.classList.add("active");
    document.body.classList.add("resizing");

    const onMove = (ev) => {
      let delta = ev.clientY - startY;
      delta = Math.max(delta, MIN_SECTION - startA);
      delta = Math.min(delta, startB - MIN_SECTION);
      above.style.flex = `${startA + delta} 1 0`;
      below.style.flex = `${startB - delta} 1 0`;
    };
    const onUp = () => {
      sash.releasePointerCapture(e.pointerId);
      sash.removeEventListener("pointermove", onMove);
      sash.removeEventListener("pointerup", onUp);
      sash.classList.remove("active");
      document.body.classList.remove("resizing");
      persistSizes();
    };
    sash.addEventListener("pointermove", onMove);
    sash.addEventListener("pointerup", onUp);
  }

  /** 크기조절 섹션들의 높이(px)를 저장한다(다음 렌더에서 비율 유지). */
  function persistSizes() {
    rootEl.querySelectorAll(".section:not(.collapsed)").forEach((sec) => {
      state.sizes[sec.dataset.section] = sec.getBoundingClientRect().height;
    });
    vscode.setState(state);
  }

  /** 폴더 접기/펼치기 또는 작업트리 폴더 선택을 연결한다. */
  function bindFolderToggle(el) {
    el.addEventListener("click", (e) => {
      if (suppressNextRowClick) {
        suppressNextRowClick = false;
        return;
      }
      if (el.closest(".wt-files") && !e.target.closest(".twistie, .icon")) {
        onWorkingRowClick(e, el);
        return;
      }
      toggleFolder(el);
    });
  }

  /**
   * 폴더 노드의 접힘 상태를 DOM 과 persisted webview state 에 반영한다.
   * @param el 접기/펼치기를 수행할 폴더 행
   */
  function toggleFolder(el) {
    const children = el.nextElementSibling;
    if (!children || !children.classList.contains("children")) {
      return;
    }
    const collapsed = children.classList.toggle("collapsed");
    state.folders[el.dataset.folderKey] = collapsed;
    vscode.setState(state);
    const twistie = el.querySelector(".twistie");
    const folderIcon = el.querySelector(".icon");
    twistie.classList.toggle("codicon-chevron-down", !collapsed);
    twistie.classList.toggle("codicon-chevron-right", collapsed);
    folderIcon.classList.toggle("codicon-folder-opened", !collapsed);
    folderIcon.classList.toggle("codicon-folder", collapsed);
  }

  /** 아코디언 섹션 헤더 드래그로 섹션 순서를 바꿀 수 있게 연결한다. */
  function bindSectionDrag() {
    rootEl.querySelectorAll(".section-header").forEach((header) => {
      header.draggable = true;
      header.addEventListener("dragstart", (e) => {
        if (e.target.closest(".header-actions")) {
          e.preventDefault();
          return;
        }
        const section = header.closest(".section");
        draggingSectionId = section.dataset.section;
        suppressHeaderClick = true;
        closeDropdown();
        section.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggingSectionId);
      });
      header.addEventListener("dragend", () => {
        clearSectionDropMarkers();
        rootEl.querySelector(".section.dragging")?.classList.remove("dragging");
        draggingSectionId = null;
        window.setTimeout(() => {
          suppressHeaderClick = false;
        }, 100);
      });
    });
    rootEl.querySelectorAll(".section").forEach((section) => {
      section.addEventListener("dragover", (e) => {
        if (!draggingSectionId || section.dataset.section === draggingSectionId) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        markSectionDrop(section, sectionDropSide(section, e.clientY));
      });
      section.addEventListener("dragleave", (e) => {
        if (!section.contains(e.relatedTarget)) {
          section.classList.remove("drop-before", "drop-after");
        }
      });
      section.addEventListener("drop", (e) => {
        if (!draggingSectionId || section.dataset.section === draggingSectionId) {
          return;
        }
        e.preventDefault();
        moveSection(draggingSectionId, section.dataset.section, sectionDropSide(section, e.clientY));
      });
    });
  }

  /** 드래그 중인 섹션을 대상 섹션 앞/뒤로 옮기고 순서를 저장한다. */
  function moveSection(sourceId, targetId, side) {
    const next = state.sectionOrder.filter((id) => id !== sourceId);
    const targetIndex = next.indexOf(targetId);
    if (targetIndex < 0) {
      return;
    }
    next.splice(side === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
    state.sectionOrder = normalizeSectionOrder(next);
    vscode.setState(state);
    for (const id of state.sectionOrder) {
      const section = rootEl.querySelector(`.section[data-section="${id}"]`);
      if (section) {
        rootEl.appendChild(section);
      }
    }
    clearSectionDropMarkers();
    applyResize();
    persistSizes();
  }

  /** 포인터 Y 위치가 섹션 위/아래 절반 중 어디인지 반환한다. */
  function sectionDropSide(section, clientY) {
    const rect = section.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  /** 섹션 drop 위치 표시선을 갱신한다. */
  function markSectionDrop(section, side) {
    clearSectionDropMarkers();
    section.classList.add(side === "before" ? "drop-before" : "drop-after");
  }

  /** 모든 섹션 drop 표시선을 제거한다. */
  function clearSectionDropMarkers() {
    rootEl.querySelectorAll(".drop-before, .drop-after").forEach((section) => {
      section.classList.remove("drop-before", "drop-after");
    });
  }

  /** 렌더 후 이벤트를 연결한다. */
  function bindEvents() {
    rootEl.querySelectorAll(".section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (suppressHeaderClick) {
          suppressHeaderClick = false;
          return;
        }
        // 헤더 우측 액션(토글/미트볼) 클릭은 접힘과 분리한다.
        if (e.target.closest(".header-actions")) {
          return;
        }
        toggleSection(h.parentElement.dataset.section);
        applyCollapse();
        applyResize();
      });
    });
    bindSectionDrag();
    // 미트볼(...) → 섹션별 액션 + 아코디언 카테고리 토글 메뉴(다시 누르면 닫힘 토글).
    rootEl.querySelectorAll(".meatball").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdownEl && dropdownEl.__anchor === el) {
          closeDropdown();
        } else {
          const section = el.closest(".section");
          openDropdown(
            el,
            accordionMenuNodes(section ? section.dataset.section : undefined)
          );
        }
      });
    });
    rootEl.querySelectorAll(".repo").forEach((el) => {
      el.addEventListener("click", () =>
        vscode.postMessage({ type: "selectRepo", root: el.dataset.root })
      );
    });
    window.__gscCompare.bind(rootEl, vscode);
    rootEl.querySelectorAll(".row.folder").forEach(bindFolderToggle);
    // 작업트리 변경 파일 → 단일 클릭=선택+비교, Ctrl/Cmd·Shift=다중 선택
    rootEl.querySelectorAll(".wt-files .row.file").forEach((el) => {
      el.addEventListener("click", (e) => onWorkingRowClick(e, el));
    });
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
    bindRowActions();
    bindHistory();
    bindStashes();
    window.__gscWorktrees?.bind?.(rootEl, vscode);
  }

  /** History 섹션: 커밋 상세 펼침/접기와 상세 파일 링크(diff 열기)를 연결한다. */
  function bindHistory() {
    const open = (el) =>
      post("openFileHistoryCommit", {
        repoRoot: el.dataset.repoRoot,
        path: el.dataset.path,
        oldPath: el.dataset.oldPath || undefined,
        baseRef: el.dataset.baseRef,
        headRef: el.dataset.headRef,
        shortHash: el.dataset.shortHash,
        title: el.dataset.title,
      });
    rootEl.querySelectorAll(".history-commit").forEach((el) => {
      el.addEventListener("click", () => toggleHistoryItem(el));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleHistoryItem(el);
        }
      });
    });
    rootEl.querySelectorAll(".history-file-link").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        open(el);
      });
    });
  }

  /** History 커밋 상세의 펼침 상태를 토글한다. */
  function toggleHistoryItem(el) {
    const item = el.closest(".history-item");
    const key = item?.dataset.key || el.dataset.key;
    if (!item || !key) {
      return;
    }
    const expanded = !state.historyExpanded[key];
    state.historyExpanded[key] = expanded;
    vscode.setState(state);
    item.classList.toggle("collapsed", !expanded);
    el.setAttribute("aria-expanded", expanded ? "true" : "false");
    const tw = el.querySelector(".twistie");
    tw.classList.toggle("codicon-chevron-down", expanded);
    tw.classList.toggle("codicon-chevron-right", !expanded);
  }

  /** Stashes 섹션: 펼치기/접기, 액션 메뉴(...), 파일 클릭(diff), 우클릭 메뉴. */
  function bindStashes() {
    // stash 헤더 클릭 → 펼치기/접기(액션은 제외)
    rootEl.querySelectorAll(".stash-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest(".row-actions")) {
          return;
        }
        const stash = h.closest(".stash");
        const key = stash.dataset.key || stash.dataset.ref || stash.dataset.hash;
        const wasExpanded = state.stashExpanded[key] !== false;
        const expanded = !wasExpanded;
        state.stashExpanded[key] = expanded;
        vscode.setState(state);
        stash.classList.toggle("collapsed", !expanded);
        const tw = h.querySelector(".twistie");
        tw.classList.toggle("codicon-chevron-down", expanded);
        tw.classList.toggle("codicon-chevron-right", !expanded);
      });
      // 우클릭 → stash 액션 메뉴
      h.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const stash = h.closest(".stash");
        openContextMenu(
          e.clientX,
          e.clientY,
          stashMenuNodes(stash.dataset.ref, stash.dataset.msg)
        );
      });
    });
    // stash 행의 ... 아이콘 → 액션 메뉴(앵커 드롭다운)
    rootEl.querySelectorAll('.stash .row-action[data-act="stashMenu"]').forEach(
      (el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const stash = el.closest(".stash");
          if (dropdownEl && dropdownEl.__anchor === el) {
            closeDropdown();
          } else {
            openDropdown(el, stashMenuNodes(stash.dataset.ref, stash.dataset.msg));
          }
        });
      }
    );
    // stash 안 파일 클릭 → stash 부모 ↔ stash diff
    rootEl.querySelectorAll(".stash-file").forEach((el) => {
      el.addEventListener("click", () =>
        post("openStashFile", { ref: el.dataset.ref, path: el.dataset.path })
      );
    });
  }

  // ── 커밋 박스 ──

  /** 커밋 입력/버튼/캐럿을 연결한다. */
  // 커밋 진행 상태. extension host 의 commitOperation 메시지로 갱신되며, 재렌더 후에도 다시 반영한다.
  let commitInProgress = false;

  function bindCommitBox() {
    const ta = document.getElementById("commit-msg");
    if (ta) {
      autoGrow(ta);
      ta.addEventListener("input", () => {
        autoGrow(ta);
        vscode.postMessage({ type: "commitMessageChange", message: ta.value });
      });
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          doCommit("commit");
        }
      });
    }
    const btn = document.getElementById("commit-btn");
    if (btn) {
      btn.addEventListener("click", () => doCommit("commit"));
    }
    const caret = document.getElementById("commit-caret");
    if (caret) {
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdownEl && dropdownEl.__anchor === caret) {
          closeDropdown();
        } else {
          openDropdown(caret, commitMenuNodes());
        }
      });
    }
    // 재렌더로 버튼이 새로 만들어졌을 수 있으므로 현재 진행 상태를 다시 반영한다.
    reflectCommitBusy();
  }

  /** 커밋 버튼/캐럿에 진행중 스피너(.busy)와 비활성 상태를 반영한다. */
  function reflectCommitBusy() {
    const btn = document.getElementById("commit-btn");
    if (btn) {
      btn.classList.toggle("busy", commitInProgress);
      btn.disabled = commitInProgress;
    }
    const caret = document.getElementById("commit-caret");
    if (caret) {
      caret.disabled = commitInProgress;
    }
  }

  /** extension host 의 커밋 진행 상태를 버튼에 반영한다. */
  function setCommitInProgress(active) {
    commitInProgress = !!active;
    reflectCommitBusy();
  }

  /** 현재 메시지로 커밋을 요청한다. 진행 중이면 중복 실행을 막는다. */
  function doCommit(op) {
    if (commitInProgress) {
      return;
    }
    const ta = document.getElementById("commit-msg");
    vscode.postMessage({ type: "commit", op, message: ta ? ta.value : "" });
  }

  /** 커밋 캐럿(▼) 드롭다운: 커밋 변형 + Stage/Unstage/Discard All + Stash(주입 메뉴). */
  function commitMenuNodes() {
    return COMMIT_MENU;
  }

  /** textarea 높이를 내용에 맞춰 늘린다(상한 200px). */
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  // ── 그룹/행 인라인 액션 ──

  /** 그룹 헤더의 전체 stage/unstage/discard 액션(경로 없이 → 전체). */
  function bindGroupActions() {
    rootEl.querySelectorAll(".group-action").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        postWorkingAction(el.dataset.gact);
      });
    });
    // 그룹 헤더 클릭 → 그 그룹만 접기/펼치기(액션 클릭은 제외).
    rootEl.querySelectorAll(".group-toggle").forEach((toggle) => {
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
  }

  /** 파일/폴더 행 hover 액션(파일 열기 / stage·unstage·discard). 다중 선택 시 선택 전체에 적용. */
  function bindRowActions() {
    rootEl.querySelectorAll(".row-action").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        // stash 의 ... 메뉴는 bindStashes 에서 따로 처리한다.
        if (el.dataset.act === "stashMenu") {
          return;
        }
        const row = el.closest(".row");
        if (el.dataset.act === "openFile") {
          vscode.postMessage({ type: "openFile", path: row.dataset.path });
          return;
        }
        if (el.dataset.act === "openCompareDiff") {
          vscode.postMessage({ type: "openDiff", path: row.dataset.path });
          return;
        }
        const paths = actionPaths(row);
        if (paths.length) {
          postWorkingAction(el.dataset.act, paths);
        }
      });
    });
    // 작업트리 행 우클릭 → 컨텍스트 메뉴(파일 열기/변경 비교/stage·unstage·discard)
    rootEl.querySelectorAll(".wt-files .row").forEach((row) => {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        // 선택에 없는 행을 우클릭하면 그 행만 단일 선택으로 바꾼다(VS Code 처럼).
        if (!selection.has(rowKey(row))) {
          selection = new Set([rowKey(row)]);
          selAnchor = rowKey(row);
          applySelection();
        }
        const group = row.closest(".group");
        const kind = group ? group.dataset.gkey : "unstaged";
        openContextMenu(e.clientX, e.clientY, rowContextNodes(row, kind));
      });
    });
  }

  /** 행 우클릭 컨텍스트 메뉴 항목(파일이면 열기/비교 + stage 류, 폴더면 stage 류). */
  function rowContextNodes(row, kind) {
    const nodes = [];
    if (row.classList.contains("file")) {
      const path = row.dataset.path;
      nodes.push({
        label: T.openFile,
        onClick: () => vscode.postMessage({ type: "openFile", path }),
      });
      nodes.push({
        label: T.openChanges,
        onClick: () => openWorkingPath(path, kind, row.dataset.status),
      });
      nodes.push({ separator: true });
    }
    const paths = actionPaths(row);
    if (kind === "staged") {
      nodes.push({
        label: T.unstage,
        onClick: () => postWorkingAction("unstage", paths),
      });
    } else {
      nodes.push({
        label: T.stage,
        onClick: () => postWorkingAction("stage", paths),
      });
      nodes.push({
        label: T.discard,
        onClick: () => vscode.postMessage({ type: "discard", paths }),
      });
    }
    nodes.push({ separator: true });
    const ignoreTargets = ignorePaths(row);
    if (ignoreTargets.length) {
      nodes.push({
        label: T.addToGitignore,
        onClick: () =>
          vscode.postMessage({ type: "addToGitignore", paths: ignoreTargets }),
      });
      nodes.push({
        label: T.addToExclude,
        onClick: () =>
          vscode.postMessage({ type: "addToExclude", paths: ignoreTargets }),
      });
      nodes.push({ separator: true });
    }
    nodes.push({
      label: T.stashSelected,
      onClick: () => vscode.postMessage({ type: "stashSelected", paths }),
    });
    return nodes;
  }

  /** 행이 가리키는 경로들(파일=자신, 폴더=다음 .children 안 모든 파일). */
  function rowPaths(row) {
    if (row.classList.contains("file")) {
      return [row.dataset.path];
    }
    const children = row.nextElementSibling;
    if (!children || !children.classList.contains("children")) {
      return [];
    }
    return Array.from(children.querySelectorAll(".row.file")).map(
      (f) => f.dataset.path
    );
  }

  /** ignore/exclude 컨텍스트 메뉴의 대상 경로. 폴더는 파일로 펼치지 않고 폴더 패턴으로 보낸다. */
  function ignorePaths(row) {
    if (row.classList.contains("folder")) {
      const path = row.dataset.path || "";
      return path ? [path.endsWith("/") ? path : path + "/"] : [];
    }
    return actionPaths(row);
  }

  // ── 다중 선택(작업트리 파일/폴더, VS Code 트리처럼 Ctrl/Cmd·Shift 선택) ──

  let selection = new Set(); // 선택된 행 키("gkey:path") 집합(렌더 간 유지, 사라진 키는 정리)
  let selAnchor = null; // Shift 범위 선택의 기준 키
  let suppressNextRowClick = false; // 드래그 선택 후 발생하는 synthetic click 억제
  let marquee = null; // 현재 진행 중인 사각형 드래그 선택 상태
  // 마퀴 드래그를 시작하면 안 되는(고유 동작이 있는) 요소들. 이 밖의 영역(빈 공간/행 본문)에서는 드래그로 selectbox 를 그린다.
  const MARQUEE_EXCLUDE_SELECTOR =
    ".commit-box, .group-header, .header-actions, .row-actions, button, textarea, input, select, a";

  /** 행의 선택 키(소속 그룹 + 경로). */
  function rowKey(row) {
    const group = row.closest(".group");
    return (group ? group.dataset.gkey : "") + ":" + row.dataset.path;
  }

  /** 작업트리에서 선택 가능한 파일/폴더 행들을 DOM 순서로 반환한다. */
  function selectableRows() {
    return Array.from(
      rootEl.querySelectorAll(".wt-files .row.file, .wt-files .row.folder")
    );
  }

  /**
   * 파일 목록 표면(Changes 섹션 본문)에 드래그 사각형 선택을 연결한다.
   * - 실제 드래그로 판단될 때까지 클릭 이벤트를 방해하지 않는다.
   * - Ctrl/Cmd 를 누른 채 드래그하면 기존 선택에 영역 안 파일/폴더를 더한다.
   * - 커밋 박스/헤더/액션 버튼 등 상호작용 요소에서 시작한 드래그는 그 요소의 동작을 위해 제외한다.
   */
  function bindMarqueeSelection(filesEl) {
    filesEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(MARQUEE_EXCLUDE_SELECTOR)) {
        return;
      }
      marquee = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        additive: e.metaKey || e.ctrlKey,
        baseSelection: new Set(selection),
        active: false,
        box: null,
        lastKey: null,
      };
    });
    filesEl.addEventListener("pointermove", (e) => {
      if (!marquee || marquee.pointerId !== e.pointerId) {
        return;
      }
      const dx = e.clientX - marquee.startX;
      const dy = e.clientY - marquee.startY;
      if (!marquee.active && Math.hypot(dx, dy) < 4) {
        return;
      }
      e.preventDefault();
      if (!marquee.active) {
        startMarquee(filesEl, e.pointerId);
      }
      updateMarquee(e.clientX, e.clientY);
    });
    filesEl.addEventListener("pointerup", (e) => finishMarquee(filesEl, e));
    filesEl.addEventListener("pointercancel", (e) => cancelMarquee(filesEl, e));
  }

  /** 사각형 선택 표시를 시작한다. */
  function startMarquee(filesEl, pointerId) {
    if (!marquee) {
      return;
    }
    closeDropdown();
    marquee.active = true;
    filesEl.setPointerCapture(pointerId);
    marquee.box = document.createElement("div");
    marquee.box.className = "selection-marquee";
    document.body.appendChild(marquee.box);
    document.body.classList.add("marquee-selecting");
  }

  /**
   * 현재 포인터 위치에 맞춰 사각형을 그리고, 영역과 겹치는 파일/폴더 행을 선택한다.
   * @param x 현재 포인터 clientX
   * @param y 현재 포인터 clientY
   */
  function updateMarquee(x, y) {
    if (!marquee?.box) {
      return;
    }
    const rect = normalizedRect(marquee.startX, marquee.startY, x, y);
    Object.assign(marquee.box.style, {
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
    const hitKeys = [];
    for (const row of selectableRows()) {
      if (rectsOverlap(rect, row.getBoundingClientRect())) {
        hitKeys.push(rowKey(row));
      }
    }
    selection = marquee.additive
      ? new Set([...marquee.baseSelection, ...hitKeys])
      : new Set(hitKeys);
    marquee.lastKey = hitKeys.length ? hitKeys[hitKeys.length - 1] : null;
    applySelection();
  }

  /** 사각형 선택을 정상 종료하고 click 억제 상태를 유지한다. */
  function finishMarquee(filesEl, e) {
    if (!marquee || marquee.pointerId !== e.pointerId) {
      return;
    }
    if (marquee.active) {
      e.preventDefault();
      e.stopPropagation();
      if (marquee.lastKey) {
        selAnchor = marquee.lastKey;
      }
      blockMarqueeClick();
    }
    cleanupMarquee(filesEl, e.pointerId);
  }

  /** 사각형 선택이 취소되면 드래그 전 선택으로 되돌린다. */
  function cancelMarquee(filesEl, e) {
    if (!marquee || marquee.pointerId !== e.pointerId) {
      return;
    }
    if (marquee.active) {
      selection = new Set(marquee.baseSelection);
      applySelection();
      suppressNextRowClick = false;
    }
    cleanupMarquee(filesEl, e.pointerId);
  }

  /** 사각형 DOM 과 pointer capture 를 정리한다. */
  function cleanupMarquee(filesEl, pointerId) {
    if (filesEl.hasPointerCapture(pointerId)) {
      filesEl.releasePointerCapture(pointerId);
    }
    if (marquee?.box) {
      marquee.box.remove();
    }
    document.body.classList.remove("marquee-selecting");
    marquee = null;
  }

  /** 드래그 선택 직후 브라우저가 만드는 click 하나만 파일 트리 안에서 차단한다. */
  function blockMarqueeClick() {
    suppressNextRowClick = true;
    const clear = () => {
      suppressNextRowClick = false;
      window.removeEventListener("click", onClick, true);
    };
    const onClick = (e) => {
      if (e.target.closest(".wt-files")) {
        e.preventDefault();
        e.stopPropagation();
      }
      clear();
    };
    window.addEventListener("click", onClick, true);
    window.setTimeout(clear, 100);
  }

  /** 두 좌표로 CSS/충돌 검사에 쓰는 정규화된 사각형을 만든다. */
  function normalizedRect(startX, startY, endX, endY) {
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const right = Math.max(startX, endX);
    const bottom = Math.max(startY, endY);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  /** 두 client rect 가 조금이라도 겹치는지 확인한다. */
  function rectsOverlap(a, b) {
    return (
      a.left <= b.right &&
      a.right >= b.left &&
      a.top <= b.bottom &&
      a.bottom >= b.top
    );
  }

  /** 현재 선택을 DOM 에 반영하고, 더 이상 없는 키는 정리한다. */
  function applySelection() {
    const rows = selectableRows();
    const present = new Set(rows.map(rowKey));
    for (const k of selection) {
      if (!present.has(k)) {
        selection.delete(k);
      }
    }
    rows.forEach((row) => {
      const selected = selection.has(rowKey(row));
      row.classList.toggle("selected", selected);
      row.classList.toggle("single-selected", selected && selection.size === 1);
    });
  }

  /** anchor~target 사이 행들을 선택한다(Shift 범위). */
  function selectRange(targetKey) {
    const keys = selectableRows().map(rowKey);
    const a = selAnchor ? keys.indexOf(selAnchor) : -1;
    const b = keys.indexOf(targetKey);
    if (a < 0 || b < 0) {
      selection = new Set([targetKey]);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    selection = new Set(keys.slice(lo, hi + 1));
  }

  /** 선택된 행 중 특정 그룹(gkey)의 실제 파일 경로들을 중복 없이 반환한다. */
  function selectedPathsOfKind(gkey) {
    const prefix = gkey + ":";
    const rowsByKey = new Map(
      selectableRows().map((row) => [rowKey(row), row])
    );
    const seen = new Set();
    const out = [];
    for (const k of selection) {
      if (k.startsWith(prefix)) {
        const row = rowsByKey.get(k);
        if (!row) {
          continue;
        }
        for (const path of rowPaths(row)) {
          if (path && !seen.has(path)) {
            seen.add(path);
            out.push(path);
          }
        }
      }
    }
    return out;
  }

  /** 작업트리 행 클릭: Ctrl/Cmd=토글, Shift=범위, 파일 일반 클릭=단일 선택 + 비교 열기. */
  function onWorkingRowClick(e, row) {
    if (suppressNextRowClick) {
      suppressNextRowClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const key = rowKey(row);
    if (e.metaKey || e.ctrlKey) {
      if (selection.has(key)) {
        selection.delete(key);
      } else {
        selection.add(key);
      }
      selAnchor = key;
      applySelection();
    } else if (e.shiftKey) {
      selectRange(key);
      applySelection();
    } else {
      selection = new Set([key]);
      selAnchor = key;
      applySelection();
      if (row.classList.contains("file")) {
        openWorkingPath(row.dataset.path, row.dataset.stage, row.dataset.status);
      }
    }
  }

  /** 작업트리 파일 열기: 충돌은 resolver, 그 외 staged/unstaged 는 editable diff 로 연다. */
  function openWorkingPath(path, stage, status) {
    vscode.postMessage({ type: "openWorkingChange", path, stage, status });
  }

  /**
   * 행 액션/컨텍스트의 대상 경로.
   * - 클릭한 행이 다중 선택(2개 이상)에 포함되면 같은 그룹의 선택 경로 전체,
   *   아니면 그 행(파일=자신, 폴더=하위 전부).
   */
  function actionPaths(row) {
    const group = row.closest(".group");
    const gkey = group ? group.dataset.gkey : "";
    if (selection.has(rowKey(row)) && selection.size > 1) {
      return selectedPathsOfKind(gkey);
    }
    return rowPaths(row);
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

  // ── 미트볼/커밋 드롭다운(드릴다운) ──

  let dropdownEl = null;

  /** 바깥 mousedown 이면 닫는다(앵커/메뉴 내부는 제외). */
  function onDocDown(e) {
    if (!dropdownEl) {
      return;
    }
    const a = dropdownEl.__anchor;
    if (
      dropdownEl.contains(e.target) ||
      (a && (a === e.target || a.contains(e.target)))
    ) {
      return;
    }
    closeDropdown();
  }

  /** Escape 로 닫는다. */
  function onDocKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
    }
  }

  /** 열린 드롭다운을 닫고 리스너를 정리한다. */
  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.__anchor?.setAttribute("aria-expanded", "false");
      dropdownEl.remove();
      dropdownEl = null;
    }
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
  }

  /** 구분선 요소. */
  function menuDivider() {
    const d = document.createElement("div");
    d.className = "menu-sep";
    d.setAttribute("role", "separator");
    return d;
  }

  /**
   * div 기반 menuitem 이 Enter/Space 키로도 마우스 클릭과 같은 동작을 수행하게 한다.
   * @param {HTMLElement} item 키보드 활성화를 연결할 메뉴 항목
   */
  function bindMenuItemKeyboard(item) {
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        item.click();
      }
    });
  }

  /** 앵커(헤더 버튼) 아래에 드롭다운을 연다. */
  function openDropdown(anchor, rootNodes) {
    openMenu(rootNodes, { anchor });
  }

  /** 마우스 좌표에 컨텍스트 메뉴를 연다(우클릭). */
  function openContextMenu(x, y, rootNodes) {
    openMenu(rootNodes, { x, y });
  }

  /**
   * 메뉴를 연다. 하위 메뉴는 같은 자리에서 드릴다운한다(좁은 사이드바에서 플라이아웃보다 안정적).
   * - place.anchor 면 그 버튼 아래에, {x,y} 면 그 좌표에 배치한다.
   * - 리프는 node.onClick(직접 실행) 또는 node.id(scmAction 위임) 중 하나로 동작한다.
   */
  function openMenu(rootNodes, place) {
    closeDropdown();
    dropdownEl = document.createElement("div");
    dropdownEl.className = "menu";
    dropdownEl.setAttribute("role", "menu");
    dropdownEl.__anchor = place.anchor || null;
    dropdownEl.__anchor?.setAttribute("aria-expanded", "true");
    document.body.appendChild(dropdownEl);

    const reposition = () =>
      place.anchor
        ? positionMenu(place.anchor.getBoundingClientRect(), true)
        : positionMenu({ left: place.x, right: place.x, top: place.y, bottom: place.y }, false);

    const stack = [{ nodes: rootNodes, title: null }];
    const renderTop = () => {
      const top = stack[stack.length - 1];
      dropdownEl.innerHTML = "";
      if (stack.length > 1) {
        const back = document.createElement("div");
        back.className = "menu-item menu-back";
        back.setAttribute("role", "menuitem");
        back.tabIndex = 0;
        back.title = top.title || "";
        back.innerHTML =
          `<span class="codicon codicon-chevron-left"></span>` +
          `<span class="menu-label">${esc(top.title || "")}</span>`;
        back.addEventListener("click", (e) => {
          e.stopPropagation();
          stack.pop();
          renderTop();
          reposition();
        });
        bindMenuItemKeyboard(back);
        dropdownEl.appendChild(back);
        dropdownEl.appendChild(menuDivider());
      }
      for (const node of top.nodes) {
        if (node.separator) {
          dropdownEl.appendChild(menuDivider());
          continue;
        }
        const hasSub = !!(node.submenu && node.submenu.length);
        const item = document.createElement("div");
        item.className = "menu-item";
        item.setAttribute("role", "menuitem");
        item.tabIndex = 0;
        if (hasSub) {
          item.setAttribute("aria-haspopup", "menu");
        }
        item.title = node.label || "";
        item.innerHTML =
          `<span class="menu-check codicon ${
            node.checked ? "codicon-check" : ""
          }"></span>` +
          `<span class="menu-label">${esc(node.label || "")}</span>` +
          (hasSub
            ? `<span class="menu-sub codicon codicon-chevron-right"></span>`
            : "");
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (hasSub) {
            stack.push({ nodes: node.submenu, title: node.label });
            renderTop();
            reposition();
          } else if (node.onClick) {
            node.onClick();
            closeDropdown();
          } else if (node.id) {
            vscode.postMessage({ type: "scmAction", action: node.id });
            closeDropdown();
          }
        });
        bindMenuItemKeyboard(item);
        dropdownEl.appendChild(item);
      }
      dropdownEl.querySelector('[role="menuitem"]')?.focus();
    };
    renderTop();
    reposition();
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onDocKey, true);
  }

  /**
   * 드롭다운을 기준 사각형에 맞춰 배치한다(화면 밖이면 위/안쪽으로 보정).
   * @param r        기준 사각형({left,right,top,bottom})
   * @param rightAlign true 면 오른쪽 정렬(헤더 버튼), false 면 왼쪽 정렬(컨텍스트 메뉴)
   */
  function positionMenu(r, rightAlign) {
    if (!dropdownEl) {
      return;
    }
    dropdownEl.style.position = "fixed";
    dropdownEl.style.visibility = "hidden";
    dropdownEl.style.left = "0px";
    dropdownEl.style.top = "0px";
    const m = dropdownEl.getBoundingClientRect();
    let left = rightAlign ? r.right - m.width : r.left;
    left = Math.min(left, window.innerWidth - 4 - m.width);
    if (left < 4) {
      left = 4;
    }
    let top = r.bottom + 2;
    if (top + m.height > window.innerHeight - 4) {
      top = r.top - m.height - 2;
      if (top < 4) {
        top = Math.max(4, window.innerHeight - 4 - m.height);
      }
    }
    dropdownEl.style.left = left + "px";
    dropdownEl.style.top = top + "px";
    dropdownEl.style.visibility = "visible";
  }

  window.addEventListener("message", (event) => {
    if (event.data.type === "render") {
      render(event.data.payload);
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

  vscode.postMessage({ type: "ready" });
})();
