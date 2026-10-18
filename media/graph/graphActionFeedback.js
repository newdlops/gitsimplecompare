// 확장 응답을 기다리지 않고 기존 버튼에 진행 상태를 표시하고 중복 클릭을 막는다.
(function () {
  "use strict";
  const active = new Map();
  const actionButtons = { refresh: "refresh-graph", fetch: "fetch-graph", fetchTags: "fetch-tags-graph",
    pull: "pull-graph", push: "push-graph", forcePush: "force-push-graph" };

  /**
   * 기존 아이콘·disabled 상태를 한 번 저장하고 같은 버튼 인스턴스에만 복원한다.
   * @param id 실제 버튼 DOM id @param busy 진행 중 여부. 확장 측 true 응답은 기존 상태를 덮지 않는다.
   */
  function setBusy(id, busy) {
    const button = document.getElementById(id), icon = button?.querySelector(".codicon");
    const record = active.get(id);
    if (!busy) {
      active.delete(id);
      if (!record) return;
      record.icon.className = record.iconClass;
      record.button.classList.remove("is-busy");
      record.button.removeAttribute("aria-busy");
      record.button.disabled = record.disabled;
      return;
    }
    if (!button || !icon) return;
    if (record?.button !== button) active.set(id, { button, icon, iconClass: icon.className, disabled: button.disabled });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : " codicon-modifier-spin";
    icon.className = "codicon codicon-loading" + motion;
    button.classList.add("is-busy");
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  }

  /**
   * 로컬 진행 표시 후 메시지 하나를 전송하고 이미 진행 중이거나 비활성인 버튼의 재실행을 막는다.
   * @param vscode VS Code 웹뷰 API @param message 기존 action 메시지 @returns 실제 전송했으면 true
   */
  function post(vscode, message) {
    const id = typeof message.busyId === "string" ? message.busyId : actionButtons[message.type];
    const button = id && document.getElementById(id);
    if (id && (active.has(id) || button?.disabled)) return false;
    if (id) setBusy(id, true);
    try { vscode.postMessage(message); }
    catch (error) { if (id) setBusy(id, false); throw error; }
    return true;
  }
  window.GscGraphActionFeedback = { setBusy, post };
})();
