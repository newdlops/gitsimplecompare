// Review Center의 단일 PR metadata 관리 form renderer.
// - main renderer에서 assignee/label/reviewer/stage write 상태를 분리해 화면 책임을 작게 유지한다.
(function () {
  "use strict";

  /** main renderer의 공통 DOM 도우미와 상태를 받아 관리 form API를 만든다. */
  window.__gscReviewCenterManagement = function createReviewCenterManagement(deps) {
    const { T, state, vscode, el, button, template, formatNumber, render } = deps;

    /** permission·loading·validation·confirmation 상태를 포함한 management form을 만든다. */
    function renderManagementForm() {
      const form = el("form", "review-center__management-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); previewManagement(); });
      form.append(el("h3", "review-center__management-title", T.manageMetadata));

      const operationField = el("label", "gsc-field");
      operationField.append(el("span", "gsc-field__label", T.managementOperation));
      const operation = el("select", "gsc-select");
      operation.name = "management-operation";
      operation.value = state.managementKind;
      operation.disabled = !state.snapshot.viewerCanUpdate || state.managementPending;
      [
        ["addLabels", T.addLabels], ["removeLabels", T.removeLabels],
        ["addAssignees", T.addAssignees], ["removeAssignees", T.removeAssignees],
        ["requestReviewers", T.requestReviewers], ["removeReviewers", T.removeReviewers],
        ["setMilestone", T.setMilestone], ["clearMilestone", T.clearMilestone],
        ["setDraft", T.convertToDraft], ["setReady", T.markReadyForReview]
      ].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        operation.append(option);
      });
      operation.addEventListener("change", () => {
        state.managementKind = operation.value;
        state.managementPreview = null;
        state.managementError = "";
        state.managementResult = "";
        render();
      });
      operationField.append(operation);
      form.append(operationField);

      if (managementRequiresValues()) {
        const valuesField = el("label", "gsc-field");
        const reviewerOperation = state.managementKind === "requestReviewers" || state.managementKind === "removeReviewers";
        const milestoneOperation = state.managementKind === "setMilestone";
        valuesField.append(el("span", "gsc-field__label", milestoneOperation ? T.milestoneValues : reviewerOperation ? T.reviewerValues : T.metadataValues));
        const input = el("input", "gsc-input");
        input.name = "management-values";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.inputMode = milestoneOperation ? "numeric" : "text";
        input.value = state.managementValues;
        input.disabled = !state.snapshot.viewerCanUpdate || state.managementPending;
        input.setAttribute("aria-describedby", "review-center-management-values-hint");
        input.addEventListener("input", () => {
          state.managementValues = input.value;
          state.managementPreview = null;
          state.managementError = "";
          state.managementResult = "";
        });
        valuesField.append(input, el("span", "gsc-field__hint", milestoneOperation ? T.milestoneValuesHint : reviewerOperation ? T.reviewerValuesHint : T.metadataValuesHint));
        valuesField.lastChild.id = "review-center-management-values-hint";
        form.append(valuesField);
      } else {
        form.append(el("p", "gsc-field__hint", state.managementKind === "clearMilestone" ? T.clearMilestoneHint : T.stageChangeHint));
      }

      if (!state.snapshot.viewerCanUpdate) {
        form.append(el("div", "gsc-banner gsc-banner--warning", T.metadataPermissionDenied));
        return form;
      }
      if (state.managementError) form.append(statusBanner("alert", "gsc-banner gsc-banner--warning", state.managementError));
      if (state.managementResult) form.append(statusBanner("status", "gsc-banner", state.managementResult));
      if (state.managementPreview) form.append(renderManagementPreview());
      if (!state.managementPreview) {
        const previewText = state.managementPending ? T.previewingChanges : T.previewChanges;
        const preview = button("gsc-button", previewText, previewText, previewManagement);
        preview.disabled = state.managementPending;
        preview.setAttribute("aria-busy", String(state.managementPending));
        form.append(preview);
      }
      return form;
    }

    /** 서버 write 전 실제 적용/이미 적용 항목과 confirm·cancel control을 렌더링한다. */
    function renderManagementPreview() {
      const preview = state.managementPreview;
      const node = el("div", "review-center__management-preview");
      if (preview.preview.willApply.length) node.append(el("div", "review-center__management-preview-line", template(T.willApply, preview.preview.willApply.map(formatManagementValue).join(", "))));
      if (preview.preview.alreadySet.length) node.append(el("div", "review-center__management-preview-line", template(T.alreadyRequestedState, preview.preview.alreadySet.map(formatManagementValue).join(", "))));
      if (!preview.preview.canApply) node.append(el("div", "gsc-banner gsc-banner--warning", T.noManagementChanges));
      const actions = el("div", "review-center__management-actions");
      const confirmText = state.managementPending ? T.applyingChanges : template(T.confirmChanges, formatNumber(preview.preview.willApply.length));
      const confirm = button("gsc-button gsc-button--primary", confirmText, confirmText, () => applyManagement(preview.previewId));
      confirm.disabled = state.managementPending || !preview.preview.canApply;
      confirm.setAttribute("aria-busy", String(state.managementPending));
      const cancel = button("gsc-button gsc-button--ghost", T.cancel, T.cancel, () => cancelManagementPreview(preview.previewId));
      cancel.disabled = state.managementPending;
      actions.append(confirm, cancel);
      node.append(actions);
      return node;
    }

    /** comma-separated input을 정규화해 side-effect 없는 host preview 요청을 보낸다. */
    function previewManagement() {
      const values = managementValues();
      if (managementRequiresValues() && !values.length) {
        state.managementError = T.valuesRequired;
        render();
        document.querySelector('input[name="management-values"]')?.focus();
        return;
      }
      state.managementPending = true;
      state.managementError = "";
      state.managementResult = "";
      render();
      vscode.postMessage({ type: "previewManagement", kind: state.managementKind, values });
    }

    /** 확인된 preview id만 host에 전달해 실제 mutation을 시작한다. */
    function applyManagement(previewId) {
      state.managementPending = true;
      state.managementError = "";
      render();
      vscode.postMessage({ type: "applyManagement", previewId });
    }

    /** preview를 명시적으로 폐기하고 입력값만 유지한다. */
    function cancelManagementPreview(previewId) {
      state.managementPreview = null;
      state.managementError = "";
      render();
      vscode.postMessage({ type: "cancelManagementPreview", previewId });
    }

    /** ARIA status role을 붙인 management 결과 banner를 만든다. */
    function statusBanner(role, className, text) {
      const banner = el("div", className, text);
      banner.setAttribute("role", role);
      return banner;
    }

    /** 쉼표 입력에서 공백/중복을 제거해 webview와 host가 같은 값을 사용하게 한다. */
    function managementValues() {
      return [...new Set(state.managementValues.split(",").map((value) => value.trim()).filter(Boolean))];
    }

    /** draft/ready는 별도 이름 없이 PR stage만 바꾸므로 입력 field를 만들지 않는다. */
    function managementRequiresValues() {
      return state.managementKind !== "setDraft" && state.managementKind !== "setReady" && state.managementKind !== "clearMilestone";
    }

    /** API 비교용 user: prefix를 confirmation 문장에서는 @login으로 읽기 좋게 표시한다. */
    function formatManagementValue(value) {
      return value.startsWith("user:") ? `@${value.slice("user:".length)}` : value;
    }

    return { renderManagementForm };
  };
}());
