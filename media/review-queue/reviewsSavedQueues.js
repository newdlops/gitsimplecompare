// Reviews Management 탭의 saved queue 편집 surface.
// - 홈 렌더러에서 분리해 저장·선택·수정·순서 변경의 상태 전이를 한 응집된 모듈로 유지한다.
(function () {
  "use strict";

  /** saved queue UI가 필요로 하는 DOM helper와 host bridge를 받아 render 함수를 노출한다. */
  window.__gscReviewsSavedQueues = function ({ T, state, vscode, element, iconButton, actionButton, render }) {
    /** 활성 id에 해당하는 최신 queue를 찾아 편집·미리보기의 단일 기준으로 사용한다. */
    function activeQueue() {
      return state.savedQueues.queues.find((queue) => queue.id === state.savedQueues.activeId);
    }

    /** 선택을 바꿀 때만 편집 draft를 최신 저장 definition으로 초기화한다. */
    function setActiveDraft(queue) {
      state.savedQueues.editId = queue?.id || "";
      state.savedQueues.editName = queue?.name || "";
      state.savedQueues.editQuery = queue?.query || "";
    }

    /** Management 검색 범위·저장 큐 picker·생성/수정 surface를 한 card로 구성한다. */
    function renderSavedQueues() {
      const saved = state.savedQueues;
      const section = element("section", "reviews__saved");
      const heading = element("div", "reviews__lane-header");
      heading.append(element("h2", "reviews__lane-title", T.savedQueues));
      section.append(heading, element("p", "reviews__saved-note", T.savedQueuesLocalOnly));
      section.append(renderManagementScope());
      if (saved.error) {
        const error = element("div", "gsc-banner gsc-banner--warning", saved.error);
        error.setAttribute("role", "alert");
        section.append(error);
      }
      section.append(renderPicker());
      const selected = activeQueue();
      if (selected) section.append(renderActiveQueue(selected));
      section.append(renderCreateForm());
      return section;
    }

    /** 저장 순서를 유지하는 picker에서 query를 선택하면 즉시 활성 draft와 Management 검색을 바꾼다. */
    function renderPicker() {
      const saved = state.savedQueues;
      const field = element("label", "gsc-field");
      field.append(element("span", "gsc-field__label", T.savedQueues));
      const picker = element("select", "gsc-select");
      picker.name = "saved-review-queue";
      const open = element("option", "", T.openManagementQueue);
      open.value = "";
      picker.append(open);
      saved.queues.forEach((queue) => {
        const option = element("option", "", queue.name);
        option.value = queue.id;
        option.title = queue.query;
        picker.append(option);
      });
      picker.value = saved.activeId || "";
      picker.addEventListener("change", () => {
        const selected = saved.queues.find((queue) => queue.id === picker.value);
        saved.activeId = picker.value;
        saved.error = "";
        saved.confirmDelete = false;
        setActiveDraft(selected);
        vscode.setState(state);
        vscode.postMessage({ type: "selectSavedQueue", ...(picker.value ? { id: picker.value } : {}) });
        render();
      });
      field.append(picker);
      return field;
    }

    /** 활성 queue의 실제 qualifier를 명시하고 수정·순서·삭제의 되돌릴 수 있는 조작을 제공한다. */
    function renderActiveQueue(queue) {
      const saved = state.savedQueues;
      if (saved.editId !== queue.id) setActiveDraft(queue);
      const form = element("form", "reviews__saved-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); updateSavedQueue(queue); });
      form.append(element("h3", "reviews__saved-title", T.editSavedQueue));
      const preview = element("p", "reviews__saved-query", queue.query);
      preview.title = queue.query;
      preview.setAttribute("aria-label", T.savedQueueQueryPreview);
      form.append(preview);
      form.append(renderSavedInput("saved-review-queue-edit-name", T.savedQueueName, "editName"));
      const query = renderSavedInput("saved-review-queue-edit-query", T.savedQueueQuery, "editQuery");
      query.querySelector("input")?.setAttribute("aria-describedby", "saved-review-queue-edit-query-hint");
      const hint = element("span", "gsc-field__hint", T.savedQueueQueryHint);
      hint.id = "saved-review-queue-edit-query-hint";
      query.append(hint);
      form.append(query);
      const actions = element("div", "reviews__saved-actions");
      actions.append(actionButton("gsc-button", T.updateSavedQueue, () => updateSavedQueue(queue)));
      const index = saved.queues.findIndex((item) => item.id === queue.id);
      const up = iconButton(T.moveSavedQueueUp, "↑", () => moveSavedQueue(queue.id, "up"));
      up.disabled = index <= 0;
      const down = iconButton(T.moveSavedQueueDown, "↓", () => moveSavedQueue(queue.id, "down"));
      down.disabled = index < 0 || index >= saved.queues.length - 1;
      actions.append(up, down, renderDeleteSavedQueue());
      form.append(actions);
      return form;
    }

    /** 현재 저장소·소유자 전체·team review 요청 범위를 명시적으로 전환한다. */
    function renderManagementScope() {
      const scope = state.managementScope;
      if (!["repository", "owner", "team"].includes(scope.kind)) scope.kind = "repository";
      const modeField = element("label", "gsc-field");
      modeField.append(element("span", "gsc-field__label", T.managementScope));
      const mode = element("select", "gsc-select");
      mode.name = "management-scope-kind";
      [["repository", T.repositoryScope], ["owner", T.ownerScope], ["team", T.teamScope]].forEach(([value, label]) => {
        const option = element("option", "", label);
        option.value = value;
        mode.append(option);
      });
      mode.value = scope.kind;
      mode.addEventListener("change", () => {
        scope.kind = mode.value;
        scope.value = "";
        scope.error = "";
        if (scope.kind === "repository") vscode.postMessage({ type: "selectManagementScope", kind: "repository" });
        render();
      });
      modeField.append(mode);
      const wrap = element("div", "reviews__scope");
      wrap.append(modeField);
      if (scope.kind === "repository") {
        const actions = element("div", "reviews__saved-actions");
        actions.append(iconButton(T.repositoryScope, "⌂", () => vscode.postMessage({ type: "selectManagementScope", kind: "repository" })));
        wrap.append(actions);
        return wrap;
      }
      const field = element("label", "gsc-field");
      const isTeam = scope.kind === "team";
      field.append(element("span", "gsc-field__label", isTeam ? T.teamScope : T.ownerScope));
      const input = element("input", "gsc-input");
      input.name = "management-scope-value";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = isTeam ? T.teamScope : T.ownerScope;
      input.value = scope.value || "";
      input.setAttribute("aria-describedby", "management-scope-value-hint");
      input.addEventListener("input", () => { scope.value = input.value; scope.error = ""; vscode.setState(state); });
      const hint = element("span", "gsc-field__hint", isTeam ? T.teamScopeHint : T.ownerScopeHint);
      hint.id = "management-scope-value-hint";
      field.append(input, hint);
      const actions = element("div", "reviews__saved-actions");
      actions.append(
        iconButton(T.applyManagementScope, "→", () => vscode.postMessage({ type: "selectManagementScope", kind: scope.kind, value: scope.value })),
        iconButton(T.repositoryScope, "⌂", () => { scope.kind = "repository"; scope.value = ""; vscode.postMessage({ type: "selectManagementScope", kind: "repository" }); })
      );
      wrap.append(field, actions);
      return wrap;
    }

    /** 새 queue 또는 선택 queue draft의 input 하나를 상태 동기화와 함께 만든다. */
    function renderSavedInput(name, label, key) {
      const field = element("label", "gsc-field");
      field.append(element("span", "gsc-field__label", label));
      const input = element("input", "gsc-input");
      input.name = name;
      input.autocomplete = "off";
      input.value = state.savedQueues[key] || "";
      input.addEventListener("input", () => { state.savedQueues[key] = input.value; state.savedQueues.error = ""; vscode.setState(state); });
      field.append(input);
      return field;
    }

    /** 새 검색 조건은 별도 form으로 저장해 활성 queue 편집과 생성 의도를 구분한다. */
    function renderCreateForm() {
      const form = element("form", "reviews__saved-form");
      form.addEventListener("submit", (event) => { event.preventDefault(); createSavedQueue(); });
      form.append(element("h3", "reviews__saved-title", T.newSavedQueue));
      form.append(renderSavedInput("saved-review-queue-name", T.savedQueueName, "name"));
      const query = renderSavedInput("saved-review-queue-query", T.savedQueueQuery, "query");
      query.querySelector("input")?.setAttribute("aria-describedby", "saved-review-queue-query-hint");
      const hint = element("span", "gsc-field__hint", T.savedQueueQueryHint);
      hint.id = "saved-review-queue-query-hint";
      query.append(hint);
      form.append(query, iconButton(T.createSavedQueue, "+", createSavedQueue));
      return form;
    }

    /** 삭제는 active id만 대상으로 하고 inline confirmation을 거쳐 host write를 요청한다. */
    function renderDeleteSavedQueue() {
      const saved = state.savedQueues;
      if (!saved.confirmDelete) return iconButton(T.deleteSavedQueue, "−", () => { saved.confirmDelete = true; render(); });
      const row = element("span", "reviews__saved-actions");
      row.append(element("span", "reviews__saved-confirm", T.deleteSavedQueueConfirm));
      row.append(
        iconButton(T.deleteSavedQueue, "−", () => vscode.postMessage({ type: "deleteSavedQueue", id: saved.activeId })),
        iconButton(T.keepSavedQueue, "×", () => { saved.confirmDelete = false; render(); })
      );
      return row;
    }

    /** 빈 새 queue 입력은 host write 전에 오류와 해당 input focus로 복구한다. */
    function createSavedQueue() {
      const saved = state.savedQueues;
      if (!saved.name.trim() || !saved.query.trim()) {
        saved.error = !saved.name.trim() ? T.savedQueueName : T.savedQueueQuery;
        render();
        document.querySelector(`input[name="${!saved.name.trim() ? "saved-review-queue-name" : "saved-review-queue-query"}"]`)?.focus();
        return;
      }
      saved.error = "";
      vscode.postMessage({ type: "createSavedQueue", name: saved.name, query: saved.query });
    }

    /** 활성 queue 수정도 새 queue와 같은 공백 검증·focus 복구를 제공한다. */
    function updateSavedQueue(queue) {
      const saved = state.savedQueues;
      if (!saved.editName.trim() || !saved.editQuery.trim()) {
        saved.error = !saved.editName.trim() ? T.savedQueueName : T.savedQueueQuery;
        render();
        document.querySelector(`input[name="${!saved.editName.trim() ? "saved-review-queue-edit-name" : "saved-review-queue-edit-query"}"]`)?.focus();
        return;
      }
      saved.error = "";
      vscode.postMessage({ type: "updateSavedQueue", id: queue.id, name: saved.editName, query: saved.editQuery });
    }

    /** 순서 조작은 host 저장이 성공한 뒤의 savedQueues 메시지로만 확정한다. */
    function moveSavedQueue(id, direction) {
      state.savedQueues.error = "";
      vscode.postMessage({ type: "moveSavedQueue", id, direction });
    }

    return { renderSavedQueues, setActiveDraft };
  };
}());
