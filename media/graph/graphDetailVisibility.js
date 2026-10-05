// 상세 drawer 표시 상태를 조회 소비자 수명과 연결한다. 화면/툴팁의 기존 표현은 그대로 사용한다.
(function () {
  "use strict";
  /**
   * drawer 닫기는 host 조회를 취소하고 다시 열기는 현재 선택만 재개한다.
   * @param visible 표시 여부, host 버튼·라벨·선택·메시지 경계, notify 사용자 표시 전환인지 여부
   */
  function setVisible(visible, host, notify = true) {
    const previous = document.body.classList.contains("detail-open");
    document.body.classList.toggle("detail-open", visible);
    document.body.classList.toggle("detail-collapsed", !visible);
    const button = host.button;
    if (button) {
      button.title = visible ? `Hide ${host.label}` : `Show ${host.label}`;
      button.dataset.tooltip = button.title;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-expanded", visible ? "true" : "false");
      const icon = button.querySelector(".codicon");
      icon?.classList.toggle("codicon-layout-sidebar-right", visible);
      icon?.classList.toggle("codicon-layout-sidebar-right-off", !visible);
    }
    if (previous === visible) return;
    if (!visible) host.post({ type: "cancelGraphDetail" });
    if (notify) {
      window.dispatchEvent(new CustomEvent("gsc-detail-visibility", { detail: { visible } }));
      if (visible && host.label === "commit details" && host.hash) host.post({ type: "selectCommit", hash: host.hash });
    }
  }
  window.GscGraphDetailVisibility = { setVisible };
})();
