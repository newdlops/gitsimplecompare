// Changes 웹뷰의 커밋 메시지 입력을 여러 줄 작성에 맞게 보강한다.
// - 기존 렌더러를 크게 키우지 않고 textarea 동작과 안내 문구만 후처리한다.
(function () {
  "use strict";

  const rootEl = document.getElementById("root");
  const T = Object.assign(
    {
      commitMultilinePlaceholder:
        "Subject, blank line, optional body. Ctrl+Enter to commit.",
    },
    window.__gscI18n || {}
  );

  if (!rootEl) {
    return;
  }

  /** 렌더된 커밋 textarea 를 여러 줄 입력용 속성으로 맞춘다. */
  function enhanceCommitMessageInput() {
    const textarea = document.getElementById("commit-msg");
    if (!textarea || textarea.dataset.multilineEnhanced === "true") {
      return;
    }
    textarea.dataset.multilineEnhanced = "true";
    textarea.rows = Math.max(Number(textarea.rows) || 0, 3);
    textarea.placeholder = T.commitMultilinePlaceholder;
    textarea.title = T.commitMultilinePlaceholder;
    textarea.setAttribute("aria-label", T.commitMultilinePlaceholder);
    textarea.addEventListener("input", () => resizeCommitMessageInput(textarea));
    window.requestAnimationFrame(() => resizeCommitMessageInput(textarea));
  }

  /** textarea 높이를 내용에 맞춰 늘리되 사이드바를 과도하게 밀지 않도록 제한한다. */
  function resizeCommitMessageInput(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 260) + "px";
  }

  /** 렌더 교체 이후에도 커밋 입력 후처리를 다시 적용한다. */
  function scheduleEnhance() {
    window.requestAnimationFrame(enhanceCommitMessageInput);
  }

  new MutationObserver(scheduleEnhance).observe(rootEl, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("message", scheduleEnhance);
  scheduleEnhance();
})();
