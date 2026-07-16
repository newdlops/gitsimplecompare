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

  /**
   * 커밋 dropdown action ID를 host commit command가 받는 제한된 operation 값으로 변환한다.
   * @param {string} id 메뉴 provider가 주입한 action ID
   * @returns {string|undefined} 허용된 commit operation 또는 일반 SCM action이면 undefined
   */
  window.__gscCommitOperationForMenuId = function (id) {
    switch (id) {
      case "commit": return "commit";
      case "commitStaged": return "staged";
      case "commitAll": return "all";
      case "commitAmend": return "amend";
      case "commitStagedAmend": return "amendStaged";
      case "commitAllAmend": return "amendAll";
      default: return undefined;
    }
  };

  if (!rootEl) {
    return;
  }

  /**
   * 렌더된 커밋 textarea를 여러 줄 입력용 속성으로 맞추고 중복 listener를 막는다.
   * @returns {void} 아직 입력 요소가 없으면 다음 render까지 기다린다.
   */
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

  /**
   * textarea 높이를 내용에 맞춰 늘리되 사이드바를 과도하게 밀지 않도록 제한한다.
   * @param {HTMLTextAreaElement} textarea 높이를 다시 계산할 commit 입력 요소
   * @returns {void} 요소의 inline height만 갱신한다.
   */
  function resizeCommitMessageInput(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 260) + "px";
  }

  /**
   * 렌더 교체 이후에도 커밋 입력 후처리를 animation frame에 다시 적용한다.
   * @returns {void} DOM 갱신과 같은 frame의 layout thrashing을 피하도록 예약한다.
   */
  function scheduleEnhance() {
    window.requestAnimationFrame(enhanceCommitMessageInput);
  }

  /**
   * 변경 웹뷰를 구성하는 모든 일반 script가 실행된 직후 host에 최초 상태를 요청한다.
   * - 이 파일 뒤의 AI/Hook script도 설치되어야 하므로 파싱 완료 신호인 DOMContentLoaded까지 기다린다.
   * - 캐시 등으로 DOM 파싱이 이미 끝난 뒤 실행된 경우에는 현재 script 실행을 마친 다음 microtask에서 알린다.
   * @returns {void} host에 ready 메시지를 한 번 전송한다.
   */
  function announceReady() {
    window.__gscVscode?.postMessage({ type: "ready" });
  }

  new MutationObserver(scheduleEnhance).observe(rootEl, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("message", scheduleEnhance);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  } else {
    queueMicrotask(announceReady);
  }
  scheduleEnhance();
})();
