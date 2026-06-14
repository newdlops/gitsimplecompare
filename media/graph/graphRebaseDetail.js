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
    const paths = historyPaths();
    const actionOptions = ACTIONS.map((action) =>
      `<option value="${action}"${item.action === action ? " selected" : ""}>${action}</option>`
    ).join("");
    const files = (item.files || detail.files || []).map((file) =>
      fileRowHtml(item, file, paths, esc)
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
      `<div class="files-title"><span>Changed files</span><span>${(item.files || detail.files || []).length}</span></div>` +
      `<div class="rebase-detail-files">${files || `<p>No changed files.</p>`}</div>` +
      `</section>`
    );
  }

  /** 변경 파일 한 줄과 제외 버튼을 만든다. */
  function fileRowHtml(item, file, history, esc) {
    const excluded = (item.excludePaths || []).includes(file.path);
    const historyExcluded = history.has(file.path);
    return (
      `<div class="file-row" data-path="${esc(file.path)}">` +
      `<span class="status">${esc(file.status)}</span><span class="path">${esc(file.path)}</span>` +
      `<button type="button" data-exclude="commit" class="${excluded ? "active" : ""}" ` +
      `${title("Exclude this file from this commit", esc)}>Commit</button>` +
      `<button type="button" data-exclude="history" class="${historyExcluded ? "active" : ""}" ` +
      `${title("Exclude this file from every commit in this branch rebase range", esc)}>History</button>` +
      `</div>`
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
  }

  window.GscGraphRebaseDetail = { detailHtml, bind };
})();
