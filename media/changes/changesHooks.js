// Changes 커밋 박스의 로컬 commit hook 관리와 마지막 실패 진단 카드 UI.
// - 메인 changes.js 렌더러를 키우지 않고 render payload 를 받아 DOM 을 독립적으로 보강한다.
(function () {
  "use strict";

  const vscode = window.__gscVscode;
  const rootEl = document.getElementById("root");
  const T = Object.assign(
    {
      commitHooks: "File-based Commit Hooks",
      manageCommitHooks: "Manage file-based commit hooks",
      activeCommitHooks: "{0} file hooks active",
      refreshCommitHooks: "Refresh file-based commit hooks",
      openCommitHooksFolder: "Open hooks folder",
      createCommitHook: "Create commit hook",
      noCommitHooks: "No file-based commit hooks found.",
      fileBasedHookScope: "Traditional hook files only. Hooks configured with hook.* are not shown.",
      hookDirectory: "Hook directory: {0}",
      hookConfigOrigin: "Configured by {0}",
      sharedHookPath: "This hook path may be shared by multiple repositories.",
      hookPathUnavailable: "The configured hook path is not a directory. Hooks are disabled.",
      hookStateUnavailable: "Commit hook status is unavailable. Refresh to try again.",
      enabledHook: "Enabled",
      disabledHook: "Disabled",
      notExecutableHook: "Not executable",
      missingHookEntrypoint: "The Git hook entrypoint is missing or not executable",
      conflictingHookFiles: "Active and disabled files both exist",
      trackedHook: "Tracked",
      worktreeHook: "Untracked",
      trackedHookToggleBlocked: "Tracked hooks cannot be toggled here because that would change the working tree.",
      worktreeHookToggleBlocked: "This untracked hook cannot be toggled here because Commit All could include it.",
      proxyHookToggleBlocked: "Husky proxy hooks must be enabled or disabled through Husky.",
      symbolicHookToggleBlocked: "Symbolic-link hooks can be opened but are not toggled here.",
      platformHookToggleBlocked: "Safe hook toggling is unavailable on this platform.",
      renamedHookToggleBlocked: "Hooks already renamed to .disabled can be opened but are not renamed here.",
      enableCommitHook: "Enable {0}",
      disableCommitHook: "Disable {0}",
      openCommitHook: "Open {0}",
      commitChecksFailed: "Commit checks failed",
      commitFailedDetails: "Commit failed",
      retryCommit: "Retry commit",
      dismissCommitFailure: "Dismiss commit failure",
      showFullOutput: "Show full output",
      openFailureLocation: "Open {0} at line {1}",
      noFailureLocations: "The check did not report a file location. See the full output for details.",
      failureItemsTruncated: "Some failures are hidden. See the full output.",
      hookFramework: "Managed by {0}",
      updatingCommitHooks: "Updating commit hooks...",
    },
    window.__gscI18n || {}
  );

  let latestCommit = null;
  let managerExpanded = false;
  let requestedHookRepo = "";
  let commitBusy = false;
  let pendingHookName = "";
  let refreshing = false;
  let creating = false;
  let scheduled = false;

  if (!vscode || !rootEl) {
    return;
  }

  /**
   * hook 경로와 진단처럼 host에서 받은 값을 HTML 본문/속성에 안전하게 넣도록 이스케이프한다.
   * @param {*} value 문자열로 바꿀 외부 값
   * @returns {string} HTML 특수 문자가 entity로 치환된 문자열
   */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * `{0}` 형식 지역화 문자열을 웹뷰에서도 VS Code 런타임과 같은 순서로 조립한다.
   * @param {string} template 자리표시자가 포함된 지역화 문자열
   * @param {...*} values 자리표시자에 넣을 값
   * @returns {string} 전달된 값이 반영된 표시 문자열
   */
  function format(template) {
    const values = Array.prototype.slice.call(arguments, 1);
    return values.reduce(
      (text, value, index) => text.replace(`{${index}}`, String(value)),
      String(template)
    );
  }

  /**
   * render 메시지와 MutationObserver가 연속 호출돼도 다음 animation frame에 한 번만 그린다.
   * @returns {void} 예약 상태만 갱신하며 DOM 변경은 animation frame callback에서 수행한다.
   */
  function scheduleRender() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      renderHookUi();
    });
  }

  /**
   * 현재 commit payload를 바탕으로 관리 버튼, 패널, 실패 카드를 커밋 박스에 주입한다.
   * - host render가 기존 DOM을 교체해도 사용자의 focus와 실패 목록 scroll 위치를 복원한다.
   * @returns {void} 현재 웹뷰 DOM을 제자리에서 갱신한다.
   */
  function renderHookUi() {
    const focusedId = rootEl.contains(document.activeElement)
      ? document.activeElement.id
      : "";
    const failureScrollTop = rootEl.querySelector(".failure-list")?.scrollTop || 0;
    const box = rootEl.querySelector(".commit-box");
    const bar = rootEl.querySelector(".commit-bar");
    if (!box || !bar || !latestCommit) {
      return;
    }
    requestExpandedManagerState();
    renderManageButton(bar);
    box.querySelector(".commit-hooks-stack")?.remove();

    const stack = document.createElement("div");
    stack.className = "commit-hooks-stack";
    const failure = latestCommit.failure;
    const snapshot = latestCommit.hooks;
    stack.innerHTML =
      (failure ? failureHtml(failure) : "") +
      (managerExpanded ? managerHtml(snapshot) : "");
    if (stack.childElementCount) {
      box.appendChild(stack);
      bindFailureActions(stack, failure);
      bindManagerActions(stack);
    }
    reflectCommitBusy();
    if (focusedId) {
      document.getElementById(focusedId)?.focus({ preventScroll: true });
    }
    const failureList = rootEl.querySelector(".failure-list");
    if (failureList) {
      failureList.scrollTop = failureScrollTop;
    }
  }

  /**
   * 펼쳐 둔 hook 관리 패널에서 저장소가 바뀌면 새 저장소 상태를 한 번 자동 요청한다.
   * - 같은 저장소의 실패를 render마다 무한 재시도하지 않고, 사용자가 refresh 버튼으로 다시 시도할 수 있게 한다.
   * @returns 반환값 없이 저장소별 최초 요청이 필요할 때만 host 메시지를 전송한다
   */
  function requestExpandedManagerState() {
    const repoRoot = latestCommit?.repoRoot || "";
    if (
      !managerExpanded ||
      !latestCommit?.hasRepo ||
      latestCommit?.hooks ||
      refreshing ||
      requestedHookRepo === repoRoot
    ) {
      return;
    }
    requestedHookRepo = repoRoot;
    refreshing = true;
    vscode.postMessage({ type: "refreshCommitHooks" });
  }

  /**
   * 커밋 바에 활성 파일 hook 개수와 펼침 상태를 표시하는 관리 버튼을 만든다.
   * @param {Element} bar 버튼을 삽입할 커밋 toolbar 요소
   * @returns {void} 기존 관리 버튼을 교체해 중복 생성을 막는다.
   */
  function renderManageButton(bar) {
    document.getElementById("commit-hooks-btn")?.remove();
    const loaded = !!latestCommit?.hooks;
    const hooks = latestCommit?.hooks?.hooks || [];
    const active = hooks.filter((hook) => hook.enabled).length;
    const detail = format(T.activeCommitHooks, active);
    const tooltip = loaded
      ? `${T.manageCommitHooks} · ${detail}`
      : T.manageCommitHooks;
    const button = document.createElement("button");
    button.id = "commit-hooks-btn";
    button.className = "commit-hooks-btn";
    button.type = "button";
    button.title = tooltip;
    button.dataset.tooltip = tooltip;
    button.setAttribute("aria-label", tooltip);
    button.setAttribute("aria-expanded", managerExpanded ? "true" : "false");
    button.innerHTML =
      '<span class="codicon codicon-shield" aria-hidden="true"></span>' +
      (loaded ? `<span class="commit-hooks-count">${active}</span>` : "");
    button.addEventListener("click", () => {
      managerExpanded = !managerExpanded;
      // 초기 화면에서는 고비용 hook 검사를 생략하고, 사용자가 관리 패널을 실제로 열 때 한 번만 요청한다.
      if (managerExpanded && !latestCommit?.hooks && !refreshing) {
        requestedHookRepo = latestCommit?.repoRoot || "";
        refreshing = true;
        vscode.postMessage({ type: "refreshCommitHooks" });
      }
      renderHookUi();
    });
    const commitButton = document.getElementById("commit-btn");
    bar.insertBefore(button, commitButton || null);
  }

  /**
   * hook 스냅샷을 경로, 범위 안내, toolbar, 설치 hook 행으로 구성한 패널 HTML로 만든다.
   * @param {object|null|undefined} snapshot host가 조회한 파일 기반 hook 상태
   * @returns {string} 커밋 박스에 삽입할 관리 패널 HTML
   */
  function managerHtml(snapshot) {
    const hooks = snapshot?.hooks || [];
    const directory = snapshot?.directory || "";
    const pathTitle = directory
      ? format(T.hookDirectory, directory)
      : T.commitHooks;
    const framework = snapshot?.framework
      ? `<span class="hook-framework">${esc(format(T.hookFramework, snapshot.framework))}</span>`
      : "";
    const configOrigin = snapshot?.configOrigin
      ? `<span class="hook-config-origin">${esc(format(T.hookConfigOrigin, snapshot.configOrigin))}</span>`
      : "";
    const shared = snapshot?.shared
      ? `<div class="hook-shared"><span class="codicon codicon-warning"></span>${esc(T.sharedHookPath)}</div>`
      : "";
    const rows = !snapshot
      ? `<div class="hook-empty warning">${esc(T.hookStateUnavailable)}</div>`
      : snapshot.directoryState === "notDirectory"
      ? `<div class="hook-empty warning">${esc(T.hookPathUnavailable)}</div>`
      : hooks.length
      ? hooks.map(hookRowHtml).join("")
      : `<div class="hook-empty">${esc(T.noCommitHooks)}</div>`;
    return (
      `<section class="commit-hooks-manager" aria-label="${esc(T.commitHooks)}">` +
      `<header class="hook-manager-header"><div class="hook-manager-title">` +
      `<span class="codicon codicon-tools" aria-hidden="true"></span>` +
      `<span>${esc(T.commitHooks)}</span>${framework}</div>` +
      `<div class="hook-manager-actions">` +
      iconButton("hook-refresh", refreshing ? "loading codicon-modifier-spin" : "refresh", T.refreshCommitHooks, refreshing || creating || !!pendingHookName, refreshing) +
      iconButton("hook-folder", "folder-opened", T.openCommitHooksFolder, snapshot?.directoryState !== "ready" || refreshing || creating || !!pendingHookName) +
      iconButton("hook-create", creating ? "loading codicon-modifier-spin" : "add", T.createCommitHook, !snapshot || snapshot.directoryState === "notDirectory" || refreshing || creating || !!pendingHookName, creating) +
      `</div></header>` +
      `<div class="hook-directory" title="${esc(pathTitle)}">${esc(directory || pathTitle)}</div>` +
      `<div class="hook-scope-note">${esc(T.fileBasedHookScope)}</div>` +
      configOrigin +
      shared +
      `<div class="hook-list">${rows}</div></section>`
    );
  }

  /**
   * 표준 hook 한 건의 실행 상태와 작업트리 안전성, 열기/토글 동작을 한 행으로 만든다.
   * @param {object} hook host가 검사한 hook entry
   * @returns {string} tooltip과 접근성 상태를 포함한 hook 행 HTML
   */
  function hookRowHtml(hook) {
    const status = hookStatus(hook);
    const openLabel = format(T.openCommitHook, hook.name);
    const toggleLabel = hook.enabled
      ? format(T.disableCommitHook, hook.name)
      : format(T.enableCommitHook, hook.name);
    const blocked = pendingHookName || refreshing || creating
      ? T.updatingCommitHooks
      : toggleBlockedLabel(hook, toggleLabel);
    const busy = pendingHookName === hook.name;
    return (
      `<div class="hook-row${hook.enabled ? " enabled" : " disabled"}" data-hook="${esc(hook.name)}">` +
      `<span class="hook-status codicon ${status.icon}" title="${esc(status.label)}" ` +
      `aria-label="${esc(status.label)}"></span>` +
      `<button id="hook-open-${esc(hook.name)}" class="hook-open" type="button" title="${esc(openLabel)}" ` +
      `data-tooltip="${esc(openLabel)}" aria-label="${esc(openLabel)}">${esc(hook.name)}</button>` +
      (hook.tracked ? `<span class="hook-badge tracked" title="${esc(T.trackedHook)}">${esc(T.trackedHook)}</span>` : "") +
      (hook.worktreeVisible ? `<span class="hook-badge tracked" title="${esc(T.worktreeHook)}">${esc(T.worktreeHook)}</span>` : "") +
      `<span class="hook-row-actions">` +
      `<button id="hook-toggle-${esc(hook.name)}" class="hook-toggle${busy ? " busy" : ""}" type="button" ` +
      `title="${esc(blocked)}" data-tooltip="${esc(blocked)}" aria-label="${esc(blocked)}" ` +
      `aria-pressed="${hook.enabled ? "true" : "false"}" ` +
      `aria-busy="${busy ? "true" : "false"}" ` +
      `${!hook.canToggle || !!pendingHookName || refreshing || creating ? "disabled" : ""}>` +
      `<span class="codicon ${busy ? "codicon-loading codicon-modifier-spin" : hook.enabled ? "codicon-check" : "codicon-circle-slash"}" aria-hidden="true"></span>` +
      `<span>${esc(hook.enabled ? T.enabledHook : T.disabledHook)}</span></button>` +
      `</span></div>`
    );
  }

  /**
   * hook의 파일/entrypoint 상태를 UI에서 구분 가능한 아이콘과 지역화 상태명으로 변환한다.
   * @param {object} hook 상태 필드를 가진 hook entry
   * @returns {{icon: string, label: string}} codicon class와 사용자 표시명
   */
  function hookStatus(hook) {
    if (hook.state === "conflict") {
      return { icon: "codicon-warning", label: T.conflictingHookFiles };
    }
    if (hook.state === "notExecutable") {
      return { icon: "codicon-circle-slash", label: T.notExecutableHook };
    }
    if (hook.state === "entrypointMissing") {
      return { icon: "codicon-warning", label: T.missingHookEntrypoint };
    }
    return hook.enabled
      ? { icon: "codicon-pass-filled", label: T.enabledHook }
      : { icon: "codicon-circle-slash", label: T.disabledHook };
  }

  /**
   * 서비스가 계산한 안전 차단 이유를 사용자가 조치할 수 있는 tooltip 문구로 변환한다.
   * @param {object} hook toggleBlockedReason을 가진 hook entry
   * @param {string} fallback 차단 이유가 없을 때 표시할 Enable/Disable 문구
   * @returns {string} 토글 버튼의 tooltip과 접근성 이름
   */
  function toggleBlockedLabel(hook, fallback) {
    switch (hook.toggleBlockedReason) {
      case "tracked": return T.trackedHookToggleBlocked;
      case "worktree": return T.worktreeHookToggleBlocked;
      case "conflict": return T.conflictingHookFiles;
      case "entrypoint": return T.missingHookEntrypoint;
      case "proxy": return T.proxyHookToggleBlocked;
      case "symbolicLink": return T.symbolicHookToggleBlocked;
      case "platform": return T.platformHookToggleBlocked;
      case "renamed": return T.renamedHookToggleBlocked;
      default: return fallback;
    }
  }

  /**
   * toolbar의 codicon 버튼을 일관된 tooltip, disabled, busy 접근성 속성과 함께 만든다.
   * @param {string} id 이벤트 연결과 focus 복원에 쓸 DOM id
   * @param {string} icon codicon 이름
   * @param {string} label tooltip과 접근성 이름
   * @param {boolean} disabled 클릭 차단 여부
   * @param {boolean} busy 진행 중 표시 여부
   * @returns {string} 완성된 button HTML
   */
  function iconButton(id, icon, label, disabled, busy) {
    return (
      `<button id="${esc(id)}" class="hook-icon-button" type="button" ` +
      `title="${esc(label)}" data-tooltip="${esc(label)}" aria-label="${esc(label)}" ` +
      `aria-busy="${busy ? "true" : "false"}" ` +
      `${disabled ? "disabled" : ""}>` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`
    );
  }

  /**
   * 마지막 commit 실패를 파일 위치 목록과 Retry/OUTPUT 액션이 있는 labelled region으로 만든다.
   * @param {object} failure host가 파싱하고 원문 출력과 함께 보존한 실패 진단
   * @returns {string} 반복 live 낭독 없이 탐색 가능한 실패 카드 HTML
   */
  function failureHtml(failure) {
    const title = failure.likelyHook ? T.commitChecksFailed : T.commitFailedDetails;
    const meta = [failure.hookName, failure.checkName]
      .filter(Boolean)
      .map((value) => `<span class="failure-badge">${esc(value)}</span>`)
      .join("");
    const items = (failure.items || []).length
      ? `<div class="failure-list">${failure.items.map(failureItemHtml).join("")}</div>`
      : `<div class="failure-empty">${esc(T.noFailureLocations)}</div>`;
    return (
      `<section class="commit-failure-card" role="region" aria-labelledby="commit-failure-title">` +
      `<header class="failure-header"><span class="codicon codicon-error" aria-hidden="true"></span>` +
      `<span id="commit-failure-title" class="failure-title">${esc(title)}</span>${meta}` +
      iconButton("failure-dismiss", "close", T.dismissCommitFailure, false) +
      `</header><div class="failure-summary">${esc(failure.summary)}</div>` +
      items +
      (failure.truncated ? `<div class="failure-truncated">${esc(T.failureItemsTruncated)}</div>` : "") +
      `<div class="failure-actions">` +
      `<button id="failure-retry" type="button" title="${esc(T.retryCommit)}" ` +
      `data-tooltip="${esc(T.retryCommit)}" aria-label="${esc(T.retryCommit)}" ${commitBusy ? "disabled" : ""}>` +
      `<span class="codicon ${commitBusy ? "codicon-loading codicon-modifier-spin" : "codicon-debug-rerun"}" aria-hidden="true"></span>${esc(T.retryCommit)}</button>` +
      `<button id="failure-output" type="button" title="${esc(T.showFullOutput)}" ` +
      `data-tooltip="${esc(T.showFullOutput)}" aria-label="${esc(T.showFullOutput)}">` +
      `<span class="codicon codicon-output" aria-hidden="true"></span>${esc(T.showFullOutput)}</button>` +
      `</div></section>`
    );
  }

  /**
   * 실패 항목을 위치가 있으면 클릭 가능한 버튼, 없으면 읽기 전용 메시지 행으로 만든다.
   * @param {object} item 경로, 행/열, 심각도와 메시지를 가진 진단 한 건
   * @returns {string} 파일 열기 metadata를 포함한 진단 행 HTML
   */
  function failureItemHtml(item) {
    const location = item.path
      ? [item.path, item.line, item.column].filter((value) => value != null).join(":")
      : "";
    const label = item.path
      ? format(T.openFailureLocation, item.path, item.line || 1)
      : item.message;
    const accessibleLabel = item.path ? `${label}: ${item.message}` : label;
    const tag = item.path ? "button" : "div";
    const attrs = item.path
      ? `type="button" title="${esc(label)}" data-tooltip="${esc(label)}" aria-label="${esc(accessibleLabel)}" ` +
        `data-path="${esc(item.path)}" data-line="${esc(item.line || 1)}" data-column="${esc(item.column || 1)}"`
      : `title="${esc(item.message)}"`;
    return (
      `<${tag} class="failure-item severity-${esc(item.severity)}" ${attrs}>` +
      `<span class="codicon ${item.severity === "warning" ? "codicon-warning" : item.severity === "info" ? "codicon-info" : "codicon-error-small"}" aria-hidden="true"></span>` +
      `<span class="failure-item-content">` +
      (location ? `<span class="failure-location">${esc(location)}</span>` : "") +
      `<span class="failure-message">${esc(item.message)}</span></span></${tag}>`
    );
  }

  /**
   * 관리 패널의 새로고침, 폴더, 생성, 열기, 토글 이벤트를 host 메시지에 연결한다.
   * @param {Element} stack 현재 render에서 새로 만든 hook UI 컨테이너
   * @returns {void} 이벤트 listener만 등록하며 실제 파일 변경은 host 명령에 위임한다.
   */
  function bindManagerActions(stack) {
    stack.querySelector("#hook-refresh")?.addEventListener("click", () => {
      refreshing = true;
      renderHookUi();
      vscode.postMessage({ type: "refreshCommitHooks" });
    });
    stack.querySelector("#hook-folder")?.addEventListener("click", () =>
      vscode.postMessage({ type: "openCommitHooksFolder" })
    );
    stack.querySelector("#hook-create")?.addEventListener("click", () =>
      beginCreateHook()
    );
    stack.querySelectorAll(".hook-open").forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.closest(".hook-row")?.dataset.hook;
        vscode.postMessage({ type: "openCommitHook", hookName: name });
      });
    });
    stack.querySelectorAll(".hook-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const row = button.closest(".hook-row");
        const name = row?.dataset.hook;
        const hook = latestCommit?.hooks?.hooks?.find((entry) => entry.name === name);
        if (!hook || !hook.canToggle || pendingHookName) {
          return;
        }
        pendingHookName = name;
        renderHookUi();
        vscode.postMessage({
          type: "toggleCommitHook",
          hookName: name,
          enabled: !hook.enabled,
        });
      });
    });
  }

  /**
   * 중복 create 요청을 막기 위해 UI를 즉시 busy 처리한 뒤 host에 생성을 요청한다.
   * @returns {void} host 완료 메시지가 올 때까지 생성 버튼 상태를 보존한다.
   */
  function beginCreateHook() {
    if (creating || refreshing || pendingHookName) {
      return;
    }
    creating = true;
    renderHookUi();
    vscode.postMessage({ type: "createCommitHook" });
  }

  /**
   * 실패 파일 열기, Retry, OUTPUT, Dismiss 버튼을 해당 host 명령 메시지에 연결한다.
   * @param {Element} stack 실패 카드가 들어 있는 현재 hook UI 컨테이너
   * @param {object|null} failure Retry operation과 진단 위치를 제공하는 마지막 실패
   * @returns {void} 실패가 없으면 listener를 만들지 않는다.
   */
  function bindFailureActions(stack, failure) {
    if (!failure) {
      return;
    }
    stack.querySelectorAll("button.failure-item").forEach((button) => {
      button.addEventListener("click", () =>
        vscode.postMessage({
          type: "openCommitFailure",
          path: button.dataset.path,
          line: Number(button.dataset.line) || 1,
          column: Number(button.dataset.column) || 1,
        })
      );
    });
    stack.querySelector("#failure-dismiss")?.addEventListener("click", () =>
      vscode.postMessage({ type: "dismissCommitFailure" })
    );
    stack.querySelector("#failure-output")?.addEventListener("click", () =>
      vscode.postMessage({ type: "showCommitFailureOutput" })
    );
    stack.querySelector("#failure-retry")?.addEventListener("click", () => {
      if (commitBusy) {
        return;
      }
      commitBusy = true;
      reflectCommitBusy();
      const textarea = document.getElementById("commit-msg");
      vscode.postMessage({
        type: "commit",
        op: failure.operation || "commit",
        message: textarea ? textarea.value : "",
      });
    });
  }

  /**
   * host의 commit 진행 상태를 Retry 버튼의 spinner, disabled, aria-busy 속성에 반영한다.
   * @returns {void} 실패 카드가 닫혀 Retry 버튼이 없으면 아무 것도 변경하지 않는다.
   */
  function reflectCommitBusy() {
    const retry = document.getElementById("failure-retry");
    if (!retry) {
      return;
    }
    retry.disabled = commitBusy;
    retry.setAttribute("aria-busy", commitBusy ? "true" : "false");
    const icon = retry.querySelector(".codicon");
    icon?.classList.toggle("codicon-debug-rerun", !commitBusy);
    icon?.classList.toggle("codicon-loading", commitBusy);
    icon?.classList.toggle("codicon-modifier-spin", commitBusy);
  }

  new MutationObserver(scheduleRender).observe(rootEl, {
    childList: true,
    subtree: false,
  });
  window.addEventListener("message", (event) => {
    if (event.data?.type === "render") {
      latestCommit = event.data.payload?.commit || null;
      scheduleRender();
    } else if (event.data?.type === "commitOperation") {
      commitBusy = !!event.data.active;
      reflectCommitBusy();
    } else if (event.data?.type === "commitHookOperation") {
      const active = !!event.data.active;
      if (event.data.action === "refresh") {
        refreshing = active;
      } else if (event.data.action === "create") {
        creating = active;
      } else if (event.data.action === "toggle") {
        pendingHookName = active ? event.data.hookName || "" : "";
      }
      scheduleRender();
    }
  });
  scheduleRender();
})();
