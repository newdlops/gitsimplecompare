// Review Center의 Files 탭 표시와 파일 행 상호작용을 담당한다.
// - 상태와 VS Code API는 상위 renderer가 소유하고, 이 모듈은 전달받은 callback만 사용한다.
(function () {
  "use strict";

  /**
   * Files 탭의 표현과 controller를 만든다.
   * @param {object} dependencies 상위 renderer가 소유한 상태, DOM 도우미, composer 및 callback 묶음
   * @returns {{renderFiles: function(Element): void}} Files 탭을 panel에 추가하는 API
   */
  window.__gscReviewCenterFiles = function createReviewCenterFiles(dependencies) {
    const { T, state, el, button, template, formatNumber, section, render, postMessage, fileComment, lineComment, renderPageControl } = dependencies;

    /**
     * Preview와 같은 단일 파일 작업면에 파일 목록, 상태, composer, 다음 페이지 제어를 렌더링한다.
     * @param {Element} content 현재 Files tabpanel의 콘텐츠 컨테이너
     * @returns {void} DOM을 전달받은 컨테이너에 추가한다.
     */
    function renderFiles(content) {
      const files = section(template(T.filesTitle, formatNumber(state.snapshot.files.length)));
      files.classList.add("review-center__files-workspace");
      if (state.reviewWritesEnabled) {
        const addLine = button("gsc-button gsc-button--ghost review-center__line-comment-action", T.addLineComment, T.addLineComment, () => lineComment.open());
        addLine.disabled = !state.snapshot.files.length || state.lineComment.pending;
        files.querySelector(".review-center__section-header")?.append(addLine);
      }
      const list = el("div", "review-center__files");
      if (!state.snapshot.files.length) list.append(el("div", "review-center__empty", T.noFiles));
      state.snapshot.files.forEach((file) => list.append(renderFile(file)));
      files.append(list);
      if (state.draft.reconcile?.kind === "headChanged") files.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.draftHeadChanged));
      if (state.draft.reconcile?.kind === "conflict") files.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", T.draftConflict));
      if (state.reviewWritesEnabled) files.append(fileComment.renderComposer(), lineComment.renderComposer());
      if (state.filesViewedError) files.append(el("div", "gsc-banner gsc-banner--warning review-center__notice", state.filesViewedError));
      files.append(renderPageControl("files"));
      content.classList.add("review-center__content--single", "review-center__content--files");
      content.append(files);
    }

    /**
     * 파일의 경로, diff 통계, Viewed와 댓글 action을 Preview의 compact header 행으로 만든다.
     * @param {object} file Review Center snapshot 안의 변경 파일
     * @returns {HTMLElement} keyboard로 열 수 있는 파일 목록 행
     */
    function renderFile(file) {
      const item = el("div", "review-center__file");
      const open = button("review-center__file-open", template(T.openFileDiff, file.path), "", () => openNativeFile(file.path));
      if (state.activeFilePath === file.path) {
        item.classList.add("review-center__file--active");
        open.setAttribute("aria-current", "true");
      }
      if (state.snapshot.canOpenNativeDiff === false) {
        open.disabled = true;
        open.title = T.nativeDiffUnavailable;
        open.dataset.tooltip = T.nativeDiffUnavailable;
        open.setAttribute("aria-label", T.nativeDiffUnavailable);
      }
      const info = el("div", "review-center__file-detail");
      info.append(el("div", "review-center__file-path gsc-code", file.path));
      if (file.oldPath) info.append(el("div", "review-center__file-meta", template(T.renamedFrom, file.oldPath)));
      const stats = el("span", "review-center__file-stats");
      stats.append(el("span", "gsc-status-pill", file.status), el("span", "review-center__added", `+${formatNumber(file.additions)}`), el("span", "review-center__deleted", `−${formatNumber(file.deletions)}`));
      open.append(info, stats);
      if (state.reviewWritesEnabled) {
        const controls = el("div", "review-center__file-controls");
        const pending = Boolean(state.viewedPending[file.path]);
        const viewedAction = button("gsc-button gsc-button--ghost review-center__viewed", template(file.isViewed ? T.markUnviewed : T.markViewed, file.path), file.isViewed ? T.viewed : T.unviewed, () => toggleViewed(file));
        viewedAction.disabled = pending;
        viewedAction.setAttribute("aria-busy", String(pending));
        viewedAction.setAttribute("aria-pressed", String(file.isViewed));
        const comment = button("gsc-button gsc-button--ghost review-center__file-comment-action", template(T.addFileComment, file.path), T.addFileComment, () => fileComment.open(file.path));
        comment.disabled = state.fileComment.pending;
        controls.append(viewedAction, comment);
        item.append(open, controls);
      } else item.append(open);
      return item;
    }

    /**
     * Viewed 상태를 즉시 화면에 반영한 뒤 상위 renderer의 기존 메시지 경로로 mutation을 전달한다.
     * @param {object} file 사용자가 토글한 파일 snapshot 항목
     * @returns {void} pending 상태를 렌더링하고 기존 payload를 전송한다.
     */
    function toggleViewed(file) {
      if (state.viewedPending[file.path]) return;
      state.snapshot.files = state.snapshot.files.map((item) => item.path === file.path ? { ...item, isViewed: !file.isViewed } : item);
      state.viewedPending[file.path] = true;
      state.filesViewedError = "";
      render();
      postMessage({ type: "toggleViewed", path: file.path, viewed: !file.isViewed });
    }

    /**
     * 선택 파일을 workspace 상태에 남기고 상위 renderer의 기존 native diff 의도를 전송한다.
     * @param {string} path 열려는 repository 상대 경로
     * @returns {void} native diff를 사용할 수 없으면 아무 action도 수행하지 않는다.
     */
    function openNativeFile(path) {
      if (!path || state.snapshot?.canOpenNativeDiff === false) return;
      state.activeFilePath = path;
      render();
      postMessage({ type: "openFile", path });
    }

    return { renderFiles };
  };
}());
