// Review Center Activity 탭에서 기존 review thread에 답글을 pending review로 추가하는 composer.
// - file comment composer와 분리해 thread별 입력·오류를 보존하고, head 충돌 상태에서는 write를 막는다.
(function () {
  "use strict";

  /** main renderer의 공통 상태와 DOM helper를 받아 thread reply composer를 만든다. */
  window.__gscReviewCenterThreadReply = function createReviewCenterThreadReply(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** 대상 thread를 전환하고 이전 실패 상태를 비운 뒤 입력 영역에 focus를 둔다. */
    function open(threadId) {
      const current = replyState();
      if (current.pending || current.threadId === threadId || isWriteLocked()) return;
      current.threadId = threadId;
      current.body = "";
      current.error = "";
      current.success = "";
      render();
      document.querySelector('textarea[name="review-thread-reply"]')?.focus();
    }

    /** 선택된 thread 바로 아래에 접근 가능한 답글 form을 그린다. */
    function renderComposer(threadId) {
      const current = replyState();
      if (current.threadId !== threadId) return document.createDocumentFragment();
      const section = el("section", "review-center__thread-reply");
      section.append(el("h3", "review-center__thread-reply-title", T.replyToThread));
      if (current.error) section.append(status("alert", "gsc-banner gsc-banner--warning", current.error));
      if (current.success) section.append(status("status", "gsc-banner gsc-banner--success", current.success));

      const form = el("form", "review-center__thread-reply-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.threadReply));
      const textarea = el("textarea", "gsc-input review-center__thread-reply-body");
      textarea.name = "review-thread-reply";
      textarea.autocomplete = "off";
      textarea.spellcheck = true;
      textarea.maxLength = 65536;
      textarea.value = current.body;
      textarea.disabled = current.pending || isWriteLocked();
      textarea.setAttribute("aria-describedby", "review-center-thread-reply-hint");
      textarea.addEventListener("input", () => {
        current.body = textarea.value;
        current.error = "";
        current.success = "";
        vscode.setState(state);
      });
      const hint = el("span", "gsc-field__hint", T.threadReplyHint);
      hint.id = "review-center-thread-reply-hint";
      field.append(textarea, hint);

      const actions = el("div", "review-center__management-actions");
      const submitLabel = current.pending ? T.addingThreadReply : T.addReplyToPendingReview;
      const submitButton = button("gsc-button gsc-button--primary", submitLabel, submitLabel, submit);
      submitButton.disabled = current.pending || isWriteLocked() || !current.body.trim();
      submitButton.setAttribute("aria-busy", String(current.pending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, () => {
        if (current.pending) return;
        current.threadId = "";
        current.body = "";
        current.error = "";
        current.success = "";
        render();
      });
      cancel.disabled = current.pending;
      actions.append(submitButton, cancel);
      form.append(field, actions);
      section.append(form);
      return section;
    }

    /** 현재 pending review의 summary와 함께 입력을 host mutation으로 보낸다. */
    function submit() {
      const current = replyState();
      if (current.pending || isWriteLocked() || !current.threadId || !current.body.trim()) return;
      current.pending = true;
      current.error = "";
      current.success = "";
      render();
      vscode.postMessage({ type: "addReviewThreadReply", threadId: current.threadId, body: current.body, reviewBody: state.draft.body });
    }

    /** host의 성공·오류를 열려 있는 해당 thread composer에만 반영한다. */
    function applyResult(message) {
      const current = replyState();
      if (message.threadId !== current.threadId) return;
      current.pending = false;
      if (message.type === "threadReplyResult") {
        current.body = "";
        current.error = "";
        current.success = T.threadReplyAdded;
      } else {
        current.error = message.message || T.unknownError;
      }
    }

    /** 새 상태와 이전 VS Code webview state 모두에서 안전한 reply state를 얻는다. */
    function replyState() {
      if (!state.threadReply) state.threadReply = { threadId: "", body: "", pending: false, error: "", success: "" };
      return state.threadReply;
    }

    /** assistive technology에 성공·실패를 즉시 전달하는 status node를 만든다. */
    function status(role, className, text) {
      const node = el("div", className, text);
      node.setAttribute("role", role);
      return node;
    }

    /** pending review anchor가 안전하지 않은 상태에서는 새 write를 잠근다. */
    function isWriteLocked() {
      return state.draft.reconcile?.kind === "headChanged" || state.draft.reconcile?.kind === "conflict";
    }

    return { open, renderComposer, applyResult };
  };
}());
