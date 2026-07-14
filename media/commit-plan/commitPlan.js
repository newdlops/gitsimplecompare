// AI 커밋 플랜 웹뷰 클라이언트.
// - host가 보낸 컨텍스트/계획을 렌더하고 사용자가 메시지, 이유, 파일 배치, 순서를 편집하게 한다.
// - Git/AI 작업은 직접 수행하지 않고 검증된 postMessage 요청만 extension host로 보낸다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const contextSummaryEl = document.getElementById("context-summary");
  const promptEl = document.getElementById("additional-prompt");
  const intentEl = document.getElementById("intent-label");
  const configureBtn = document.getElementById("configure");
  const refreshBtn = document.getElementById("refresh");
  const generateBtn = document.getElementById("generate");
  const generateLabelEl = document.getElementById("generate-label");
  const executeBtn = document.getElementById("execute");
  const noticeEl = document.getElementById("notice");
  const warningsEl = document.getElementById("warnings");
  const groupsEl = document.getElementById("groups");
  const emptyPlanEl = document.getElementById("empty-plan");
  const planSummaryEl = document.getElementById("plan-summary");
  const footerStatusEl = document.getElementById("footer-status");

  const T = Object.assign(
    {
      configure: "Configure AI CLI",
      refresh: "Refresh Commit Plan Context",
      generate: "Generate Plan",
      regenerate: "Regenerate Plan",
      execute: "Create Planned Commits",
      planTitle: "Proposed Commits",
      noPlan: "Generate a plan to review proposed commits.",
      warnings: "AI plan warnings",
      commitNumber: "Commit {0}",
      commitMessage: "Commit message",
      commitReason: "Reason",
      reasonPlaceholder: "Why these files belong together",
      files: "Files",
      moveUp: "Move commit up",
      moveDown: "Move commit down",
      openFile: "Open {0}",
      moveFile: "Move {0} to another commit",
      fallback: "Fallback group",
      groupsAndFiles: "{0} commit(s), {1} file(s)",
      contextSummary: "{0} · {1} changed file(s)",
      stagedScope: "Staged changes only",
      allScope: "All working tree changes",
      staged: "Staged",
      unstaged: "Unstaged",
      currentBranch: "Current branch",
      intent: "Intent: {0}",
      refreshing: "Refreshing commit plan context...",
      generating: "Generating AI commit plan...",
      executing: "Executing AI commit plan...",
      completed: "AI commit plan completed.",
      messageRequired: "Every commit needs a message.",
      fileRequired: "Every commit needs at least one file.",
      unassignedFiles: "Every changed file must belong to one commit.",
    },
    window.__gscCommitPlanI18n || {}
  );

  let context = null;
  let result = null;
  let intent = "";
  let busyOperation = "";
  let completed = false;
  let noticeKind = "";
  const restored = vscode.getState() || {};

  /** `{0}`, `{1}` 순서형 placeholder를 전달한 값으로 치환한다. */
  function fmt(template) {
    const values = Array.prototype.slice.call(arguments, 1);
    return values.reduce(
      (text, value, index) => text.replace(`{${index}}`, String(value)),
      String(template)
    );
  }

  /** 알 수 없는 값이 null이 아닌 일반 객체인지 판별한다. */
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** plan/context에서 사용할 문자열을 null/숫자 등에 안전하게 변환한다. */
  function text(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
  }

  /** 버튼 hover tooltip과 접근성 라벨을 같은 사용자 문구로 설정한다. */
  function labelButton(button, label) {
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip", label);
  }

  /** label/input 묶음의 label DOM을 공통 클래스와 텍스트로 만든다. */
  function fieldLabel(forId, value) {
    const label = document.createElement("label");
    label.className = "field-label";
    label.htmlFor = forId;
    label.textContent = value;
    return label;
  }

  /** 현재 context에서 파일 배열을 `files`/`changes` 호환 형태로 읽는다. */
  function contextFiles() {
    if (!isObject(context)) {
      return [];
    }
    const values = Array.isArray(context.files)
      ? context.files
      : Array.isArray(context.changes)
        ? context.changes
        : [];
    return values.filter((file) => isObject(file) && text(file.path).length > 0);
  }

  /** context 파일을 경로로 빠르게 찾기 위한 Map을 만든다. */
  function contextFileMap() {
    return new Map(contextFiles().map((file) => [text(file.path), file]));
  }

  /** 현재 plan 결과를 JSON 직렬화 가능한 새 객체로 깊이 복제한다. */
  function cloneResult(value) {
    const source = isObject(value) ? value : {};
    const groups = Array.isArray(source.groups)
      ? source.groups.map((group) => ({
          message: text(group && group.message),
          reason: text(group && group.reason) || undefined,
          fallback: group && typeof group.fallback === "boolean"
            ? group.fallback
            : undefined,
          paths: Array.isArray(group && group.paths)
            ? group.paths.map(text).filter(Boolean)
            : [],
        }))
      : [];
    const warnings = Array.isArray(source.warnings)
      ? source.warnings.map(text).filter(Boolean)
      : [];
    return { groups, warnings };
  }

  /** 편집 상태에서 모든 plan 경로를 중복 제거 없이 평탄화한다. */
  function plannedPaths() {
    return result
      ? result.groups.reduce((paths, group) => paths.concat(group.paths), [])
      : [];
  }

  /** 저장소 경로에서 마지막 이름만 추출해 context 헤더에 사용한다. */
  function baseName(path) {
    const normalized = text(path).replace(/\\/g, "/").replace(/\/$/, "");
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(index + 1) : normalized;
  }

  /** host context의 저장소/브랜치/파일 개수를 상단 한 줄 요약으로 표시한다. */
  function renderContextSummary() {
    const root = isObject(context) ? text(context.repoRoot || context.root) : "";
    const branch = isObject(context)
      ? text(context.branch || context.head || T.currentBranch)
      : T.currentBranch;
    const location = [baseName(root), branch].filter(Boolean).join(" / ") || branch;
    const scope = context && context.scope === "staged" ? T.stagedScope : T.allScope;
    contextSummaryEl.textContent = `${fmt(T.contextSummary, location, contextFiles().length)} · ${scope}`;
    intentEl.textContent = intent ? fmt(T.intent, intent) : "";
  }

  /** AI가 반환한 warning 목록을 계획 위 경고 영역에 렌더한다. */
  function renderWarnings() {
    warningsEl.replaceChildren();
    const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    warningsEl.hidden = warnings.length === 0;
    if (!warnings.length) {
      return;
    }
    const title = document.createElement("strong");
    title.textContent = T.warnings;
    const list = document.createElement("ul");
    warnings.forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      list.appendChild(item);
    });
    warningsEl.append(title, list);
  }

  /** 계획 그룹 수와 고유 파일 수를 섹션 헤더/하단 상태에 동기화한다. */
  function renderPlanSummary() {
    if (!result) {
      planSummaryEl.textContent = "";
      footerStatusEl.textContent = "";
      return;
    }
    const uniqueFiles = new Set(plannedPaths()).size;
    const summary = fmt(T.groupsAndFiles, result.groups.length, uniqueFiles);
    planSummaryEl.textContent = summary;
    footerStatusEl.textContent = completed ? T.completed : summary;
  }

  /** 그룹 메시지 앞부분을 파일 이동 select의 짧은 option label로 만든다. */
  function groupOptionLabel(group, index) {
    const firstLine = text(group.message).split(/\r?\n/, 1)[0].trim();
    const compact = firstLine.length > 52 ? `${firstLine.slice(0, 49)}…` : firstLine;
    return `${fmt(T.commitNumber, index + 1)}${compact ? ` — ${compact}` : ""}`;
  }

  /** 파일 상태/라인 통계를 한 줄 메타 문자열로 만든다. */
  function fileMeta(file) {
    if (!file) {
      return "";
    }
    const status = text(file.status);
    const stage = file.staged ? T.staged : "";
    const worktree = file.unstaged ? T.unstaged : "";
    const additions = Number.isFinite(file.additions) ? `+${file.additions}` : "";
    const deletions = Number.isFinite(file.deletions) ? `-${file.deletions}` : "";
    return [status, stage, worktree, additions, deletions].filter(Boolean).join("  ");
  }

  /** 계획 파일 한 건과 다른 그룹으로 옮기는 select를 렌더한다. */
  function renderFileRow(path, groupIndex, files) {
    const row = document.createElement("li");
    row.className = "file-row";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "file-open";
    const openLabel = fmt(T.openFile, path);
    labelButton(open, openLabel);
    const pathSpan = document.createElement("span");
    pathSpan.className = "file-path";
    pathSpan.textContent = path;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = fileMeta(files.get(path));
    open.append(pathSpan, meta);
    open.addEventListener("click", () => vscode.postMessage({ type: "openFile", path }));

    const destination = document.createElement("select");
    destination.className = "file-destination";
    const moveLabel = fmt(T.moveFile, path);
    destination.title = moveLabel;
    destination.setAttribute("aria-label", moveLabel);
    result.groups.forEach((group, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = groupOptionLabel(group, index);
      option.selected = index === groupIndex;
      destination.appendChild(option);
    });
    destination.addEventListener("change", () => {
      movePath(path, Number(destination.value));
    });
    row.append(open, destination);
    return row;
  }

  /** 커밋 그룹 한 건의 메시지/이유/파일/순서 액션 카드 DOM을 만든다. */
  function renderGroup(group, index, files) {
    const card = document.createElement("article");
    card.className = "commit-group";
    card.dataset.index = String(index);

    const header = document.createElement("header");
    header.className = "group-header";
    const heading = document.createElement("div");
    heading.className = "group-heading";
    const number = document.createElement("h3");
    number.textContent = fmt(T.commitNumber, index + 1);
    heading.appendChild(number);
    if (group.fallback) {
      const fallback = document.createElement("span");
      fallback.className = "fallback-badge";
      fallback.textContent = T.fallback;
      fallback.title = T.fallback;
      heading.appendChild(fallback);
    }

    const orderActions = document.createElement("div");
    orderActions.className = "order-actions";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "icon-button secondary";
    up.innerHTML = '<span class="codicon codicon-arrow-up" aria-hidden="true"></span>';
    labelButton(up, T.moveUp);
    up.dataset.edgeDisabled = index === 0 ? "true" : "false";
    up.disabled = index === 0 || Boolean(busyOperation);
    up.addEventListener("click", () => moveGroup(index, index - 1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "icon-button secondary";
    down.innerHTML = '<span class="codicon codicon-arrow-down" aria-hidden="true"></span>';
    labelButton(down, T.moveDown);
    down.dataset.edgeDisabled =
      index === result.groups.length - 1 ? "true" : "false";
    down.disabled = index === result.groups.length - 1 || Boolean(busyOperation);
    down.addEventListener("click", () => moveGroup(index, index + 1));
    orderActions.append(up, down);
    header.append(heading, orderActions);

    const messageId = `commit-message-${index}`;
    const message = document.createElement("textarea");
    message.id = messageId;
    message.className = "commit-message";
    message.rows = 3;
    message.maxLength = 8000;
    message.value = group.message;
    message.title = T.commitMessage;
    message.setAttribute("aria-label", T.commitMessage);
    message.addEventListener("input", () => {
      group.message = message.value;
      saveState();
      syncControls();
    });

    const reasonId = `commit-reason-${index}`;
    const reason = document.createElement("textarea");
    reason.id = reasonId;
    reason.className = "commit-reason";
    reason.rows = 2;
    reason.maxLength = 4000;
    reason.value = group.reason || "";
    reason.placeholder = T.reasonPlaceholder;
    reason.title = T.commitReason;
    reason.setAttribute("aria-label", T.commitReason);
    reason.addEventListener("input", () => {
      group.reason = reason.value || undefined;
      saveState();
    });

    const filesHeader = document.createElement("div");
    filesHeader.className = "files-header";
    filesHeader.textContent = `${T.files} (${group.paths.length})`;
    const fileList = document.createElement("ul");
    fileList.className = "file-list";
    group.paths.forEach((path) => fileList.appendChild(renderFileRow(path, index, files)));

    card.append(
      header,
      fieldLabel(messageId, T.commitMessage),
      message,
      fieldLabel(reasonId, T.commitReason),
      reason,
      filesHeader,
      fileList
    );
    return card;
  }

  /** 현재 result의 모든 커밋 그룹을 편집 카드로 다시 그린다. */
  function renderGroups() {
    groupsEl.replaceChildren();
    const hasPlan = Boolean(result && result.groups.length);
    emptyPlanEl.hidden = hasPlan;
    groupsEl.hidden = !hasPlan;
    if (!hasPlan) {
      return;
    }
    const files = contextFileMap();
    result.groups.forEach((group, index) => {
      groupsEl.appendChild(renderGroup(group, index, files));
    });
  }

  /** plan 경로 하나를 현재 그룹에서 제거해 대상 그룹 끝으로 옮기고 빈 그룹은 정리한다. */
  function movePath(path, targetIndex) {
    if (!result || targetIndex < 0 || targetIndex >= result.groups.length) {
      return;
    }
    let found = false;
    result.groups.forEach((group) => {
      const before = group.paths.length;
      group.paths = group.paths.filter((item) => item !== path);
      found = found || before !== group.paths.length;
    });
    if (!found) {
      return;
    }
    result.groups[targetIndex].paths.push(path);
    result.groups = result.groups.filter((group) => group.paths.length > 0);
    saveState();
    renderAll();
  }

  /** 커밋 그룹을 위/아래 대상 인덱스로 옮기고 카드 번호를 다시 계산한다. */
  function moveGroup(from, to) {
    if (!result || to < 0 || to >= result.groups.length || from === to) {
      return;
    }
    const moved = result.groups.splice(from, 1)[0];
    result.groups.splice(to, 0, moved);
    saveState();
    renderAll();
  }

  /** 현재 편집 계획에서 실행을 막아야 할 문제를 사용자용 문자열 배열로 계산한다. */
  function validationErrors() {
    if (!result || !result.groups.length) {
      return [T.noPlan];
    }
    const errors = [];
    if (result.groups.some((group) => !text(group.message).trim())) {
      errors.push(T.messageRequired);
    }
    if (result.groups.some((group) => !group.paths.length)) {
      errors.push(T.fileRequired);
    }
    const expected = new Set(contextFiles().map((file) => text(file.path)));
    const planned = plannedPaths();
    const unique = new Set(planned);
    if (
      unique.size !== planned.length ||
      expected.size !== unique.size ||
      Array.from(expected).some((path) => !unique.has(path))
    ) {
      errors.push(T.unassignedFiles);
    }
    return errors;
  }

  /** 정적/동적 입력과 버튼의 disabled, tooltip, generate/regenerate 문구를 동기화한다. */
  function syncControls() {
    const busy = Boolean(busyOperation);
    promptEl.disabled = busy;
    configureBtn.disabled = busy;
    refreshBtn.disabled = busy;
    generateBtn.disabled = busy || !context;
    executeBtn.disabled = busy || completed || validationErrors().length > 0;
    const generateLabel = result ? T.regenerate : T.generate;
    generateLabelEl.textContent = generateLabel;
    labelButton(generateBtn, generateLabel);
    document.querySelectorAll(".commit-group textarea, .file-destination").forEach((element) => {
      element.disabled = busy || completed;
    });
    document.querySelectorAll(".commit-group button").forEach((button) => {
      button.disabled = busy || completed || button.dataset.edgeDisabled === "true";
    });
    document.body.classList.toggle("busy", busy);
  }

  /** 알림 영역에 오류/진행/완료 메시지를 줄바꿈 그대로 표시한다. */
  function showNotice(message, kind) {
    noticeKind = kind || "info";
    noticeEl.textContent = text(message);
    noticeEl.className = `notice ${noticeKind}`;
    noticeEl.hidden = !noticeEl.textContent;
  }

  /** 진행 작업 시작을 낙관적으로 표시해 중복 클릭을 host 응답 전에 막는다. */
  function startBusy(operation, message) {
    busyOperation = operation;
    showNotice(message, "progress");
    syncControls();
  }

  /** prompt와 편집 중 계획을 웹뷰 memento에 저장해 focus 전환에서 상태를 보존한다. */
  function saveState() {
    vscode.setState({
      prompt: promptEl.value,
      intent,
      result: result ? cloneResult(result) : null,
    });
  }

  /** context, warning, summary, group, controls 순서로 전체 화면을 일관되게 다시 그린다. */
  function renderAll() {
    renderContextSummary();
    renderWarnings();
    renderPlanSummary();
    renderGroups();
    syncControls();
  }

  /** host 메시지 union을 화면 상태 변경으로 적용한다. */
  function handleHostMessage(message) {
    if (!isObject(message) || typeof message.type !== "string") {
      return;
    }
    if (message.type === "context") {
      context = isObject(message.context) ? message.context : null;
      intent = text(message.intent);
      result = null;
      completed = false;
      busyOperation = "";
      promptEl.value = text(message.prompt);
      renderAll();
      saveState();
      return;
    }
    if (message.type === "plan") {
      context = isObject(message.context) ? message.context : context;
      result = cloneResult(message.result);
      completed = false;
      renderAll();
      saveState();
      return;
    }
    if (message.type === "progress") {
      busyOperation = text(message.operation);
      showNotice(message.message, "progress");
      syncControls();
      return;
    }
    if (message.type === "idle") {
      busyOperation = "";
      if (noticeKind === "progress") {
        showNotice("", "");
      }
      syncControls();
      return;
    }
    if (message.type === "error") {
      busyOperation = "";
      showNotice(message.message, "error");
      syncControls();
      return;
    }
    if (message.type === "completed") {
      busyOperation = "";
      completed = true;
      showNotice(message.message || T.completed, "success");
      renderPlanSummary();
      syncControls();
    }
  }

  /** 추가 프롬프트로 AI 계획 생성을 host에 요청한다. */
  function requestGenerate() {
    if (generateBtn.disabled) {
      return;
    }
    startBusy("generate", T.generating);
    vscode.postMessage({
      type: "generate",
      prompt: promptEl.value,
      intent: intent || undefined,
    });
  }

  /** 편집된 계획을 local 검증한 뒤 host 실행/승인 흐름에 전달한다. */
  function requestExecute() {
    const errors = validationErrors();
    if (errors.length || !result) {
      showNotice(errors.join("\n"), "error");
      return;
    }
    vscode.postMessage({ type: "execute", result: cloneResult(result) });
  }

  /** 정적 컨트롤 event를 한 번 연결한다. */
  function bindEvents() {
    configureBtn.addEventListener("click", () => {
      if (!configureBtn.disabled) {
        vscode.postMessage({ type: "configure" });
      }
    });
    refreshBtn.addEventListener("click", () => {
      if (!refreshBtn.disabled) {
        startBusy("refresh", T.refreshing);
        vscode.postMessage({ type: "refreshContext", prompt: promptEl.value });
      }
    });
    generateBtn.addEventListener("click", requestGenerate);
    executeBtn.addEventListener("click", requestExecute);
    promptEl.addEventListener("input", () => {
      saveState();
    });
    promptEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        requestGenerate();
      }
    });
    window.addEventListener("message", (event) => handleHostMessage(event.data));
  }

  if (typeof restored.prompt === "string") {
    promptEl.value = restored.prompt;
  }
  bindEvents();
  renderAll();
  vscode.postMessage({ type: "ready" });
})();
