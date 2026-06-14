// 그래프 interactive rebase 커밋 상세 편집기.
// - rebase item 을 직접 수정한다: action, 커밋 메시지, 커밋별 파일 제외, 브랜치 히스토리 전체 파일 제외.
(function () {
  "use strict";

  const ACTIONS = ["pick", "reword", "edit", "squash", "fixup", "drop"];
  let current = null;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text == null ? "" : text).replace(/[&<>"]/g, (ch) => map[ch]);
  }

  /** 버튼/입력에 공통 tooltip 속성을 만든다. */
  function title(text) {
    const safe = esc(text);
    return `title="${safe}" aria-label="${safe}" data-tooltip="${safe}"`;
  }

  /** 커밋 원문 메시지와 사용자가 편집 중인 메시지를 합쳐 textarea 기본값을 만든다. */
  function itemMessage(item) {
    const body = item.body && item.body !== item.subject ? `\n\n${item.body}` : "";
    return (item.message || `${item.subject || ""}${body}`).trim();
  }

  /** 계획 전체에 적용된 히스토리 제외 경로 집합을 만든다. */
  function historyPaths(items) {
    return new Set(items.flatMap((item) => item.historyExcludePaths || []));
  }

  /** 특정 rebase item 의 상세 편집 패널을 연다. */
  function open(items, hash, onChange) {
    const item = items.find((entry) => entry.hash === hash);
    if (!item) {
      return false;
    }
    current = { items, item, onChange };
    render();
    return true;
  }

  /** 현재 선택된 item 을 기준으로 패널을 다시 그린다. */
  function render() {
    close();
    if (!current) {
      return;
    }
    const panel = document.createElement("section");
    panel.id = "graph-rebase-detail";
    panel.innerHTML = panelHtml(current.items, current.item);
    document.body.appendChild(panel);
    bind(panel);
  }

  /** 상세 패널 전체 HTML 을 만든다. */
  function panelHtml(items, item) {
    const paths = historyPaths(items);
    const actionOptions = ACTIONS.map((action) =>
      `<option value="${action}"${item.action === action ? " selected" : ""}>${action}</option>`
    ).join("");
    const fileRows = (item.files || []).map((file) => fileRowHtml(item, file, paths)).join("");
    return (
      `<header><span class="codicon codicon-edit"></span>` +
      `<strong>${esc(item.subject || item.hash.slice(0, 10))}</strong>` +
      `<button type="button" class="close" ${title("Close rebase detail editor")}>` +
      `<span class="codicon codicon-close"></span></button></header>` +
      `<label class="field"><span>Action</span><select id="rebase-detail-action" ${title("Choose rebase action for this commit")}>${actionOptions}</select></label>` +
      `<label class="field message"><span>Commit message</span>` +
      `<textarea id="rebase-detail-message" spellcheck="false" ${title("Edit the commit message used by reword or squash")}>${esc(itemMessage(item))}</textarea></label>` +
      `<div class="files-title"><span>Changed files</span><span>${(item.files || []).length}</span></div>` +
      `<div class="rebase-detail-files">${fileRows || `<p>No changed files.</p>`}</div>`
    );
  }

  /** 변경 파일 한 줄과 제외 버튼을 만든다. */
  function fileRowHtml(item, file, history) {
    const excluded = (item.excludePaths || []).includes(file.path);
    const historyExcluded = history.has(file.path);
    return (
      `<div class="file-row" data-path="${esc(file.path)}">` +
      `<span class="status">${esc(file.status)}</span><span class="path">${esc(file.path)}</span>` +
      `<button type="button" data-exclude="commit" class="${excluded ? "active" : ""}" ` +
      `${title("Exclude this file from this commit")}>Commit</button>` +
      `<button type="button" data-exclude="history" class="${historyExcluded ? "active" : ""}" ` +
      `${title("Exclude this file from every commit in this branch rebase range")}>History</button>` +
      `</div>`
    );
  }

  /** 패널 안의 입력/버튼 이벤트를 연결한다. */
  function bind(panel) {
    panel.querySelector(".close")?.addEventListener("click", () => {
      current = null;
      close();
    });
    panel.querySelector("#rebase-detail-action")?.addEventListener("change", (event) => {
      current.item.action = event.target.value;
      changed();
    });
    panel.querySelector("#rebase-detail-message")?.addEventListener("input", (event) => {
      current.item.message = event.target.value;
      if (current.item.action === "pick") {
        current.item.action = "reword";
      }
      changed(false);
    });
    panel.querySelectorAll("[data-exclude]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.closest(".file-row")?.dataset.path || "";
        if (button.dataset.exclude === "history") {
          toggleHistory(path);
        } else {
          togglePath(current.item, "excludePaths", path);
        }
        changed();
      });
    });
  }

  /** 경로 하나를 모든 rebase item 의 히스토리 제외 목록에 토글한다. */
  function toggleHistory(path) {
    const enabled = historyPaths(current.items).has(path);
    for (const item of current.items) {
      setPath(item, "historyExcludePaths", path, !enabled);
    }
  }

  /** rebase item 의 경로 목록에서 한 경로를 토글한다. */
  function togglePath(item, key, path) {
    setPath(item, key, path, !(item[key] || []).includes(path));
  }

  /** rebase item 의 경로 목록에 값을 명시적으로 반영한다. */
  function setPath(item, key, path, enabled) {
    const next = new Set(item[key] || []);
    enabled ? next.add(path) : next.delete(path);
    item[key] = Array.from(next);
  }

  /** 변경 사항을 그래프 rebase UI 에 알리고 필요하면 패널을 다시 그린다. */
  function changed(redraw = true) {
    current.onChange?.();
    if (redraw) {
      render();
    }
  }

  /** 상세 편집 패널 DOM 을 닫는다. */
  function close() {
    document.getElementById("graph-rebase-detail")?.remove();
  }

  window.GscGraphRebaseDetail = { open };
})();
