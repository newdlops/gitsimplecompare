// Changes의 HTML 조각과 파일 아이콘 표현. 상태 조정·이벤트 연결은 메인 모듈에 남긴다.
(function () {
  "use strict";
  /** 상태와 지연 목록 getter를 받아 재사용 가능한 표현 함수를 만든다. Git/host 작업을 실행하지 않는다. */
  window.__gscChangesPresentation = function createChangesPresentation({ rootEl, state, strings: T, isCollapsed, disclosureTooltip, getWorkingList }) {
    let currentFileIcons = {};
    const loadedFileIconFonts = new Set();
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

    /**
     * glyph 기반 파일 아이콘에 동적 글꼴/색/크기를 적용한다.
     * @param {ParentNode} scope 적용할 DOM 범위. 가상 스크롤로 새로 그린 행만 넘기면 전체를 다시 훑지 않는다
     */
    function applyFileIconGlyphStyles(scope = rootEl) {
      scope.querySelectorAll(".theme-file-icon-glyph").forEach((el) => {
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
      return window.__gscChangesOnboarding.repositoriesHtml(repos, T, esc);
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
        // 파일 행은 가상 스크롤 목록이 mount 뒤 보이는 범위만 그린다.
        getWorkingList().groupFilesHtml(kind, nodes, viewMode, bodyId) +
        `</div>`
      );
    }

    /** Changes 섹션 본문(커밋 박스 + Staged 그룹 + Changes 그룹). */
    function changesBody(changes, commit, viewMode) {
      getWorkingList().beginRender();
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
    return { esc, statusCodicon, fileIconHtml, loadFileIconFonts, applyFileIconGlyphStyles, statHtml, countFiles, countConflicts, conflictBadgeHtml, section, reposBody, rowActionsHtml, sectionActions, changesBody,
      /** 새 payload의 전체 아이콘 색인을 교체한다. */
      setFileIcons: (icons) => { currentFileIcons = icons; },
      /** 작업트리 delta가 준 아이콘만 기존 비교/히스토리 색인에 합친다. */
      mergeFileIcons: (icons) => { Object.assign(currentFileIcons, icons); },
    };
  };
})();
