// Changes 작업트리 행의 클릭·키보드·hover action·우클릭 메뉴 이벤트 바인딩.
// - 작업트리(Staged/Changes) 행은 가상 스크롤로 계속 생겼다 사라지므로 목록 컨테이너 하나에 위임 연결한다.
// - 렌더러가 만든 행과 선택 모듈을 연결하되, stage/unstage의 실제 요청은 주입받아 유지한다.
(function () {
  "use strict";

  /** 작업트리 행 액션을 현재 webview 의 메시지·선택 API에 연결한다. */
  window.__gscChangesWorkingTreeActions = function createChangesWorkingTreeActions({
    actionPaths,
    consumeSuppressedRowClick,
    isSelected,
    onWorkingRowClick,
    openContextMenu,
    postWorkingAction,
    strings,
    openWorkingPath,
    selectOnly,
    toggleWorkingFolder,
    vscode,
  }) {
    /**
     * 비교/stash 처럼 작업트리 밖에 있는 행의 hover 아이콘을 scope 안에서 한 번씩 연결한다.
     * - 작업트리 행은 bindWorkingRows 의 위임 리스너가 처리하므로 여기서 건너뛴다(중복 실행 방지).
     * @param {ParentNode} scope 방금 렌더한 DOM 범위
     */
    function bindRowActions(scope) {
      scope.querySelectorAll(".row-action").forEach((el) => {
        if (el.closest(".wt-files")) {
          return;
        }
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          // stash의 ... 메뉴는 Changes Stashes 모듈이 disclosure 상태와 함께 처리한다.
          if (el.dataset.act === "stashMenu") {
            return;
          }
          const row = el.closest(".row");
          if (row) {
            runRowAction(el, row);
          }
        });
      });
    }

    /**
     * 작업트리 목록 컨테이너 하나에 행 클릭·키보드·hover action·우클릭을 위임 연결한다.
     * - 행 요소가 스크롤로 교체돼도 리스너를 다시 붙일 필요가 없고, 행 수와 무관하게 리스너는 3개다.
     * - 파일 행 클릭은 선택+비교 열기, 폴더 행은 이름 클릭=선택 / twistie·아이콘 클릭=접기 규칙을 유지한다.
     * @param {HTMLElement} container `.wt-files` 목록 컨테이너
     */
    function bindWorkingRows(container) {
      container.addEventListener("click", (event) => {
        const row = event.target.closest(".row");
        if (!row || !container.contains(row)) {
          return;
        }
        const action = event.target.closest(".row-action");
        if (action && row.contains(action)) {
          event.stopPropagation();
          runRowAction(action, row);
          return;
        }
        if (row.classList.contains("folder")) {
          if (consumeSuppressedRowClick()) {
            return;
          }
          if (!event.target.closest(".twistie, .icon")) {
            onWorkingRowClick(event, row);
            return;
          }
          toggleWorkingFolder(row);
          return;
        }
        onWorkingRowClick(event, row);
      });
      container.addEventListener("keydown", (event) => {
        const row = event.target;
        if (
          !row.classList?.contains("row") ||
          !container.contains(row) ||
          (event.key !== "Enter" && event.key !== " ")
        ) {
          return;
        }
        event.preventDefault();
        if (row.classList.contains("folder")) {
          toggleWorkingFolder(row);
        } else {
          onWorkingRowClick(event, row);
        }
      });
      container.addEventListener("contextmenu", (event) => {
        const row = event.target.closest(".row");
        if (!row || !container.contains(row)) {
          return;
        }
        event.preventDefault();
        // 선택에 없는 행을 우클릭하면 해당 행만 대상으로 한다(VS Code tree 관례).
        if (!isSelected(row)) {
          selectOnly(row);
        }
        const group = row.closest(".group");
        const kind = group ? group.dataset.gkey : "unstaged";
        openContextMenu(event.clientX, event.clientY, rowContextNodes(row, kind));
      });
    }

    /**
     * hover action 버튼 하나의 동작을 실행한다.
     * @param {HTMLElement} el 누른 `.row-action` 버튼
     * @param {HTMLElement} row 버튼이 속한 행
     */
    function runRowAction(el, row) {
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
    }

  /** 행 우클릭 컨텍스트 메뉴 항목(파일이면 열기/비교 + stage 류, 폴더면 stage 류). */
  function rowContextNodes(row, kind) {
    const nodes = [];
    if (row.classList.contains("file")) {
      const path = row.dataset.path;
      nodes.push({
        label: strings.openFile,
        onClick: () => vscode.postMessage({ type: "openFile", path }),
      });
      nodes.push({
        label: strings.openChanges,
        onClick: () => openWorkingPath(path, kind, row.dataset.status),
      });
      nodes.push({ separator: true });
    }
    const paths = actionPaths(row);
    if (kind === "staged") {
      nodes.push({
        label: strings.unstage,
        onClick: () => postWorkingAction("unstage", paths),
      });
    } else {
      nodes.push({
        label: strings.stage,
        onClick: () => postWorkingAction("stage", paths),
      });
      nodes.push({
        label: strings.discard,
        onClick: () => vscode.postMessage({ type: "discard", paths }),
      });
    }
    nodes.push({ separator: true });
    const ignoreTargets = ignorePaths(row);
    if (ignoreTargets.length) {
      nodes.push({
        label: strings.addToGitignore,
        onClick: () =>
          vscode.postMessage({ type: "addToGitignore", paths: ignoreTargets }),
      });
      nodes.push({
        label: strings.addToExclude,
        onClick: () =>
          vscode.postMessage({ type: "addToExclude", paths: ignoreTargets }),
      });
      nodes.push({ separator: true });
    }
    nodes.push({
      label: strings.stashSelected,
      onClick: () => vscode.postMessage({ type: "stashSelected", paths }),
    });
    return nodes;
  }

  /** ignore/exclude 컨텍스트 메뉴의 대상 경로. 폴더는 파일로 펼치지 않고 폴더 패턴으로 보낸다. */
  function ignorePaths(row) {
    if (row.classList.contains("folder")) {
      const path = row.dataset.path || "";
      return path ? [path.endsWith("/") ? path : path + "/"] : [];
    }
    return actionPaths(row);
  }


    return { bindRowActions, bindWorkingRows };
  };
}());
