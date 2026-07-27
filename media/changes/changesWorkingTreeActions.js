// Changes 작업트리 행의 hover action과 우클릭 메뉴 이벤트 바인딩.
// - 렌더러가 만든 행과 선택 모듈을 연결하되, stage/unstage의 실제 요청은 주입받아 유지한다.
(function () {
  "use strict";

  /** 작업트리 행 액션을 현재 webview 의 메시지·선택 API에 연결한다. */
  window.__gscChangesWorkingTreeActions = function createChangesWorkingTreeActions({
    actionPaths,
    isSelected,
    openContextMenu,
    postWorkingAction,
    rowContextNodes,
    selectOnly,
    vscode,
  }) {
    /** hover 아이콘과 우클릭 동작을 scope 안의 작업트리 행에 한 번씩 연결한다. */
    function bindRowActions(scope) {
      scope.querySelectorAll(".row-action").forEach((el) => {
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          // stash의 ... 메뉴는 Changes Stashes 모듈이 disclosure 상태와 함께 처리한다.
          if (el.dataset.act === "stashMenu") {
            return;
          }
          const row = el.closest(".row");
          if (!row) {
            return;
          }
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

      scope.querySelectorAll(".wt-files .row").forEach((row) => {
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          // 선택에 없는 행을 우클릭하면 해당 행만 대상으로 한다(VS Code tree 관례).
          if (!isSelected(row)) {
            selectOnly(row);
          }
          const group = row.closest(".group");
          const kind = group ? group.dataset.gkey : "unstaged";
          openContextMenu(event.clientX, event.clientY, rowContextNodes(row, kind));
        });
      });
    }

    return { bindRowActions };
  };
}());
