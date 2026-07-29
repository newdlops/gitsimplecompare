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
      openHistoryCommit: "Open File Change",
      stashes: "Stashes",
      stashSelected: "Stash Selected Changes",
      worktrees: "Worktrees",
    },
    window.__gscCompare?.defaults || {},
    window.__gscI18n || {}
  );

  let state = vscode.getState() || {};
  state.collapsed = state.collapsed || {};
  // 새 웹뷰의 Worktrees는 기본 접힘으로 두고 실제로 펼칠 때만 별도 git worktree 조회를 시작한다.
  if (!Object.prototype.hasOwnProperty.call(state.collapsed, "worktrees")) {
    state.collapsed.worktrees = true;
  }
  state.sizes = state.sizes || {};
  state.groups = state.groups || {}; // Staged/Changes 그룹 접힘 상태
  state.folders = state.folders || {}; // 파일 트리 폴더 접힘 상태(kind:path)
  state.stashExpanded = state.stashExpanded || {}; // stash 펼침 상태(ref/hash별)
  state.historyExpanded = state.historyExpanded || {}; // history 커밋 상세 펼침 상태(hash별)
  state.commitMessageRevision = state.commitMessageRevision || 0;
  const SECTION_IDS = [
    "repos",
    "changes",
    "history",
    "compare",
    "stashes",
    "worktrees",
  ];
  state.sectionOrder = normalizeSectionOrder(state.sectionOrder);
  state.visibleSections = normalizeVisibleSections(state.visibleSections);
  let currentFileIcons = {};
  let lastPayload = null;
  const loadedFileIconFonts = new Set();
  let worktreesRequested = false;
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
      // 확장된 본문은 native 키보드 스크롤을 위해 직접 Tab으로 포커스할 수 있다.
      `<div id="section-body-${esc(id)}" class="section-body" tabindex="0">${bodyHtml}</div></div>`
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
          `<div class="row repo${r.active ? " active" : ""}" role="button" tabindex="0" ` +
          `data-root="${esc(r.root)}" title="${esc(r.root)}" aria-label="${esc(
            `${T.change}: ${r.name}`
          )}">` +
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
        `<div class="row folder${conflictCount ? " conflict" : ""}" role="button" tabindex="0" ` +
        `aria-expanded="${collapsed ? "false" : "true"}" data-folder-key="${esc(key)}" ` +
        `data-path="${esc(node.path)}" title="${esc(title)}" aria-label="${esc(title)}">` +
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
      `<div class="row file${conflicted ? " conflict" : ""}"${
        kind === "compare"
          ? ""
          : ` role="button" tabindex="0" aria-label="${esc(title)}"`
      } data-status="${esc(ch.status)}" ` +
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
      `<textarea id="commit-msg" class="commit-input" name="commit-message" autocomplete="off" rows="1" ` +
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

  /** webview → 확장 메시지 전송 단축 함수. */
  function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
  }

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
        window.__gscStashes?.body?.(p.stashes || [], {
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
    currentFileIcons = Object.assign(
      {},
      currentFileIcons,
      (delta.fileIcons && delta.fileIcons.icons) || {}
    );
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
    applyFileIconGlyphStyles();
    body.querySelectorAll(".row.folder").forEach(bindFolderToggle);
    body.querySelectorAll(".wt-files .row.file").forEach((el) => {
      el.addEventListener("click", (event) => onWorkingRowClick(event, el));
      bindRowKeyboardAction(el, (event) => onWorkingRowClick(event, el));
    });
    bindMarqueeSelection(body);
    bindCommitBox(body);
    bindGroupActions(body);
    bindRowActions(body);
    applyResize();
    applySelection();
    window.__gscApplyWorkingOperation?.();
    restoreTransientUi(transient, previousCommitMessageRevision);
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

  // collapse와 sash resize는 section layout 모듈이 일관된 persisted state로 적용한다.
  const { applyCollapse, applyResize, persistSizes } = window.__gscChangesSectionLayout({
    rootEl,
    state,
    isCollapsed,
    syncDisclosureControl,
    HEADER_H,
    MIN_SECTION,
    DEFAULT_WEIGHT,
    strings: T,
    vscode,
  });

  /** 폴더 접기/펼치기 또는 작업트리 폴더 선택을 연결한다. */
  function bindFolderToggle(el) {
    el.addEventListener("click", (e) => {
      if (consumeSuppressedRowClick()) {
        return;
      }
      if (el.closest(".wt-files") && !e.target.closest(".twistie, .icon")) {
        onWorkingRowClick(e, el);
        return;
      }
      toggleFolder(el);
    });
    bindRowKeyboardAction(el, () => toggleFolder(el));
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
    el.setAttribute("aria-expanded", collapsed ? "false" : "true");
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
    const source = rootEl.querySelector(`.section[data-section="${sourceId}"]`);
    const target = rootEl.querySelector(`.section[data-section="${targetId}"]`);
    if (!window.__gscChangesInformationArchitecture?.sameRegion(source, target)) {
      clearSectionDropMarkers();
      return;
    }
    const next = state.sectionOrder.filter((id) => id !== sourceId);
    const targetIndex = next.indexOf(targetId);
    if (targetIndex < 0) {
      return;
    }
    next.splice(side === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
    state.sectionOrder = normalizeSectionOrder(next);
    vscode.setState(state);
    const region = source.parentElement;
    for (const id of state.sectionOrder) {
      const section = rootEl.querySelector(`.section[data-section="${id}"]`);
      if (section && section.parentElement === region) {
        region.appendChild(section);
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
        window.__gscStashes?.requestExpanded?.(rootEl, vscode);
        requestExpandedWorktrees();
        applyResize();
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
            accordionMenuNodes(section ? section.dataset.section : undefined)
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
    rootEl.querySelectorAll(".row.folder").forEach(bindFolderToggle);
    // 작업트리 변경 파일 → 단일 클릭=선택+비교, Ctrl/Cmd·Shift=다중 선택
    rootEl.querySelectorAll(".wt-files .row.file").forEach((el) => {
      el.addEventListener("click", (e) => onWorkingRowClick(e, el));
      bindRowKeyboardAction(el, (event) => onWorkingRowClick(event, el));
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
  const { closeDropdown, isDropdownAnchor, openDropdown, openContextMenu } = window.__gscChangesMenu({
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

  // 다중 선택, Shift range, 마퀴 드래그는 전용 모듈이 state와 DOM을 함께 소유한다.
  const { actionPaths, applySelection, bindMarqueeSelection, consumeSuppressedRowClick, isSelected, onWorkingRowClick, selectOnly } = window.__gscChangesTreeSelection({
    rootEl,
    closeDropdown,
    openWorkingPath,
    rowPaths,
  });

  // 행 action의 DOM 이벤트와 선택 상태 전환은 전용 모듈에 맡긴다.
  const { bindRowActions } = window.__gscChangesWorkingTreeActions({
    actionPaths,
    isSelected,
    openContextMenu,
    postWorkingAction,
    rowContextNodes,
    selectOnly,
    vscode,
  });

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
