// Changes 웹뷰의 작업트리 stage/unstage 진행 상태 표시 모듈.
// - git 작업은 extension host 가 수행하고, 이 파일은 사용자가 누른 대상 행/그룹을 즉시 busy 로 표시한다.
(function () {
  "use strict";

  const T = Object.assign(
    {
      stagingChanges: "Staging changes...",
      unstagingChanges: "Unstaging changes...",
      updatingGitIndex: "Updating git index...",
      refreshingChanges: "Refreshing changes...",
      selectedFiles: "{0} file(s)",
      allChanges: "all changes",
    },
    window.__gscI18n || {}
  );
  let operation = null;
  let lastOperation = null;
  let visible = false;
  let showTimer = 0;
  let hideTimer = 0;
  let shownAt = 0;
  const SHOW_DELAY_MS = 180;
  const MIN_VISIBLE_MS = 650;

  /** stage/unstage 작업을 로컬에서 즉시 시작 표시한다. */
  function begin(action, paths) {
    if (!isWorkingAction(action)) {
      return false;
    }
    operation = {
      action,
      paths: normalizePaths(paths),
      phase: "git",
    };
    lastOperation = operation;
    scheduleApply();
    return true;
  }

  /** extension host 에서 보낸 실제 작업 상태로 busy 표시를 맞춘다. */
  function setOperation(active, action, paths, phase) {
    if (active && isWorkingAction(action)) {
      operation = {
        action,
        paths: normalizePaths(paths),
        phase: phase === "refresh" ? "refresh" : "git",
      };
      lastOperation = operation;
      cancelHide();
    } else {
      operation = null;
    }
    scheduleApply();
  }

  /** 현재 DOM 에 진행 상태 클래스를 다시 적용한다. */
  function apply() {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    clearBusyElements(root);
    renderStatus(root);
    root.classList.toggle("working-op-active", visible && !!operation);
    if (!visible || !operation) {
      return;
    }

    const targetGroup = groupForAction(operation.action);
    const title = titleForAction(operation.action);
    root.querySelectorAll(`.group[data-gkey="${targetGroup}"]`).forEach((group) => {
      if (!operation.paths.length) {
        markBusy(group, title);
        group.querySelectorAll(".wt-files .row").forEach((row) => markBusy(row, title));
        return;
      }
      let hasBusyRow = false;
      group.querySelectorAll(".wt-files .row").forEach((row) => {
        if (rowMatches(row, operation.paths)) {
          hasBusyRow = true;
          markBusy(row, title);
        }
      });
      if (hasBusyRow) {
        markBusy(group, title);
      }
    });
  }

  /** 현재 stage/unstage 작업 중인지 반환한다. 중복 클릭 방지에 사용한다. */
  function isActive() {
    return !!operation;
  }

  /** 작업 상태 표시/숨김을 지연시켜 빠른 작업에서 깜박임만 생기는 것을 막는다. */
  function scheduleApply() {
    if (operation) {
      if (visible) {
        apply();
        return;
      }
      if (!showTimer) {
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          if (!operation) {
            return;
          }
          visible = true;
          shownAt = Date.now();
          apply();
        }, SHOW_DELAY_MS);
      }
      return;
    }
    cancelShow();
    if (!visible) {
      apply();
      return;
    }
    const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
    cancelHide();
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      visible = false;
      lastOperation = null;
      apply();
    }, remaining);
  }

  /** 대기 중인 표시 타이머를 취소한다. */
  function cancelShow() {
    if (showTimer) {
      window.clearTimeout(showTimer);
      showTimer = 0;
    }
  }

  /** 대기 중인 숨김 타이머를 취소한다. */
  function cancelHide() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  /** 기존 busy 표시를 제거하고 title/aria 상태를 원래대로 되돌린다. */
  function clearBusyElements(root) {
    root.querySelectorAll(".operation-pending").forEach((el) => {
      el.classList.remove("operation-pending");
      el.removeAttribute("aria-busy");
      if (el.dataset.originalTitle !== undefined) {
        el.title = el.dataset.originalTitle;
        delete el.dataset.originalTitle;
      }
    });
  }

  /** Changes 섹션 본문 상단에 현재 작업 상태 바를 삽입하거나 제거한다. */
  function renderStatus(root) {
    const existing = root.querySelector(".working-op-status");
    const current = operation || lastOperation;
    if (!visible || !current) {
      existing?.remove();
      return;
    }
    const body = root.querySelector('.section[data-section="changes"] .section-body');
    if (!body) {
      return;
    }
    const status = existing || document.createElement("div");
    if (!existing) {
      status.className = "working-op-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.innerHTML =
        '<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>' +
        '<span class="working-op-text"></span>' +
        '<span class="working-op-detail"></span>' +
        '<span class="working-op-track" aria-hidden="true"><span></span></span>';
      body.insertBefore(status, body.firstChild);
    }
    status.querySelector(".working-op-text").textContent = titleForAction(current.action);
    status.querySelector(".working-op-detail").textContent = detailForOperation(current);
  }

  /** 요소 하나에 busy 표시와 접근성 상태를 적용한다. */
  function markBusy(el, title) {
    if (el.dataset.originalTitle === undefined) {
      el.dataset.originalTitle = el.title || "";
    }
    el.classList.add("operation-pending");
    el.setAttribute("aria-busy", "true");
    el.title = title;
  }

  /** 행 경로가 작업 대상 path 목록에 포함되는지 확인한다. */
  function rowMatches(row, paths) {
    const rowPath = row.dataset.path || "";
    if (!rowPath) {
      return false;
    }
    return paths.some((path) => pathMatches(rowPath, path));
  }

  /** 파일/폴더 경로 사이의 포함 관계까지 고려해 작업 대상 여부를 판단한다. */
  function pathMatches(rowPath, targetPath) {
    return (
      rowPath === targetPath ||
      rowPath.startsWith(`${targetPath}/`) ||
      targetPath.startsWith(`${rowPath}/`)
    );
  }

  /** stage/unstage 액션이 어느 그룹에서 출발하는지 반환한다. */
  function groupForAction(action) {
    return action === "stage" ? "unstaged" : "staged";
  }

  /** 작업 종류별 사용자 표시 문구를 반환한다. */
  function titleForAction(action) {
    return action === "stage" ? T.stagingChanges : T.unstagingChanges;
  }

  /** phase 와 대상 개수를 조합한 상세 진행 문구를 만든다. */
  function detailForOperation(current) {
    const target =
      current.paths.length > 0
        ? format(T.selectedFiles, String(current.paths.length))
        : T.allChanges;
    const phase =
      current.phase === "refresh" ? T.refreshingChanges : T.updatingGitIndex;
    return `${phase} - ${target}`;
  }

  /** 단순 {0} 치환 포맷터. */
  function format(template, value) {
    return String(template).replace("{0}", value);
  }

  /** stage/unstage 만 작업 진행 상태 대상으로 삼는다. */
  function isWorkingAction(action) {
    return action === "stage" || action === "unstage";
  }

  /** 메시지 payload 의 경로 목록을 문자열 배열로 정규화한다. 빈 배열은 전체 그룹 작업을 뜻한다. */
  function normalizePaths(paths) {
    return Array.isArray(paths)
      ? paths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
  }

  window.__gscBeginWorkingOperation = begin;
  window.__gscSetWorkingOperation = setOperation;
  window.__gscApplyWorkingOperation = apply;
  window.__gscIsWorkingOperationActive = isActive;
})();
