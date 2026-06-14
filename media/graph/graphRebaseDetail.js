// 그래프 drawer 안에 interactive rebase 커밋 편집 섹션을 렌더링한다.
// - popup 을 만들지 않고 기존 commit detail 화면에서 action/message/파일 제외를 수정한다.
(function () {
  "use strict";

  const ACTIONS = ["pick", "reword", "edit", "squash", "fixup", "drop"];

  /** 버튼/입력에 공통 tooltip 속성을 만든다. */
  function title(text, esc) {
    const safe = esc(text);
    return `title="${safe}" aria-label="${safe}" data-tooltip="${safe}"`;
  }

  /** 커밋 원문 메시지와 사용자가 편집 중인 메시지를 합쳐 textarea 기본값을 만든다. */
  function itemMessage(item) {
    const body = item.body && item.body !== item.subject ? `\n\n${item.body}` : "";
    return (item.message || `${item.subject || ""}${body}`).trim();
  }

  /** 계획 전체에 적용된 히스토리 제외 경로 집합을 만든다. */
  function historyPaths() {
    const items = window.GscGraphRebaseContext?.items?.() || [];
    return new Set(items.flatMap((item) => item.historyExcludePaths || []));
  }

  /** 현재 detail 커밋이 rebase 계획에 포함되어 있으면 편집 섹션 HTML 을 반환한다. */
  function detailHtml(detail, esc) {
    const item = window.GscGraphRebaseContext?.itemForHash?.(detail.hash);
    if (!item) {
      return "";
    }
    const paused = window.GscGraphRebaseContext?.paused?.() || null;
    const isPausedHere = paused &&
      (paused.originalHash === detail.hash || paused.hash === detail.hash);
    const paths = historyPaths();
    const actionOptions = ACTIONS.map((action) =>
      `<option value="${action}"${item.action === action ? " selected" : ""}>${action}</option>`
    ).join("");
    const files = (item.files || detail.files || []).map((file) =>
      fileRowHtml(item, file, paths, item.action === "edit", isPausedHere, esc)
    ).join("");
    return (
      `<section class="rebase-detail-editor" data-rebase-hash="${esc(detail.hash)}">` +
      `<div class="rebase-detail-title"><span class="codicon codicon-edit"></span>` +
      `<strong>Interactive rebase edit</strong></div>` +
      `<label class="field"><span>Action</span><select id="rebase-detail-action" ` +
      `${title("Choose rebase action for this commit", esc)}>${actionOptions}</select></label>` +
      `<label class="field message"><span>Commit message</span>` +
      `<textarea id="rebase-detail-message" spellcheck="false" ` +
      `${title("Edit the commit message used by reword or squash", esc)}>${esc(itemMessage(item))}</textarea></label>` +
      editPanelHtml(item, isPausedHere, Boolean(paused), esc) +
      `<div class="files-title"><span>Changed files</span><span class="count">${(item.files || detail.files || []).length}</span></div>` +
      `<div class="rebase-detail-files">${files || `<p>No changed files.</p>`}</div>` +
      `</section>`
    );
  }

  /** edit action 상태에 맞는 수동 편집 패널을 만든다. */
  function editPanelHtml(item, isPausedHere, hasPaused, esc) {
    if (item.action !== "edit") {
      return "";
    }
    const editCta = isPausedHere
      ? buttonHtml("open-first-edit-file", "go-to-file", "Open editable diff", "Open a temporary editable copy of the first file in this paused commit", esc)
      : buttonHtml("start-edit-rebase", "play", "Start rebase", "Start this interactive rebase plan; Git will pause at edit commits so their historical files can be changed", esc);
    const flowCtas = hasPaused
      ? buttonHtml("continue-rebase", "debug-continue", "Continue", "Save rebase edit files, amend the paused commit, then run git rebase --continue; Git may pause at the next edit commit or conflicts", esc) +
        buttonHtml("abort-rebase", "debug-stop", "Abort", "Abort this rebase and restore the branch to the state before the rebase started", esc)
      : "";
    const state = isPausedHere ? "Paused here" : "Will pause here";
    return (
      `<div class="edit-state"><span class="codicon codicon-debug-pause" aria-hidden="true"></span>` +
      `<strong>${state}</strong>${editCta}${flowCtas}</div>`
    );
  }

  /** 변경 파일 한 줄과 제외 버튼을 만든다. */
  function fileRowHtml(item, file, history, editMode, isPausedHere, esc) {
    const excluded = (item.excludePaths || []).includes(file.path);
    const historyExcluded = history.has(file.path);
    const editButton = editMode
      ? fileEditButton(file, isPausedHere, esc)
      : "";
    const slash = file.path.lastIndexOf("/");
    const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const dir = slash >= 0 ? file.path.slice(0, slash) : "";
    const dirHtml = dir ? `<span class="dir">${esc(dir)}</span>` : "";
    return (
      `<div class="file-row" data-status="${esc(file.status)}" data-path="${esc(file.path)}"` +
      `${file.status.startsWith("D") ? " data-deleted=\"1\"" : ""} title="${esc(displayPath(file))}">` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(file.status)}"></span>` +
      `<span class="extension-icon codicon codicon-file"></span>` +
      `<span class="name">${esc(fileName)}</span>${dirHtml}${statHtml(file)}` +
      `<span class="file-rewrite-actions">${editButton}` +
      toggleButton("commit", excluded, "Omit here", "Omitted here", "Remove this file change from only this commit", esc) +
      toggleButton("history", historyExcluded, "Remove from history", "Removed from history", "Remove this file from every commit in this rebase range", esc) +
      `</span>` +
      `</div>`
    );
  }

  /** 파일 row 의 editable diff 버튼을 만든다. */
  function fileEditButton(file, isPausedHere, esc) {
    if (file.status.startsWith("D")) {
      const tooltip = title("Deleted files cannot be opened as editable working-tree diffs", esc);
      return `<span class="edit-unavailable icon-action" ${tooltip}>` +
        `<span class="codicon codicon-warning" aria-hidden="true"></span></span>`;
    }
    const tooltip = isPausedHere
      ? "Open a temporary editable copy of this historical file; Continue applies it to the paused commit"
      : "Start rebase and open a temporary editable copy of this file when Git pauses here";
    return iconButton("open-edit-file", "edit", tooltip, esc);
  }

  /** changes 아코디언과 같은 상태 아이콘을 반환한다. */
  function statusCodicon(status) {
    switch (status) {
      case "A":
        return "codicon-diff-added";
      case "D":
        return "codicon-diff-removed";
      case "R":
      case "C":
        return "codicon-diff-renamed";
      case "U":
        return "codicon-warning";
      default:
        return "codicon-diff-modified";
    }
  }

  /** +추가 −삭제 숫자를 색상 span 으로 만든다. */
  function statHtml(file) {
    return (
      `<span class="stat"><span class="add">+${file.additions || 0}</span> ` +
      `<span class="del">−${file.deletions || 0}</span></span>`
    );
  }

  /** 이름변경을 포함한 전체 파일 표시 경로를 만든다. */
  function displayPath(file) {
    return file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  }

  /** 파일 제외 토글 버튼을 만든다. */
  function toggleButton(kind, active, inactiveLabel, activeLabel, tooltip, esc) {
    const label = active ? activeLabel : inactiveLabel;
    const icon = kind === "history" ? "history" : "exclude";
    const activeClass = active ? " active" : "";
    return `<button type="button" data-exclude="${kind}" class="icon-action${activeClass}" ` +
      `aria-pressed="${active ? "true" : "false"}" ${title(`${label}. ${tooltip}`, esc)}>` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  }

  /** drawer 안에 들어가는 일반 action 버튼을 만든다. */
  function buttonHtml(action, icon, label, tooltip, esc) {
    return (
      `<button type="button" data-rebase-action="${action}" ${title(tooltip, esc)}>` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span><span>${esc(label)}</span></button>`
    );
  }

  /** 파일 row hover 액션에 쓰는 icon-only 버튼을 만든다. */
  function iconButton(action, icon, tooltip, esc) {
    return (
      `<button type="button" class="icon-action" data-rebase-action="${action}" ${title(tooltip, esc)}>` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`
    );
  }

  /** drawer 안의 rebase 편집 컨트롤 이벤트를 연결한다. */
  function bind(root, detail) {
    const section = root.querySelector(".rebase-detail-editor");
    if (!section) {
      return;
    }
    const hash = section.dataset.rebaseHash || detail.hash;
    const actionSelect = section.querySelector("#rebase-detail-action");
    actionSelect?.addEventListener("change", (event) => {
      window.GscGraphRebaseContext?.updateAction?.(hash, event.target.value);
      window.GscGraphDetail?.refresh?.();
    });
    section.querySelector("#rebase-detail-message")?.addEventListener("input", (event) => {
      window.GscGraphRebaseContext?.updateMessage?.(hash, event.target.value);
      if (actionSelect?.value === "pick") {
        actionSelect.value = "reword";
      }
    });
    section.querySelectorAll("[data-exclude]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.closest(".file-row")?.dataset.path || "";
        if (button.dataset.exclude === "history") {
          window.GscGraphRebaseContext?.toggleHistoryExclude?.(path);
        } else {
          window.GscGraphRebaseContext?.toggleCommitExclude?.(hash, path);
        }
        window.GscGraphDetail?.refresh?.();
      });
    });
    section.querySelector('[data-rebase-action="start-edit-rebase"]')?.addEventListener("click", () => {
      document.getElementById("graph-rebase-run")?.click();
    });
    section.querySelector('[data-rebase-action="open-first-edit-file"]')?.addEventListener("click", () => {
      const path = section.querySelector(".file-row:not([data-deleted])")?.dataset.path || "";
      openEditFile(path);
    });
    section.querySelector('[data-rebase-action="continue-rebase"]')?.addEventListener("click", () => {
      window.GscGraphRebaseContext?.continueRebase?.();
    });
    section.querySelector('[data-rebase-action="abort-rebase"]')?.addEventListener("click", () => {
      window.GscGraphRebaseContext?.abortRebase?.();
    });
    section.querySelectorAll('[data-rebase-action="open-edit-file"]').forEach((button) => {
      button.addEventListener("click", () => {
        openEditFile(button.closest(".file-row")?.dataset.path || "");
      });
    });
  }

  /** edit 정지 지점의 파일을 확장 호스트에 요청해 editable diff 로 연다. */
  function openEditFile(path) {
    if (!path) {
      return;
    }
    window.GscGraphRebaseContext?.requestEditFile?.(path);
  }

  /** rebase edit 커밋에서는 중복 changed-files 패널을 숨겨 edit 전용 패널만 남긴다. */
  function hideFilesPane(detail) {
    const item = window.GscGraphRebaseContext?.itemForHash?.(detail.hash);
    return item?.action === "edit";
  }

  window.GscGraphRebaseDetail = { detailHtml, bind, hideFilesPane };
})();
