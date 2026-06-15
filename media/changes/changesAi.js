// Changes 웹뷰의 AI 커밋 메시지 버튼 보강 스크립트.
// - 기존 changes.js 렌더러를 크게 키우지 않기 위해 렌더 후 DOM 에 버튼을 삽입한다.
(function () {
  "use strict";

  const vscode = window.__gscVscode;
  const rootEl = document.getElementById("root");
  const T = Object.assign(
    {
      generateCommitMessage: "Generate AI Commit Message",
      generateCommitMessageShort: "AI",
      aiCommitRequiresStaged: "Stage changes before generating an AI commit message.",
      configureAiCli: "Configure AI CLI",
    },
    window.__gscI18n || {}
  );
  let latestPayload = null;

  if (!vscode || !rootEl) {
    return;
  }

  /** HTML 속성에 들어갈 텍스트를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 현재 렌더된 커밋 바에 AI 버튼이 없으면 삽입한다. */
  function injectCommitAiButton() {
    const bar = rootEl.querySelector(".commit-bar");
    if (!bar) {
      return;
    }
    injectGenerateButton(bar);
    injectSettingsButton(bar);
    updateGenerateButtonState();
  }

  /** AI 커밋 메시지 생성 버튼을 삽입한다. */
  function injectGenerateButton(bar) {
    if (document.getElementById("commit-ai-btn")) {
      return;
    }
    const label = T.generateCommitMessage;
    const shortLabel = T.generateCommitMessageShort || "AI";
    const button = document.createElement("button");
    button.id = "commit-ai-btn";
    button.className = "commit-ai-btn";
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip", label);
    button.innerHTML =
      '<span class="codicon codicon-sparkle" aria-hidden="true"></span>' +
      '<span class="commit-ai-label">' +
      esc(shortLabel) +
      "</span>";
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }
      vscode.postMessage({ type: "generateCommitMessage" });
    });
    bar.insertBefore(button, bar.firstChild);
    updateGenerateButtonState();
  }

  /** AI CLI 설정 버튼을 삽입한다. */
  function injectSettingsButton(bar) {
    if (document.getElementById("commit-ai-settings-btn")) {
      return;
    }
    const label = T.configureAiCli;
    const button = document.createElement("button");
    button.id = "commit-ai-settings-btn";
    button.className = "commit-ai-settings-btn";
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip", label);
    button.innerHTML =
      '<span class="codicon codicon-settings-gear" aria-hidden="true"></span>';
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "configureAiCli" });
    });
    const generate = document.getElementById("commit-ai-btn");
    bar.insertBefore(button, generate ? generate.nextSibling : bar.firstChild);
  }

  /** 렌더 교체와 초기 로드 모두에서 버튼 삽입을 시도한다. */
  function scheduleInject() {
    window.requestAnimationFrame(injectCommitAiButton);
  }

  /** render payload 의 staged 상태에 따라 AI 생성 버튼을 켜고 끈다. */
  function updateGenerateButtonState() {
    const button = document.getElementById("commit-ai-btn");
    if (!button) {
      return;
    }
    const enabled = !!latestPayload?.commit?.hasStagedChanges;
    const label = enabled ? T.generateCommitMessage : T.aiCommitRequiresStaged;
    button.disabled = !enabled;
    button.classList.toggle("disabled", !enabled);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip", label);
  }

  new MutationObserver(scheduleInject).observe(rootEl, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("message", (event) => {
    if (event.data?.type === "render") {
      latestPayload = event.data.payload || null;
      updateGenerateButtonState();
    }
    scheduleInject();
  });
  scheduleInject();
})();
