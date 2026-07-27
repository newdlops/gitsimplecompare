// Review Center Activity의 본인 comment 수정·삭제 UI.
// - host도 viewer ownership을 재검사하며, 이 모듈은 열린 editor와 명시적 삭제 확인만 보존한다.
(function () {
  "use strict";

  /** main renderer의 공통 상태와 DOM helper를 받아 comment action UI를 만든다. */
  window.__gscReviewCenterCommentActions = function createReviewCenterCommentActions(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** viewer가 작성한 comment에만 수정·삭제 controls를 제공한다. */
    function renderActions(comment) {
      if (!state.snapshot.viewer || comment.author !== state.snapshot.viewer) return document.createDocumentFragment();
      const current = actionState();
      const actions = el("div", "review-center__comment-actions");
      const busy = current.pending && current.commentId === comment.id;
      const edit = button("gsc-button gsc-button--ghost", T.editComment, T.editComment, () => openEdit(comment));
      edit.disabled = Boolean(current.pending);
      const remove = button("gsc-button gsc-button--ghost", T.deleteComment, T.deleteComment, () => confirmDelete(comment));
      remove.disabled = Boolean(current.pending);
      remove.setAttribute("aria-busy", String(busy));
      actions.append(edit, remove);
      return actions;
    }

    /** 현재 comment가 수정 대상일 때만 body editor 또는 삭제 확인을 이어서 렌더한다. */
    function renderComposer(comment) {
      const current = actionState();
      if (current.commentId !== comment.id) return document.createDocumentFragment();
      const section = el("section", "review-center__comment-editor");
      if (current.error) section.append(status("alert", "gsc-banner gsc-banner--warning", current.error));
      if (current.success) section.append(status("status", "gsc-banner gsc-banner--success", current.success));
      if (current.confirmDelete) return renderDeleteConfirm(section, comment, current);
      const form = el("form", "review-center__comment-editor-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); submitUpdate(); });
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.editComment));
      const textarea = el("textarea", "gsc-input review-center__comment-editor-body");
      textarea.name = "review-comment-edit";
      textarea.autocomplete = "off";
      textarea.spellcheck = true;
      textarea.maxLength = 65536;
      textarea.value = current.body;
      textarea.disabled = current.pending;
      textarea.addEventListener("input", () => updateBody(textarea.value));
      field.append(textarea);
      const actions = el("div", "review-center__management-actions");
      const saveLabel = current.pending ? T.savingComment : T.saveComment;
      const save = button("gsc-button gsc-button--primary", saveLabel, saveLabel, submitUpdate);
      save.disabled = current.pending || !current.body.trim();
      save.setAttribute("aria-busy", String(current.pending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, close);
      cancel.disabled = current.pending;
      actions.append(save, cancel);
      form.append(field, actions);
      section.append(form);
      return section;
    }

    /** 수정 버튼은 원문을 복사해 안전하게 editor를 열고 focus를 이동한다. */
    function openEdit(comment) {
      const current = actionState();
      if (current.pending) return;
      Object.assign(current, { commentId: comment.id, body: comment.body || "", confirmDelete: false, error: "", success: "" });
      render();
      document.querySelector('textarea[name="review-comment-edit"]')?.focus();
    }

    /** 삭제는 browser confirm 없이 inline confirmation state를 연다. */
    function confirmDelete(comment) {
      const current = actionState();
      if (current.pending) return;
      Object.assign(current, { commentId: comment.id, body: "", confirmDelete: true, error: "", success: "" });
      render();
    }

    /** 수정 본문을 유지하고 오류/성공 문구만 즉시 지운다. */
    function updateBody(body) {
      const current = actionState();
      current.body = body;
      current.error = "";
      current.success = "";
      vscode.setState(state);
    }

    /** 유효한 본문만 host mutation으로 보내고 동일 comment의 UI를 busy로 잠근다. */
    function submitUpdate() {
      const current = actionState();
      if (current.pending || !current.commentId || !current.body.trim()) return;
      current.pending = true;
      current.error = "";
      render();
      vscode.postMessage({ type: "updateReviewComment", commentId: current.commentId, body: current.body });
    }

    /** 인라인 삭제 확인에서만 destructive mutation을 보낸다. */
    function submitDelete() {
      const current = actionState();
      if (current.pending || !current.commentId) return;
      current.pending = true;
      current.error = "";
      render();
      vscode.postMessage({ type: "deleteReviewComment", commentId: current.commentId });
    }

    /** 성공/실패 메시지를 해당 comment editor에만 반영한다. */
    function applyResult(message) {
      const current = actionState();
      if (current.commentId !== message.commentId) return;
      current.pending = false;
      if (message.type === "commentMutationResult") {
        current.success = message.action === "deleted" ? T.commentDeleted : T.commentUpdated;
        if (message.action === "deleted") current.confirmDelete = false;
      } else current.error = message.message || T.unknownError;
    }

    /** 취소는 네트워크 요청을 취소하지 않고 local editor만 닫는다. */
    function close() {
      const current = actionState();
      if (current.pending) return;
      Object.assign(current, { commentId: "", body: "", confirmDelete: false, error: "", success: "" });
      render();
    }

    /** 삭제 확인 UI를 submit/cancel action과 함께 만든다. */
    function renderDeleteConfirm(section, _comment, current) {
      section.append(el("p", "review-center__comment-delete-copy", T.deleteCommentConfirm));
      const actions = el("div", "review-center__management-actions");
      const remove = button("gsc-button gsc-button--danger", T.confirmDeleteComment, T.confirmDeleteComment, submitDelete);
      remove.disabled = current.pending;
      remove.setAttribute("aria-busy", String(current.pending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, close);
      cancel.disabled = current.pending;
      actions.append(remove, cancel);
      section.append(actions);
      return section;
    }

    /** persisted state가 이전 버전이어도 action state를 안전하게 복원한다. */
    function actionState() {
      if (!state.commentAction) state.commentAction = { commentId: "", body: "", pending: false, confirmDelete: false, error: "", success: "" };
      return state.commentAction;
    }

    /** assistive technology에 비동기 결과를 즉시 전달하는 live status node를 만든다. */
    function status(role, className, text) {
      const node = el("div", className, text);
      node.setAttribute("role", role);
      return node;
    }

    return { renderActions, renderComposer, applyResult };
  };
}());
