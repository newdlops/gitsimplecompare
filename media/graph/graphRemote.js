// 그래프 툴바의 원격 브랜치 버튼 상태를 관리한다.
// - 확장 host 의 실제 동작은 openRemoteBranch 메시지 하나로 통합하고, 여기서는 표시만 바꾼다.
(function () {
  "use strict";

  /**
   * 현재 브랜치 상태에 맞춰 원격 브랜치 버튼을 열기/설정 액션으로 갱신한다.
   * @param button 툴바의 원격 브랜치 버튼
   * @param branches 확장에서 받은 LocalBranchStatus 배열
   */
  function updateButton(button, branches) {
    if (!button) {
      return;
    }
    const current = (branches || []).find((branch) => branch.current);
    const icon = button.querySelector(".codicon");
    const upstream = current && !current.gone ? current.upstream : "";
    const enabled = Boolean(current);
    const title = titleFor(current, upstream);
    button.hidden = false;
    button.disabled = !enabled;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.tooltip = title;
    button.dataset.mode = upstream ? "open" : "configure";
    if (icon) {
      icon.classList.toggle("codicon-link-external", Boolean(upstream));
      icon.classList.toggle("codicon-repo-push", !upstream);
    }
  }

  /**
   * 버튼 hover/접근성 라벨에 사용할 문구를 만든다.
   * @param current 현재 로컬 브랜치 상태
   * @param upstream 정상 upstream short name
   */
  function titleFor(current, upstream) {
    if (!current) {
      return "No current local branch";
    }
    if (upstream) {
      return `Open remote branch ${upstream}`;
    }
    if (current.upstream && current.gone) {
      return `Set remote branch for ${current.name}; current upstream is gone`;
    }
    return `Set remote branch for ${current.name}`;
  }

  /**
   * 버튼 클릭 시 확장 host 로 원격 브랜치 열기/설정 요청을 보낸다.
   * @param button 툴바 버튼
   * @param postMessage vscode.postMessage 호환 함수
   */
  function bind(button, postMessage) {
    if (!button) {
      return;
    }
    button.addEventListener("click", () => postMessage({ type: "openRemoteBranch" }));
  }

  window.GscGraphRemote = { updateButton, bind };
})();
