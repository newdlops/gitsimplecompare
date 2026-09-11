// 실패한 커밋의 로그 표시와 복사 피드백. VS Code API는 메인 클라이언트에서 한 번만 획득한다.
(function () {
  "use strict";
  const T = Object.assign({
    commitLog: "Commit log", showCommitLog: "Show log", hideCommitLog: "Hide log",
    copyCommitLog: "Copy log", copyingCommitLog: "Copying…",
    noCommitLog: "No log output was captured for this failure.",
    commitLogTruncated: "Log preview shortened. Copy log includes the full output.",
  }, window.__gscCommitPlanI18n || {});
  let postMessage;
  let current;

  /** 메인 클라이언트가 가진 postMessage만 연결해 VS Code API 중복 획득을 막는다. */
  function connect(send) { postMessage = send; }

  /** 다음 실패·실행·계획에 이전 복사 완료 응답이 섞이지 않도록 현재 DOM 연결을 해제한다. */
  function clear() { current = undefined; }

  /** 버튼의 표시 문구·즉시 tooltip·접근성 이름을 같은 지역화 문자열로 설정한다. */
  function labelButton(button, label) {
    button.textContent = label;
    button.title = label;
    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
  }

  /**
   * 실패 패널에 로그 접기/펼치기, 전체 복사, 스크롤 가능한 미리보기를 붙인다.
   * @param {HTMLElement} container 해당 커밋 번호를 제목에 표시하는 실패 패널
   * @param {object|undefined} value host가 만든 실패 ID와 크기 제한 미리보기
   */
  function render(container, value) {
    clear();
    if (!container) return;
    const log = value && typeof value === "object" ? value : {};
    const output = typeof log.text === "string" ? log.text : "";
    const root = document.createElement("div");
    root.className = "execution-log";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", T.commitLog);
    const header = document.createElement("div");
    header.className = "execution-log-header";
    const heading = document.createElement("h4");
    heading.textContent = T.commitLog;
    const actions = document.createElement("div");
    actions.className = "execution-log-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary";
    labelButton(toggle, T.hideCommitLog);
    toggle.disabled = !output;
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", "commit-failure-log-text");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    labelButton(copy, T.copyCommitLog);
    copy.disabled = log.canCopy !== true || typeof log.id !== "string";
    if (copy.disabled) { copy.title = T.noCommitLog; copy.dataset.tooltip = T.noCommitLog; }
    const preview = document.createElement("pre");
    preview.id = "commit-failure-log-text";
    preview.tabIndex = 0;
    preview.setAttribute("role", "region");
    preview.setAttribute("aria-label", T.commitLog);
    preview.textContent = output || T.noCommitLog;
    const note = document.createElement("p");
    note.className = "execution-log-note";
    note.textContent = T.commitLogTruncated;
    note.hidden = log.truncated !== true;
    const status = document.createElement("p");
    status.className = "execution-log-copy-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const state = { id: log.id, copy, status, pending: false };
    current = state;
    toggle.addEventListener("click", function toggleLog() {
      preview.hidden = !preview.hidden;
      toggle.setAttribute("aria-expanded", String(!preview.hidden));
      labelButton(toggle, preview.hidden ? T.showCommitLog : T.hideCommitLog);
    });
    copy.addEventListener("click", function copyLog() {
      if (state !== current || copy.disabled || state.pending || !postMessage) return;
      state.pending = true;
      copy.disabled = true;
      copy.setAttribute("aria-busy", "true");
      labelButton(copy, T.copyingCommitLog);
      status.textContent = "";
      postMessage({ type: "copyFailureLog", failureId: state.id });
    });
    actions.append(toggle, copy);
    header.append(heading, actions);
    root.append(header, preview, note, status);
    container.append(root);
  }

  /** 현재 실패의 복사 요청에 대한 host 응답만 반영하고 실패 시에도 로그와 재시도를 보존한다. */
  function receive(event) {
    const message = event.data;
    if (!current || !current.pending || message?.type !== "failureLogCopied" || message.failureId !== current.id) return;
    current.pending = false;
    current.copy.disabled = false;
    current.copy.removeAttribute("aria-busy");
    labelButton(current.copy, T.copyCommitLog);
    current.status.textContent = typeof message.message === "string" ? message.message : "";
    current.status.dataset.kind = message.success === true ? "success" : "error";
  }

  window.__gscCommitPlanFailureLog = { connect, render, clear };
  window.addEventListener("message", receive);
})();
