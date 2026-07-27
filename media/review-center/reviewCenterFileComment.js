// Review Center Files 탭의 file-level pending review comment composer.
// - line/range anchor UI와 분리해 파일 전체 피드백을 먼저 안전하게 작성·전송한다.
(function () {
  "use strict";

  /** main renderer의 공통 상태/DOM helper를 받아 file comment composer를 만든다. */
  window.__gscReviewCenterFileComment = function createReviewCenterFileComment(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** 선택 파일의 composer를 열고 기존 실패 문구를 초기화한다. */
    function open(path) {
      if (state.fileComment.pending || state.fileComment.path === path || isWriteLocked()) return;
      state.fileComment.path = path;
      state.fileComment.body = "";
      state.fileComment.error = "";
      state.fileComment.success = "";
      render();
      document.querySelector('textarea[name="file-review-comment"]')?.focus();
    }

    /** 선택 파일을 대상으로 한 file-level comment form을 렌더한다. */
    function renderComposer() {
      const current = state.fileComment;
      if (!current.path) return document.createDocumentFragment();
      const section = el("section", "review-center__file-comment");
      const heading = el("h3", "review-center__file-comment-title", T.newFileComment);
      heading.append(document.createTextNode(` · ${current.path}`));
      section.append(heading);
      if (current.error) section.append(status("alert", "gsc-banner gsc-banner--warning", current.error));
      if (current.success) section.append(status("status", "gsc-banner gsc-banner--success", current.success));

      const form = el("form", "review-center__file-comment-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.fileComment));
      const textarea = el("textarea", "gsc-input review-center__file-comment-body");
      textarea.name = "file-review-comment";
      textarea.autocomplete = "off";
      textarea.spellcheck = true;
      textarea.maxLength = 65536;
      textarea.value = current.body;
      textarea.disabled = current.pending || isWriteLocked();
      textarea.setAttribute("aria-describedby", "review-center-file-comment-hint");
      textarea.addEventListener("input", () => {
        current.body = textarea.value;
        current.error = "";
        current.success = "";
        vscode.setState(state);
      });
      const hint = el("span", "gsc-field__hint", T.fileCommentHint);
      hint.id = "review-center-file-comment-hint";
      field.append(textarea, hint);

      const actions = el("div", "review-center__management-actions");
      const addLabel = current.pending ? T.addingFileComment : T.addToPendingReview;
      const add = button("gsc-button gsc-button--primary", addLabel, addLabel, submit);
      add.disabled = current.pending || isWriteLocked() || !current.body.trim();
      add.setAttribute("aria-busy", String(current.pending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, () => {
        if (current.pending) return;
        current.path = "";
        current.body = "";
        current.error = "";
        current.success = "";
        render();
      });
      cancel.disabled = current.pending;
      actions.append(add, cancel);
      form.append(field, actions);
      section.append(form);
      return section;
    }

    /** non-empty body만 host write contract로 넘기고 duplicate clicks를 막는다. */
    function submit() {
      const current = state.fileComment;
      if (current.pending || isWriteLocked() || !current.path || !current.body.trim()) return;
      current.pending = true;
      current.error = "";
      current.success = "";
      render();
      vscode.postMessage({
        type: "addFileReviewComment",
        path: current.path,
        body: current.body,
        reviewBody: state.draft.body,
      });
    }

    /** host 성공/오류 응답을 해당 composer에만 적용한다. */
    function applyResult(message) {
      const current = state.fileComment;
      if (message.path !== current.path) return;
      current.pending = false;
      if (message.type === "fileCommentResult") {
        current.body = "";
        current.error = "";
        current.success = T.fileCommentAdded;
      } else {
        current.error = message.message || T.unknownError;
      }
    }

    /** assistive technology가 성공/실패 문구를 즉시 읽도록 상태 역할을 부여한다. */
    function status(role, className, text) {
      const node = el("div", className, text);
      node.setAttribute("role", role);
      return node;
    }

    /** snapshot head가 바뀌었거나 pending review가 충돌하면 새 anchor write를 막는다. */
    function isWriteLocked() {
      return state.draft.reconcile?.kind === "headChanged" || state.draft.reconcile?.kind === "conflict";
    }

    return { open, renderComposer, applyResult };
  };
}());
