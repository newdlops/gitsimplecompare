// Changes 웹뷰의 브랜치 비교 섹션 렌더링과 사용자 이벤트를 전담한다.
// - 메인 아코디언/작업트리 로직과 분리하고, HTML escape와 공용 파일 트리는 주입받아 재사용한다.
(function () {
  "use strict";

  /** extension host 번역이 아직 주입되지 않았을 때 사용할 비교 UI 기본 영문 문자열. */
  const defaults = {
    compareWithCurrent: "Compare with Current Checkout...",
    compareWithCurrentTooltip:
      "Choose one branch to compare with the current working tree",
    advancedComparison: "Advanced branch comparison",
    compareAdvanced: "Compare Selected FROM and TO",
    resetComparison: "Reset Comparison",
    resetComparisonTooltip: "Clear the current comparison and choose again",
    gutterReadyTitle: "Line markers ready",
    gutterReadyDetail: "Open a changed file to see changes beside line numbers.",
    gutterOffTitle: "Line markers unavailable",
    gutterComparisonHidden:
      "Comparison markers are turned off. Show them to use line markers.",
    gutterTargetNotCurrent:
      "This comparison does not target the current checkout, so files open as side-by-side diffs.",
    gutterRefsUnavailable:
      "The comparison refs are not available locally. Fetch them, then refresh.",
    gutterSettingHidden:
      "VS Code's scm.diffDecorations setting is hiding line markers.",
    openGutterSettings: "Open Line Marker Settings",
    showLineMarkers: "Show Line Markers",
    openFileWithMarkers: "Open File with Comparison Markers",
    openDeletedFileWithMarkers: "Open Deleted File with Red Line Markers",
    openFileMarkersHidden: "Open File (line markers hidden)",
    comparisonUnavailable: "Comparison file unavailable locally",
    openComparisonDiff: "Open Comparison Diff",
  };

  /**
   * 비교 파일 행 우측에 항상 제공하는 명시적 side-by-side Diff 액션을 만든다.
   * @param strings 지역화 문자열 사전
   * @param escape HTML attribute escape 함수
   * @param isFile 폴더가 아닌 파일 행인지 여부
   * @returns 파일이면 Diff 아이콘 HTML, 폴더면 빈 문자열
   */
  function rowActionsHtml(strings, escape, isFile) {
    if (!isFile) {
      return "";
    }
    return (
      `<span class="row-actions"><button class="row-action codicon codicon-diff" ` +
      `type="button" data-act="openCompareDiff" ` +
      `title="${escape(strings.openComparisonDiff)}" data-tooltip="${escape(
        strings.openComparisonDiff
      )}" aria-label="${escape(strings.openComparisonDiff)}"></button></span>`
    );
  }

  /**
   * 비교 파일 기본 클릭이 실제 수행할 동작을 tooltip/접근성 이름으로 설명한다.
   * @param strings 지역화 문자열 사전
   * @param change 상태와 경로를 가진 파일 변경
   * @param gutter controller/ref/설정으로 계산한 라인 표시 상태
   * @returns 현재 클릭 동작에 맞는 짧은 동사형 라벨
   */
  function fileActionLabel(strings, change, gutter) {
    const markerState = gutter && gutter.state;
    if (gutter && gutter.diffAvailable === false) {
      return strings.comparisonUnavailable;
    }
    if (change.status === "D") {
      return strings.openDeletedFileWithMarkers;
    }
    if (
      markerState === "targetNotCurrent" ||
      markerState === "comparisonHidden"
    ) {
      return strings.openComparisonDiff;
    }
    return markerState === "settingHidden"
      ? strings.openFileMarkersHidden
      : strings.openFileWithMarkers;
  }

  /**
   * 라인 표시 준비 여부와 현재 화면에서 실행 가능한 해결 버튼을 카드로 만든다.
   * @param strings 지역화 문자열 사전
   * @param escape HTML escape 함수
   * @param gutter payload가 계산한 상태와 액션 가능 여부
   * @returns 상태가 없으면 빈 문자열, 있으면 role=note 카드 HTML
   */
  function gutterStatusHtml(strings, escape, gutter) {
    if (!gutter) {
      return "";
    }
    const active = gutter.state === "active";
    const title = active ? strings.gutterReadyTitle : strings.gutterOffTitle;
    const detail = active
      ? strings.gutterReadyDetail
      : gutter.state === "comparisonHidden"
        ? strings.gutterComparisonHidden
        : gutter.state === "refsUnavailable"
          ? strings.gutterRefsUnavailable
          : gutter.state === "settingHidden"
            ? strings.gutterSettingHidden
            : strings.gutterTargetNotCurrent;
    const action = gutterActionHtml(strings, escape, gutter);
    return (
      `<div class="gutter-status ${active ? "active" : "inactive"}" role="note">` +
      `<span class="codicon ${active ? "codicon-pass-filled" : "codicon-info"}"></span>` +
      `<span class="gutter-status-copy"><strong>${escape(title)}</strong>` +
      `<span>${escape(detail)}</span></span>${action}</div>`
    );
  }

  /**
   * 현재 차단 원인에 맞는 단 하나의 해결 버튼을 만든다.
   * @param strings 지역화 문자열 사전
   * @param escape HTML escape 함수
   * @param gutter 상태 카드 payload
   * @returns 표시 켜기/현재 checkout 비교/설정 열기 버튼 또는 빈 문자열
   */
  function gutterActionHtml(strings, escape, gutter) {
    if (gutter.canShowComparison) {
      return actionButton(
        "show-comparison-markers",
        strings.showLineMarkers,
        escape
      );
    }
    if (gutter.canCompareCurrent) {
      return actionButton(
        "compare-current-branch",
        strings.compareWithCurrent,
        escape,
        strings.compareWithCurrentTooltip
      );
    }
    return gutter.canOpenSettings
      ? actionButton(
          "open-gutter-settings",
          strings.openGutterSettings,
          escape
        )
      : "";
  }

  /**
   * 상태 카드의 링크형 버튼을 동일한 tooltip/접근성 규칙으로 만든다.
   * @param id 이벤트 연결에 사용할 DOM id
   * @param label 버튼에 보이는 문자열
   * @param escape HTML escape 함수
   * @param tooltip label과 다른 설명이 필요할 때의 tooltip
   * @returns 안전하게 escape된 button HTML
   */
  function actionButton(id, label, escape, tooltip = label) {
    return (
      `<button id="${id}" class="gutter-status-action" type="button" ` +
      `title="${escape(tooltip)}" data-tooltip="${escape(tooltip)}" ` +
      `aria-label="${escape(tooltip)}">` +
      `${escape(label)}</button>`
    );
  }

  /**
   * FROM/TO ref 한 줄을 키보드로도 변경할 수 있는 버튼형 행으로 만든다.
   * @param strings 지역화 문자열 사전
   * @param escape HTML escape 함수
   * @param side from 또는 to
   * @param value 현재 표시할 ref. 없으면 선택 안내를 사용한다
   * @returns ref 행 HTML
   */
  function refRow(strings, escape, side, value) {
    const isEmpty = !value;
    const label = side === "from" ? strings.from : strings.to;
    const icon = side === "from" ? "codicon-git-commit" : "codicon-target";
    const shown = isEmpty ? strings.selectBranch : value;
    const tooltip = `${strings.change}: ${label} ${shown}`;
    return (
      `<div class="ref" data-side="${side}" role="button" tabindex="0" ` +
      `title="${escape(tooltip)}" data-tooltip="${escape(tooltip)}" ` +
      `aria-label="${escape(tooltip)}">` +
      `<span class="icon codicon ${icon}"></span>` +
      `<span class="label">${escape(label)}</span>` +
      `<span class="value${isEmpty ? " empty" : ""}">${escape(shown)}</span>` +
      `<span class="actions"><span class="action codicon codicon-edit" ` +
      `title="${escape(strings.change)}"></span></span></div>`
    );
  }

  /**
   * Compare Branches 섹션을 기본 현재-checkout 흐름 또는 활성 결과로 렌더링한다.
   * @param compare extension host가 보낸 비교 draft/result payload
   * @param viewMode tree 또는 list
   * @param helpers 지역화/escape/공용 파일 트리 함수
   * @returns 섹션 body HTML
   */
  function render(compare, viewMode, helpers) {
    const { strings, escape, fileTree } = helpers;
    if (compare.mode === "draft") {
      return (
        `<button id="compare-current" type="button" title="${escape(
          strings.compareWithCurrentTooltip
        )}" data-tooltip="${escape(strings.compareWithCurrentTooltip)}" ` +
        `aria-label="${escape(strings.compareWithCurrentTooltip)}">` +
        `<span class="codicon codicon-git-compare"></span>${escape(
          strings.compareWithCurrent
        )}</button>` +
        `<div class="compare-advanced-label"><span class="codicon codicon-settings-gear"></span>` +
        `${escape(strings.advancedComparison)}</div>` +
        refRow(strings, escape, "from", compare.from) +
        refRow(strings, escape, "to", compare.to) +
        `<button id="compare" type="button" title="${escape(
          strings.compareAdvanced
        )}" data-tooltip="${escape(strings.compareAdvanced)}" ` +
        `aria-label="${escape(strings.compareAdvanced)}">` +
        `<span class="codicon codicon-git-compare"></span>${escape(
          strings.compareAdvanced
        )}</button>`
      );
    }
    return (
      refRow(strings, escape, "from", compare.from) +
      refRow(strings, escape, "to", compare.to) +
      gutterStatusHtml(strings, escape, compare.gutter) +
      `<button id="reset-comparison" class="compare-reset-action" type="button" ` +
      `title="${escape(strings.resetComparisonTooltip)}" ` +
      `data-tooltip="${escape(strings.resetComparisonTooltip)}" ` +
      `aria-label="${escape(strings.resetComparisonTooltip)}">` +
      `<span class="codicon codicon-clear-all"></span>${escape(
        strings.resetComparison
      )}</button>` +
      fileTree(
        compare.nodes,
        viewMode,
        "compare",
        "compare-files",
        strings.noCompare,
        compare.gutter
      )
    );
  }

  /**
   * 매 렌더 뒤 새로 만들어진 비교 컨트롤과 파일 행에 이벤트를 연결한다.
   * @param root Changes 웹뷰 root element
   * @param vscode acquireVsCodeApi 반환 객체
   */
  function bind(root, vscode) {
    root.querySelectorAll(".ref").forEach((element) => {
      element.addEventListener("click", () =>
        vscode.postMessage({ type: "changeRef", side: element.dataset.side })
      );
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          element.click();
        }
      });
    });
    bindMessageButton(root, vscode, "compare-current", "compareCurrentBranch");
    bindMessageButton(
      root,
      vscode,
      "compare-current-branch",
      "compareCurrentBranch"
    );
    bindMessageButton(root, vscode, "open-gutter-settings", "openGutterSettings");
    bindMessageButton(
      root,
      vscode,
      "show-comparison-markers",
      "showComparisonMarkers"
    );
    bindMessageButton(root, vscode, "compare", "runCompare", true);
    bindMessageButton(root, vscode, "reset-comparison", "resetComparison");
    root.querySelectorAll(".compare-files .row.file").forEach((element) => {
      const open = () =>
        vscode.postMessage({
          type: "openComparisonFile",
          path: element.dataset.path,
        });
      element.addEventListener("click", (event) => {
        if (!event.target.closest(".row-action")) {
          open();
        }
      });
      element.addEventListener("keydown", (event) => {
        if (
          !event.target.closest(".row-action") &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          open();
        }
      });
    });
  }

  /**
   * id로 찾은 비교 버튼을 단순 webview 메시지에 연결한다.
   * @param root Changes 웹뷰 root element
   * @param vscode acquireVsCodeApi 반환 객체
   * @param id button element id
   * @param type extension host protocol message type
   * @param stopPropagation 아코디언 클릭으로 전파되는 것을 막을지 여부
   */
  function bindMessageButton(root, vscode, id, type, stopPropagation = false) {
    const button = root.querySelector(`#${id}`);
    if (!button) {
      return;
    }
    button.addEventListener("click", (event) => {
      if (stopPropagation) {
        event.stopPropagation();
      }
      vscode.postMessage({ type });
    });
  }

  /**
   * 비교 목록을 작업트리와 같은 가상 스크롤 모델로 만든다. 화면 밖 파일도 원본 모델에 모두 남는다.
   * @param deps 상태/아이콘/HTML 생성 함수와 VS Code 메시지 브리지
   * @returns HTML 생성, mount, 가시 범위 갱신 API
   */
  function createFileTree(deps) {
    const { rootEl, state, strings, esc, vscode } = deps;
    let gutter;
    const list = window.__gscChangesWorkingList({ ...deps,
      sectionName: "compare", containerClass: "virtual-compare-files", focusChildren: true,
      rowHtml: (group, row) => rowHtml(row.node, group.viewMode, group.folderConflicts.get(row.node) || 0),
      bindRows: bindRows,
      afterRowsRendered: (rows) => rows.forEach(deps.applyFileIconGlyphStyles),
      persistState: () => vscode.setState(state),
    });

    /** 비교 결과 전체 모델을 등록하고 빈 상태 또는 높이 spacer를 반환한다. */
    function fileTree(nodes, viewMode, _kind, _extraClass, emptyText, nextGutter, elementId) {
      gutter = nextGutter;
      if (!nodes.length) return `<p class="empty">${esc(emptyText)}</p>`;
      return list.groupFilesHtml("compare", nodes, viewMode, elementId || "comparison-files");
    }

    /** 파일/폴더의 기존 시각 언어와 tooltip을 유지하는 평면 행 HTML을 만든다. */
    function rowHtml(node, viewMode, conflicts) {
      if (node.kind === "folder") {
        const key = `compare:${node.path}`, collapsed = !!state.folders[key];
        const title = conflicts ? `${node.path} - ${strings.conflicts}` : node.path;
        return `<div class="row folder${conflicts ? " conflict" : ""}" role="button" tabindex="0" aria-expanded="${!collapsed}" ` +
          `data-folder-key="${esc(key)}" data-path="${esc(node.path)}" title="${esc(title)}" aria-label="${esc(title)}">` +
          `<span class="twistie codicon codicon-chevron-${collapsed ? "right" : "down"}" aria-hidden="true"></span>` +
          `<span class="icon codicon codicon-folder${collapsed ? "" : "-opened"}" aria-hidden="true"></span>` +
          `<span class="name">${esc(node.name)}</span>` + (conflicts ? deps.conflictBadgeHtml(conflicts) : "") + `</div>`;
      }
      const change = node.change;
      const slash = change.path.lastIndexOf("/");
      const name = change.path.slice(slash + 1), dir = slash < 0 ? "" : change.path.slice(0, slash);
      const title = `${fileActionLabel(strings, change, gutter)}: ${change.path}`;
      return `<div class="row file${change.status === "U" ? " conflict" : ""}" role="group" ` +
        `aria-label="${esc(change.path)}" data-status="${esc(change.status)}" data-path="${esc(change.path)}" ` +
        `data-stage="compare" title="${esc(title)}">` +
        `<span class="twistie" aria-hidden="true"></span><span class="icon codicon ${deps.statusCodicon(change.status)}" aria-hidden="true"></span>` +
        deps.fileIconHtml(change.path) +
        `<span class="name" role="button" tabindex="0" title="${esc(title)}" aria-label="${esc(title)}">${esc(name)}</span>` +
        (viewMode === "list" && dir ? `<span class="dir">${esc(dir)}</span>` : "") +
        deps.statHtml(change) + (change.status === "U" ? deps.conflictBadgeHtml(0) : "") +
        rowActionsHtml(strings, esc, true) + `</div>`;
    }

    /** 동적으로 생성되는 행에도 click/Enter/Space를 위임해 이벤트 수를 목록 크기와 무관하게 유지한다. */
    function bindRows(container) {
      /** 현재 행의 폴더를 토글하거나 파일/명시적 diff를 연다. */
      function activate(event) {
        const row = event.target.closest(".row");
        if (!row || !container.contains(row)) return;
        if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
        const action = event.target.closest(".row-action");
        if (event.type === "keydown") {
          if (action) return; // native button의 click 한 번만 사용한다.
          event.preventDefault();
        }
        if (row.classList.contains("folder")) list.toggleFolder(row);
        else vscode.postMessage({ type: action ? "openDiff" : "openComparisonFile", path: row.dataset.path });
      }
      container.addEventListener("click", activate);
      container.addEventListener("keydown", activate);
    }

    return { fileTree, beginRender: list.beginRender, attach: list.attach, renderVisibleRows: list.renderVisibleRows, scheduleRender: list.scheduleRender };
  }

  window.__gscCompare = {
    defaults,
    rowActionsHtml,
    fileActionLabel,
    render,
    bind,
    createFileTree,
  };
})();
