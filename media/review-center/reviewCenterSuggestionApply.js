// Review Center Activity의 GitHub suggestion local preview/apply UI.
// - host가 exact PR head/local document safety를 확인한 경우에만 preview와 명시적 apply를 허용한다.
(function () {
  "use strict";

  /** shared state/DOM primitive를 받아 suggestion action과 preview surface를 만든다. */
  window.__gscReviewCenterSuggestionApply = function createReviewCenterSuggestionApply(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** comment에 포함된 적용 가능 suggestion마다 preview button을 만든다. */
    function renderActions(thread, comment) {
      if (!comment.suggestions?.length) return document.createDocumentFragment();
      const current = suggestionState();
      const actions = el("div", "review-center__suggestion-actions");
      comment.suggestions.forEach((suggestion, index) => {
        const label = suggestion.isApplicable ? T.previewSuggestion : T.suggestionUnavailable;
        const action = button("gsc-button gsc-button--ghost", label, label, () => preview(thread, comment, index));
        action.disabled = current.pending || !suggestion.isApplicable || state.snapshot.canOpenNativeDiff === false || thread.isOutdated;
        actions.append(action);
      });
      return actions;
    }

    /** preview 오류 또는 before/after 확인과 apply/cancel controls를 해당 comment 아래에 표시한다. */
    function renderPreview(comment) {
      const current = suggestionState();
      if (current.commentId !== comment.id) return document.createDocumentFragment();
      const section = el("section", "review-center__suggestion-preview");
      if (current.error) {
        const error = el("div", "gsc-banner gsc-banner--warning", current.error);
        error.setAttribute("role", "alert");
        section.append(error);
      }
      if (current.preview && current.commentId === comment.id) {
        section.append(el("h3", "review-center__suggestion-preview-title", T.suggestionPreview));
        section.append(codeBlock(T.suggestionBefore, current.preview.before), codeBlock(T.suggestionAfter, current.preview.after));
        section.append(el("p", "review-center__suggestion-preview-note", T.suggestionApplyHint));
        const actions = el("div", "review-center__management-actions");
        const apply = button("gsc-button gsc-button--primary", T.applySuggestion, T.applySuggestion, () => applyPreview());
        apply.disabled = current.pending;
        apply.setAttribute("aria-busy", String(current.pending));
        const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, clear);
        cancel.disabled = current.pending;
        actions.append(apply, cancel);
        section.append(actions);
      }
      return section;
    }

    /** source-safe preview를 host에 요청하고 현재 comment의 pending state를 잠근다. */
    function preview(thread, comment, suggestionIndex) {
      const current = suggestionState();
      if (current.pending) return;
      Object.assign(current, { threadId: thread.id, commentId: comment.id, pending: true, preview: null, error: "" });
      render();
      vscode.postMessage({ type: "previewSuggestionApply", threadId: thread.id, commentId: comment.id, suggestionIndex });
    }

    /** 사용자가 preview를 읽고 명시적으로 확인했을 때만 WorkspaceEdit apply를 요청한다. */
    function applyPreview() {
      const current = suggestionState();
      if (current.pending || !current.preview?.previewId) return;
      current.pending = true;
      render();
      vscode.postMessage({ type: "applySuggestion", previewId: current.preview.previewId });
    }

    /** host result를 current preview state로 반영하고 apply 뒤에는 native undo 안내를 표시한다. */
    function applyResult(message) {
      const current = suggestionState();
      current.pending = false;
      if (message.type === "suggestionPreview") {
        current.preview = message;
        current.error = "";
      } else if (message.type === "suggestionApplied") {
        current.preview = null;
        current.error = T.suggestionApplied;
      } else current.error = message.message || T.unknownError;
    }

    /** preview/error local state를 비우며 host에는 side effect를 보내지 않는다. */
    function clear() {
      const current = suggestionState();
      if (current.pending) return;
      Object.assign(current, { threadId: "", commentId: "", preview: null, error: "" });
      render();
    }

    /** before/after plain-text code block을 textContent로 만들어 markup injection을 막는다. */
    function codeBlock(label, value) {
      const wrap = el("div", "review-center__suggestion-code-block");
      wrap.append(el("div", "review-center__suggestion-code-label", label), el("pre", "gsc-code", value || T.suggestionDelete));
      return wrap;
    }

    /** persisted state가 이전 버전이어도 suggestion preview state를 안전하게 복원한다. */
    function suggestionState() {
      if (!state.suggestionApply) state.suggestionApply = { threadId: "", commentId: "", pending: false, preview: null, error: "" };
      return state.suggestionApply;
    }

    return { renderActions, renderPreview, applyResult };
  };
}());
