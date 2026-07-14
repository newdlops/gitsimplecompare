// Changes 커밋 박스의 AI 플랜 모드와 요청별 추가 프롬프트를 관리한다.
// - 실제 계획 생성/커밋은 extension host 에 맡기고, 이 모듈은 모드 상태와 DOM 보강만 담당한다.
(function () {
  "use strict";

  const vscode = window.__gscVscode;
  const rootEl = document.getElementById("root");
  const T = Object.assign(
    {
      aiCommitPlanMode: "AI Plan",
      commit: "Commit",
      enableAiCommitPlanMode: "Enable AI commit plan mode",
      disableAiCommitPlanMode: "Disable AI commit plan mode",
      aiCommitPlanPrompt: "Additional AI plan instructions (optional)",
      aiCommitPlanPromptPlaceholder:
        "For example: keep tests with implementation; separate docs.",
      aiCommitPlanIntentPlaceholder:
        "Overall change intent (optional). Ctrl+Enter to plan commits.",
      commitMultilinePlaceholder:
        "Subject, blank line, optional body. Ctrl+Enter to commit.",
      createAiCommitPlan: "Create AI Commit Plan",
      aiCommitPlanAmendUnsupported:
        "AI plan mode is not available for amend commits.",
    },
    window.__gscI18n || {}
  );

  let enabled = false;
  let extraPrompt = "";
  let injectionScheduled = false;

  if (!vscode || !rootEl) {
    return;
  }

  /** 커밋 바와 입력창이 다시 그려졌을 때 플랜 컨트롤을 재삽입하고 현재 상태를 반영한다. */
  function injectPlanControls() {
    const box = rootEl.querySelector(".commit-box");
    const bar = box?.querySelector(".commit-bar");
    if (!box || !bar) {
      return;
    }
    injectModeButton(bar);
    syncPromptField(box, bar);
    reflectMode(box, bar);
  }

  /** AI 플랜 모드를 켜고 끄는 버튼을 커밋 액션들 사이에 추가한다. */
  function injectModeButton(bar) {
    if (document.getElementById("commit-ai-plan-mode-btn")) {
      return;
    }
    const button = document.createElement("button");
    button.id = "commit-ai-plan-mode-btn";
    button.className = "commit-ai-plan-mode-btn";
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.innerHTML =
      '<span class="codicon codicon-sparkle" aria-hidden="true"></span>' +
      '<span class="commit-ai-plan-label"></span>';
    button.addEventListener("click", () => {
      enabled = !enabled;
      injectPlanControls();
      if (enabled) {
        document.getElementById("commit-ai-plan-prompt")?.focus();
      }
    });
    const commitButton = document.getElementById("commit-btn");
    bar.insertBefore(button, commitButton || null);
  }

  /** 모드가 켜진 동안에만 요청별 추가 프롬프트 textarea를 커밋 입력창 아래에 둔다. */
  function syncPromptField(box, bar) {
    let wrapper = document.getElementById("commit-ai-plan-prompt-wrap");
    if (!enabled) {
      wrapper?.remove();
      return;
    }
    if (wrapper) {
      return;
    }
    wrapper = document.createElement("label");
    wrapper.id = "commit-ai-plan-prompt-wrap";
    wrapper.className = "commit-ai-plan-prompt-wrap";
    wrapper.innerHTML =
      '<span class="commit-ai-plan-prompt-label"></span>' +
      '<textarea id="commit-ai-plan-prompt" class="commit-ai-plan-prompt" rows="2"></textarea>';
    const label = wrapper.querySelector(".commit-ai-plan-prompt-label");
    const input = wrapper.querySelector("#commit-ai-plan-prompt");
    label.textContent = T.aiCommitPlanPrompt;
    input.value = extraPrompt;
    input.maxLength = 12000;
    input.placeholder = T.aiCommitPlanPromptPlaceholder;
    input.title = T.aiCommitPlanPrompt;
    input.setAttribute("aria-label", T.aiCommitPlanPrompt);
    input.addEventListener("input", () => {
      extraPrompt = input.value;
      resizePrompt(input);
    });
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        document.getElementById("commit-btn")?.click();
      }
    });
    box.insertBefore(wrapper, bar);
    resizePrompt(input);
  }

  /** 플랜 모드 여부를 버튼, 커밋 버튼, 기존 메시지 입력창의 접근성 문구에 동기화한다. */
  function reflectMode(box, bar) {
    const modeButton = document.getElementById("commit-ai-plan-mode-btn");
    const commitButton = document.getElementById("commit-btn");
    const commitLabel = commitButton?.querySelector(".commit-label");
    const commitIcon = commitButton?.querySelector(".codicon");
    const intent = document.getElementById("commit-msg");
    const modeTooltip = enabled
      ? T.disableAiCommitPlanMode
      : T.enableAiCommitPlanMode;
    if (modeButton) {
      modeButton.classList.toggle("active", enabled);
      modeButton.setAttribute("aria-pressed", enabled ? "true" : "false");
      modeButton.title = modeTooltip;
      modeButton.setAttribute("aria-label", modeTooltip);
      modeButton.setAttribute("data-tooltip", modeTooltip);
      const modeLabel = modeButton.querySelector(".commit-ai-plan-label");
      if (modeLabel && modeLabel.textContent !== T.aiCommitPlanMode) {
        modeLabel.textContent = T.aiCommitPlanMode;
      }
    }
    box.classList.toggle("ai-plan-mode", enabled);
    bar.classList.toggle("ai-plan-mode", enabled);
    if (commitButton) {
      const label = enabled ? T.createAiCommitPlan : T.commit;
      commitButton.title = label;
      commitButton.setAttribute("aria-label", label);
      commitButton.setAttribute("data-tooltip", label);
      if (commitLabel && commitLabel.textContent !== label) {
        commitLabel.textContent = label;
      }
      commitIcon?.classList.toggle("codicon-checklist", enabled);
      commitIcon?.classList.toggle("codicon-check", !enabled);
    }
    if (intent) {
      const label = enabled
        ? T.aiCommitPlanIntentPlaceholder
        : T.commitMultilinePlaceholder;
      intent.placeholder = label;
      intent.title = label;
      intent.setAttribute("aria-label", label);
    }
  }

  /** 추가 프롬프트 입력창을 내용에 맞춰 늘리되 사이드바를 과도하게 차지하지 않게 제한한다. */
  function resizePrompt(input) {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  /** 연속 DOM 변경 알림을 한 프레임의 컨트롤 동기화로 합쳐 observer 재진입을 막는다. */
  function scheduleInjection() {
    if (injectionScheduled) {
      return;
    }
    injectionScheduled = true;
    window.requestAnimationFrame(() => {
      injectionScheduled = false;
      injectPlanControls();
    });
  }

  /**
   * 기존 커밋 실행 직전에 호출되는 공개 hook이다.
   * 플랜 모드면 일반 커밋을 가로채 컨텍스트/프롬프트와 함께 플랜 명령을 요청한다.
   */
  window.__gscTryAiCommitPlan = function (request) {
    if (!enabled) {
      return false;
    }
    if (String(request?.op || "").startsWith("amend")) {
      vscode.postMessage({ type: "aiCommitPlanAmendUnsupported" });
      return true;
    }
    vscode.postMessage({
      type: "openAiCommitPlan",
      op: request?.op || "commit",
      message: request?.message || "",
      prompt: extraPrompt,
      autoGenerate: true,
    });
    return true;
  };

  new MutationObserver(scheduleInjection)
    .observe(rootEl, { childList: true, subtree: true });
  window.addEventListener("message", (event) => {
    if (event.data?.type === "render") {
      scheduleInjection();
    }
  });
  scheduleInjection();
})();
