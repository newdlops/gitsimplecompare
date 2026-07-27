// Review Center의 비입력 키보드 이동과 안전한 Escape 닫기 동작.
// - input/textarea/contenteditable에서는 브라우저·편집기 기본 입력을 보존하고, 열려 있는 local surface만 안쪽부터 닫는다.
(function () {
  "use strict";

  /** main renderer가 제공하는 state와 tab 전환 callback으로 shortcut controller를 만든다. */
  window.__gscReviewCenterKeyboard = function createReviewCenterKeyboard(deps) {
    const { state, tabs, selectTab, render, vscode } = deps;

    /** webview document에 하나의 keydown listener를 연결한다. */
    function install() {
      window.addEventListener("keydown", onKeydown);
    }

    /** Alt+1..5 탭 전환과 Escape의 composer/preview 닫기만 처리한다. */
    function onKeydown(event) {
      if (isEditable(event.target)) return;
      if (event.key === "Escape" && closeInnermost()) {
        event.preventDefault();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const index = Number(event.code.replace("Digit", "")) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= tabs.length) return;
      event.preventDefault();
      selectTab(tabs[index], true);
    }

    /** pending network write는 유지하고 취소 가능한 가장 안쪽 local UI만 순서대로 닫는다. */
    function closeInnermost() {
      const comment = state.commentAction;
      if (comment?.commentId && !comment.pending) {
        Object.assign(comment, { commentId: "", body: "", confirmDelete: false, error: "", success: "" });
        render();
        return true;
      }
      const reply = state.threadReply;
      if (reply?.threadId && !reply.pending) {
        Object.assign(reply, { threadId: "", body: "", error: "", success: "" });
        render();
        return true;
      }
      const line = state.lineComment;
      if (line?.open && !line.pending) {
        Object.assign(line, { open: false, error: "", success: "" });
        render();
        return true;
      }
      const file = state.fileComment;
      if (file?.path && !file.pending) {
        Object.assign(file, { path: "", body: "", error: "", success: "" });
        render();
        return true;
      }
      if (state.managementPreview && !state.managementPending) {
        vscode.postMessage({ type: "cancelManagementPreview", previewId: state.managementPreview.previewId });
        state.managementPreview = null;
        render();
        return true;
      }
      const draft = state.draft;
      if (draft?.confirmDiscard || draft?.confirmSubmit) {
        draft.confirmDiscard = false;
        draft.confirmSubmit = false;
        render();
        return true;
      }
      return false;
    }

    /** 텍스트 작성 중인 target은 shortcut에서 제외해 OS/브라우저 편집 동작을 보존한다. */
    function isEditable(target) {
      return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
    }

    return { install };
  };
}());
