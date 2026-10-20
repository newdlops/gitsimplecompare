// 페이지/작업트리/브랜치 상세의 독립적인 준비 상태를 기존 footer 한 곳에 표시한다.
(function () {
  "use strict";

  /**
   * 검증된 이력 개수와 아직 준비 중인 상세를 표시한다. 상세 대기를 추가 페이지 조회로 오인하지 않게 한다.
   * @param status footer 요소 @param state 확장의 로딩 상태 @param rows 실제 표시 행 @param health 오류 안내
   */
  function update(status, state, rows, health) {
    const loaded = state.loadedCount || rows.length;
    const details = state.branchDetails, workingTree = state.workingTree;
    if (health?.level === "error") status.textContent = health.title || "Git graph unavailable";
    else if (state.loading && !details) status.textContent = state.loadDirection === "newer"
      ? `Loading newer commits before ${loaded} loaded` : `Loading older commits after ${loaded} loaded`;
    else status.textContent = state.hasMore || state.hasMoreBefore || details
      ? `${loaded} commits loaded` : `${loaded} commits, complete`;
    for (const pending of [details, workingTree]) if (pending?.message) status.textContent += ` · ${pending.message}`;
    status.title = [details?.detail, workingTree?.detail].filter(Boolean).join("\n") || status.textContent;
    status.classList.toggle("loading", Boolean(state.loading || details?.loading || workingTree?.loading) && health?.level !== "error");
  }

  window.GscGraphLoadStatus = { update };
})();
