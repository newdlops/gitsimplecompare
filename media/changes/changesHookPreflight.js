// 펼친 commit hook 관리 패널에 staged hook 사전 실행 버튼을 독립적으로 주입한다.
// - 기존 hook 관리 렌더러는 파일 상태 UI에 집중하고, 이 모듈은 실행 busy/tooltip만 담당한다.
(function () {
  "use strict";

  const vscode = window.__gscVscode;
  const rootEl = document.getElementById("root");
  const T = Object.assign(
    {
      runStagedCommitHooks: "Run commit hooks for staged changes",
      stageBeforeCommitHooks:
        "Stage changes before running commit hooks",
      runningStagedCommitHooks:
        "Running commit hooks for staged changes...",
    },
    window.__gscI18n || {}
  );
  let latestCommit = null;
  let running = false;
  let scheduled = false;

  if (!vscode || !rootEl) {
    return;
  }

  /**
   * hook manager toolbar가 현재 DOM에 있으면 사전 실행 버튼을 만들고 최신 staged/busy 상태를 반영한다.
   * @returns 펼치지 않은 panel에서는 아무 DOM도 만들지 않는다.
   */
  function injectPreflightButton() {
    const actions = rootEl.querySelector(".hook-manager-actions");
    if (!actions) {
      return;
    }
    let button = document.getElementById("hook-preflight");
    if (!button) {
      button = document.createElement("button");
      button.id = "hook-preflight";
      button.className = "hook-icon-button";
      button.type = "button";
      button.addEventListener("click", requestPreflight);
      actions.insertBefore(button, actions.firstChild);
    }
    reflectPreflightButton(button);
  }

  /**
   * staged 존재 여부와 실행 상태를 아이콘, disabled, tooltip, 접근성 속성에 동기화한다.
   * @param {HTMLButtonElement} button hook manager에 삽입된 사전 실행 버튼
   * @returns DOM 속성과 아이콘만 갱신한다.
   */
  function reflectPreflightButton(button) {
    const hasStaged = !!latestCommit?.hasStagedChanges;
    const label = running
      ? T.runningStagedCommitHooks
      : hasStaged
        ? T.runStagedCommitHooks
        : T.stageBeforeCommitHooks;
    button.disabled = running || !hasStaged;
    button.title = label;
    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-busy", running ? "true" : "false");
    button.innerHTML =
      `<span class="codicon ${
        running
          ? "codicon-loading codicon-modifier-spin"
          : "codicon-run-all"
      }" aria-hidden="true"></span>`;
  }

  /**
   * 현재 textarea 메시지와 함께 host 사전 실행 명령을 요청하고 응답 전에 중복 클릭을 막는다.
   * @returns staged 변경이 없거나 이미 실행 중이면 메시지를 보내지 않는다.
   */
  function requestPreflight() {
    if (running || !latestCommit?.hasStagedChanges) {
      return;
    }
    running = true;
    scheduleInjection();
    const textarea = document.getElementById("commit-msg");
    vscode.postMessage({
      type: "runCommitHookPreflight",
      message: textarea ? textarea.value : "",
    });
  }

  /**
   * 연속 render/observer 알림을 다음 animation frame의 한 번의 버튼 동기화로 합친다.
   * @returns 예약 상태만 바꾸며 실제 DOM 작업은 callback에서 수행한다.
   */
  function scheduleInjection() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      injectPreflightButton();
    });
  }

  /**
   * 전체/부분 payload에서 commit 상태를 합치고 host operation 메시지로 busy 상태를 확정한다.
   * @param {MessageEvent} event extension host가 보낸 webview 메시지
   * @returns 지원하지 않는 메시지는 상태를 바꾸지 않는다.
   */
  function handleHostMessage(event) {
    if (event.data?.type === "render") {
      latestCommit = event.data.payload?.commit || null;
    } else if (event.data?.type === "workingRender") {
      latestCommit = Object.assign(
        {},
        latestCommit || {},
        event.data.payload?.commit || {}
      );
    } else if (
      event.data?.type === "commitHookOperation" &&
      event.data.action === "preflight"
    ) {
      running = !!event.data.active;
    }
    scheduleInjection();
  }

  new MutationObserver(scheduleInjection).observe(rootEl, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("message", handleHostMessage);
  scheduleInjection();
})();
