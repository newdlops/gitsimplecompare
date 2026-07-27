// Review Center Files 탭의 line/multi-line pending review comment composer.
// - GitHub anchor가 실제 diff hunk에 속하는지는 host mutation이 최종 검증하고, 이 UI는 안전한 입력·복구 상태를 제공한다.
(function () {
  "use strict";

  /** main renderer가 제공하는 상태와 DOM primitive로 line comment composer를 만든다. */
  window.__gscReviewCenterLineComment = function createReviewCenterLineComment(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** 현재 PR의 첫 changed file을 기본값으로 해 composer를 열고 body에 focus를 둔다. */
    function open() {
      const current = lineState();
      if (current.open || current.pending || isWriteLocked() || !state.snapshot.files.length) return;
      current.open = true;
      current.path = state.snapshot.files.some((file) => file.path === current.path) ? current.path : state.snapshot.files[0].path;
      current.line = "";
      current.startLine = "";
      current.body = "";
      current.isSuggestion = false;
      current.suggestion = "";
      current.error = "";
      current.success = "";
      render();
      document.querySelector('input[name="review-line-comment-line"]')?.focus();
    }

    /** path, end line, optional start line, markdown body를 한 form으로 렌더한다. */
    function renderComposer() {
      const current = lineState();
      if (!current.open) return document.createDocumentFragment();
      const section = el("section", "review-center__line-comment");
      section.append(el("h3", "review-center__line-comment-title", T.newLineComment));
      if (current.error) section.append(status("alert", "gsc-banner gsc-banner--warning", current.error));
      if (current.success) section.append(status("status", "gsc-banner gsc-banner--success", current.success));
      const form = el("form", "review-center__line-comment-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
      form.append(renderFileField(current), renderAnchorFields(current), renderBodyField(current), renderSuggestionField(current));
      const actions = el("div", "review-center__management-actions");
      const submitLabel = current.pending ? T.addingLineComment : T.addLineToPendingReview;
      const submitButton = button("gsc-button gsc-button--primary", submitLabel, submitLabel, submit);
      submitButton.disabled = current.pending || isWriteLocked() || !isValid(current);
      submitButton.setAttribute("aria-busy", String(current.pending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, () => close());
      cancel.disabled = current.pending;
      actions.append(submitButton, cancel);
      form.append(actions);
      section.append(form);
      return section;
    }

    /** changed file만 고를 수 있게 select를 만들고 local state에 경로를 보존한다. */
    function renderFileField(current) {
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.commentFile));
      const select = el("select", "gsc-select");
      select.name = "review-line-comment-path";
      state.snapshot.files.forEach((file) => {
        const option = el("option", "", file.path);
        option.value = file.path;
        select.append(option);
      });
      select.value = current.path;
      select.disabled = current.pending || isWriteLocked();
      select.addEventListener("change", () => update(current, "path", select.value));
      field.append(select);
      return field;
    }

    /** end line과 optional start line을 별도 number input으로 제공해 range 의도를 명확히 한다. */
    function renderAnchorFields(current) {
      const wrap = el("div", "review-center__line-comment-anchor");
      wrap.append(renderNumberField(current, "line", "review-line-comment-line", T.commentLine, T.commentLineHint));
      wrap.append(renderNumberField(current, "startLine", "review-line-comment-start", T.commentStartLine, T.commentStartLineHint));
      return wrap;
    }

    /** anchor number 하나에 label, 최소값, 입력 state 동기화를 부여한다. */
    function renderNumberField(current, key, name, label, hint) {
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", label));
      const input = el("input", "gsc-input");
      input.type = "number";
      input.name = name;
      input.min = "1";
      input.step = "1";
      input.inputMode = "numeric";
      input.autocomplete = "off";
      input.value = current[key];
      input.disabled = current.pending || isWriteLocked();
      input.setAttribute("aria-describedby", `${name}-hint`);
      input.addEventListener("input", () => update(current, key, input.value));
      const hintNode = el("span", "gsc-field__hint", hint);
      hintNode.id = `${name}-hint`;
      field.append(input, hintNode);
      return field;
    }

    /** 일반 설명 입력의 scrollable 영역과 suggestion과의 조합 규칙을 안내한다. */
    function renderBodyField(current) {
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.commentMessage));
      const textarea = el("textarea", "gsc-input review-center__line-comment-body");
      textarea.name = "review-line-comment-body";
      textarea.autocomplete = "off";
      textarea.spellcheck = true;
      textarea.maxLength = 65536;
      textarea.value = current.body;
      textarea.disabled = current.pending || isWriteLocked();
      textarea.setAttribute("aria-describedby", "review-line-comment-body-hint");
      textarea.addEventListener("input", () => update(current, "body", textarea.value));
      const hint = el("span", "gsc-field__hint", T.lineCommentHint);
      hint.id = "review-line-comment-body-hint";
      field.append(textarea, hint);
      return field;
    }

    /** GitHub suggestion fence를 opt-in하고 별도 code input을 보여 주는 editor를 만든다. */
    function renderSuggestionField(current) {
      const wrap = el("div", "review-center__suggestion");
      const toggle = el("label", "review-center__suggestion-toggle");
      const checkbox = el("input", "");
      checkbox.type = "checkbox";
      checkbox.name = "review-line-comment-suggestion-toggle";
      checkbox.checked = Boolean(current.isSuggestion);
      checkbox.disabled = current.pending || isWriteLocked();
      checkbox.addEventListener("change", () => update(current, "isSuggestion", checkbox.checked));
      toggle.append(checkbox, el("span", "", T.addSuggestion));
      wrap.append(toggle);
      if (!current.isSuggestion) return wrap;
      const field = el("label", "gsc-field");
      field.append(el("span", "gsc-field__label", T.suggestionCode));
      const textarea = el("textarea", "gsc-input review-center__suggestion-code");
      textarea.name = "review-line-comment-suggestion";
      textarea.autocomplete = "off";
      textarea.spellcheck = false;
      textarea.maxLength = 65536;
      textarea.value = current.suggestion;
      textarea.disabled = current.pending || isWriteLocked();
      textarea.setAttribute("aria-describedby", "review-center-suggestion-code-hint");
      textarea.addEventListener("input", () => update(current, "suggestion", textarea.value));
      const hint = el("span", "gsc-field__hint", T.suggestionCodeHint);
      hint.id = "review-center-suggestion-code-hint";
      field.append(textarea, hint);
      wrap.append(field);
      return wrap;
    }

    /** local state를 바꾸고 오류/성공 문구를 지워 입력 중 혼동을 막는다. */
    function update(current, key, value) {
      current[key] = value;
      current.error = "";
      current.success = "";
      vscode.setState(state);
    }

    /** 정수 anchor와 multi-line 순서를 먼저 검증하고 host write를 요청한다. */
    function submit() {
      const current = lineState();
      if (current.pending || isWriteLocked() || !current.path || !hasCommentContent(current)) return;
      const line = Number(current.line);
      const startLine = current.startLine.trim() ? Number(current.startLine) : undefined;
      if (!Number.isInteger(line) || line <= 0 || (startLine !== undefined && (!Number.isInteger(startLine) || startLine <= 0 || startLine >= line))) {
        current.error = T.lineCommentInvalidAnchor;
        render();
        return;
      }
      current.pending = true;
      current.error = "";
      current.success = "";
      render();
      vscode.postMessage({ type: "addLineReviewComment", path: current.path, line, ...(startLine ? { startLine } : {}), body: current.body, ...(current.isSuggestion ? { suggestion: current.suggestion } : {}), reviewBody: state.draft.body });
    }

    /** host 결과를 열린 composer에 적용하며 실패한 본문/anchor는 그대로 보존한다. */
    function applyResult(message) {
      const current = lineState();
      if (!current.open || message.path !== current.path || Number(current.line) !== message.line) return;
      current.pending = false;
      if (message.type === "lineCommentResult") {
        current.body = "";
        current.suggestion = "";
        current.isSuggestion = false;
        current.error = "";
        current.success = T.lineCommentAdded;
      } else {
        current.error = message.message || T.unknownError;
      }
    }

    /** 취소는 진행 중인 request를 방해하지 않고 composer의 local state만 닫는다. */
    function close() {
      const current = lineState();
      if (current.pending) return;
      current.open = false;
      current.error = "";
      current.success = "";
      render();
    }

    /** persisted state가 이전 버전이어도 line composer 기본 구조를 안전하게 복원한다. */
    function lineState() {
      if (!state.lineComment) state.lineComment = { open: false, path: "", line: "", startLine: "", body: "", isSuggestion: false, suggestion: "", pending: false, error: "", success: "" };
      if (typeof state.lineComment.isSuggestion !== "boolean") state.lineComment.isSuggestion = false;
      if (typeof state.lineComment.suggestion !== "string") state.lineComment.suggestion = "";
      return state.lineComment;
    }

    /** submit button을 위한 빠른 client-side enabled 조건을 만든다. */
    function isValid(current) {
      const line = Number(current.line);
      const start = current.startLine.trim() ? Number(current.startLine) : undefined;
      return Boolean(current.path && hasCommentContent(current) && Number.isInteger(line) && line > 0 && (start === undefined || (Number.isInteger(start) && start > 0 && start < line)));
    }

    /** 일반 설명 또는 suggestion code가 하나 이상 있는지 submit 전 빠르게 확인한다. */
    function hasCommentContent(current) {
      return Boolean(current.body.trim() || (current.isSuggestion && current.suggestion.trim()));
    }

    /** assistive technology에 비동기 결과를 즉시 전달하는 live status node를 만든다. */
    function status(role, className, text) {
      const node = el("div", className, text);
      node.setAttribute("role", role);
      return node;
    }

    /** stale/conflicting pending review에서는 새 GitHub anchor write를 동일하게 잠근다. */
    function isWriteLocked() {
      return state.draft.reconcile?.kind === "headChanged" || state.draft.reconcile?.kind === "conflict";
    }

    return { open, renderComposer, applyResult };
  };
}());
