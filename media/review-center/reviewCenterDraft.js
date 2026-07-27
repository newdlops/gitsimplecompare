// Review Center의 pending review summary composer.
// - local draft 보존과 최초 pending review 시작만 담당하며, submit/inline thread는 이후 전용 모듈에서 확장한다.
(function () {
  "use strict";

  /** main renderer의 공통 state/DOM helper를 받아 summary composer를 만든다. */
  window.__gscReviewCenterDraft = function createReviewCenterDraft(deps) {
    const { T, state, vscode, el, button, render } = deps;

    /** Overview에 local/server reconciliation 상태를 포함한 review draft surface를 만든다. */
    function renderReviewDraft() {
      const section = el("section", "review-center__section review-center__section--wide");
      const header = el("div", "review-center__section-header");
      header.append(el("h2", "review-center__section-title", T.reviewDraft));
      if (hasPendingReview()) header.append(el("span", "gsc-status-pill", T.pendingReview));
      section.append(header);

      const form = el("form", "review-center__draft-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); startReview(); });
      const locked = isWriteLocked();
      if (state.draft.error) form.append(statusBanner("alert", "gsc-banner gsc-banner--warning", state.draft.error));
      if (state.draft.reconcile?.kind === "headChanged") form.append(statusBanner("alert", "gsc-banner gsc-banner--warning", T.draftHeadChanged));
      if (state.draft.reconcile?.kind === "conflict") form.append(statusBanner("alert", "gsc-banner gsc-banner--warning", T.draftConflict));
      if (!state.draft.reconcile) form.append(el("div", "gsc-banner", T.loading));

      const bodyField = el("label", "gsc-field");
      bodyField.append(el("span", "gsc-field__label", T.reviewSummary));
      const body = el("textarea", "gsc-input review-center__draft-body");
      body.name = "review-draft-body";
      body.autocomplete = "off";
      body.spellcheck = true;
      body.maxLength = 65536;
      body.value = state.draft.body;
      body.readOnly = locked || state.draft.pending;
      body.setAttribute("aria-describedby", "review-center-draft-summary-hint");
      body.addEventListener("input", () => {
        state.draft.body = body.value;
        state.draft.error = "";
        vscode.postMessage({ type: "saveReviewDraft", body: state.draft.body, event: state.draft.event });
      });
      bodyField.append(body, el("span", "gsc-field__hint", T.reviewSummaryHint));
      bodyField.lastChild.id = "review-center-draft-summary-hint";

      const eventField = el("label", "gsc-field");
      eventField.append(el("span", "gsc-field__label", T.reviewEvent));
      const reviewEvent = el("select", "gsc-select");
      reviewEvent.name = "review-draft-event";
      reviewEvent.value = state.draft.event;
      reviewEvent.disabled = locked || state.draft.pending;
      [["COMMENT", T.commentReview], ["APPROVE", T.approveReview], ["REQUEST_CHANGES", T.requestChangesReview]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        reviewEvent.append(option);
      });
      reviewEvent.addEventListener("change", () => {
        state.draft.event = reviewEvent.value;
        vscode.postMessage({ type: "saveReviewDraft", body: state.draft.body, event: state.draft.event });
      });
      eventField.append(reviewEvent);
      form.append(bodyField, eventField);

      if (!hasPendingReview()) {
        const label = state.draft.pending ? T.startingReview : T.startReview;
        const start = button("gsc-button gsc-button--primary", label, label, startReview);
        start.disabled = locked || state.draft.pending || !state.draft.body.trim() || !state.draft.reconcile;
        start.setAttribute("aria-busy", String(state.draft.pending));
        form.append(start);
      } else {
        form.append(renderPendingActions());
      }
      section.append(form);
      return section;
    }

    /** pending review를 만들기 전 local body validation과 pending state를 동기화한다. */
    function startReview() {
      if (!state.draft.body.trim()) {
        state.draft.error = T.reviewSummaryHint;
        render();
        document.querySelector('textarea[name="review-draft-body"]')?.focus();
        return;
      }
      state.draft.pending = true;
      state.draft.error = "";
      render();
      vscode.postMessage({ type: "startReviewDraft", body: state.draft.body, event: state.draft.event });
    }

    /** destructive discard를 즉시 실행하지 않고 inline 확인 control로 한 번 더 묻는다. */
    function renderDiscardControl() {
      const node = el("div", "review-center__draft-discard");
      if (!state.draft.confirmDiscard) {
        const discard = button("gsc-button gsc-button--danger", T.discardReviewDraft, T.discardReviewDraft, () => {
          state.draft.confirmDiscard = true;
          render();
        });
        discard.disabled = state.draft.pending;
        node.append(discard);
        return node;
      }
      node.append(el("span", "review-center__draft-confirm-copy", T.discardReviewDraftConfirm));
      const actions = el("div", "review-center__management-actions");
      const confirm = button("gsc-button gsc-button--danger", T.discardReviewDraft, T.discardReviewDraft, discardReview);
      const keep = button("gsc-button gsc-button--ghost", T.keepReviewDraft, T.keepReviewDraft, () => { state.draft.confirmDiscard = false; render(); });
      confirm.disabled = state.draft.pending;
      keep.disabled = state.draft.pending;
      actions.append(confirm, keep);
      node.append(actions);
      return node;
    }

    /** submit은 event에 따라 GitHub 권한/의미가 달라지므로 inline 확인 뒤에만 host write를 보낸다. */
    function renderPendingActions() {
      const actions = el("div", "review-center__draft-actions");
      if (!state.draft.confirmSubmit) {
        const submitLabel = state.draft.pending ? T.submittingReview : T.submitReview;
        const submit = button("gsc-button gsc-button--primary", submitLabel, submitLabel, () => {
          state.draft.confirmSubmit = true;
          render();
        });
        submit.disabled = isWriteLocked() || state.draft.pending;
        submit.setAttribute("aria-busy", String(state.draft.pending));
        actions.append(submit, renderDiscardControl());
        return actions;
      }
      actions.append(el("span", "review-center__draft-confirm-copy", submitCopy()));
      const confirm = button("gsc-button gsc-button--primary", T.confirmSubmitReview, T.confirmSubmitReview, submitReview);
      const keep = button("gsc-button gsc-button--ghost", T.keepEditingReview, T.keepEditingReview, () => {
        state.draft.confirmSubmit = false;
        render();
      });
      confirm.disabled = state.draft.pending || isWriteLocked();
      keep.disabled = state.draft.pending;
      actions.append(confirm, keep);
      return actions;
    }

    /** host에 confirmed server/local discard를 보내고 버튼을 중복 실행하지 않게 pending 처리한다. */
    function discardReview() {
      state.draft.pending = true;
      state.draft.error = "";
      render();
      vscode.postMessage({ type: "discardReviewDraft", reviewId: state.draft.reconcile?.local?.reviewId || state.draft.reconcile?.server?.id });
    }

    /** 선택한 event와 summary를 현재 pending review에 한 번만 submit하도록 요청한다. */
    function submitReview() {
      if (state.draft.pending || isWriteLocked()) return;
      state.draft.pending = true;
      state.draft.error = "";
      state.draft.confirmSubmit = false;
      render();
      vscode.postMessage({
        type: "submitReviewDraft",
        reviewId: state.draft.reconcile?.local?.reviewId || state.draft.reconcile?.server?.id,
        body: state.draft.body,
        event: state.draft.event,
      });
    }

    /** l10n template의 event token을 사람이 읽을 수 있는 option label로 바꾼다. */
    function submitCopy() {
      const label = state.draft.event === "APPROVE" ? T.approveReview
        : state.draft.event === "REQUEST_CHANGES" ? T.requestChangesReview : T.commentReview;
      return String(T.submitReviewConfirm || "").replace("{0}", label);
    }

    /** reconciliation 결과에 server pending review가 연결됐는지 계산한다. */
    function hasPendingReview() {
      return Boolean(state.draft.reconcile?.local?.reviewId || state.draft.reconcile?.server?.id);
    }

    /** head changed/conflict 상태에서는 copy는 가능하지만 새 server write를 막는다. */
    function isWriteLocked() {
      return state.draft.reconcile?.kind === "headChanged" || state.draft.reconcile?.kind === "conflict";
    }

    /** 동적 오류/성공 문구를 assistive technology에 한 번만 알린다. */
    function statusBanner(role, className, text) {
      const banner = el("div", className, text);
      banner.setAttribute("role", role);
      return banner;
    }

    return { renderReviewDraft };
  };
}());
