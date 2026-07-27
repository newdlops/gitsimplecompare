// Changes History 섹션의 순수 마크업 모듈.
// - 현재 파일·커밋·파일 diff 링크를 렌더링하지만 DOM 이벤트와 persisted state 변경은 소유하지 않는다.
(function () {
  "use strict";

  /** 주입된 Changes 공통 formatter로 History 본문 renderer를 만든다. */
  window.__gscChangesHistory = function createChangesHistory({
    strings: T,
    state,
    esc,
    fileIconHtml,
    statHtml,
    statusCodicon,
    rootEl,
    vscode,
    post,
  }) {
    /** 현재 History 대상 파일의 경로와 파일 아이콘을 표시한다. */
    function currentFileHtml(history) {
      if (!history?.path) return "";
      const slash = history.path.lastIndexOf("/");
      const fileName = slash >= 0 ? history.path.slice(slash + 1) : history.path;
      const dir = slash >= 0 ? history.path.slice(0, slash) : "";
      return `<div class="history-current-file" title="${esc(history.path)}">${fileIconHtml(history.path)}<span class="name">${esc(fileName)}</span>${dir ? `<span class="dir">${esc(dir)}</span>` : ""}</div>`;
    }

    /** 선택한 커밋의 파일 diff를 열 수 있는 접근 가능한 링크형 버튼을 만든다. */
    function fileLinkHtml(repoRoot, commit) {
      const label = commit.oldPath ? `${commit.oldPath} → ${commit.path}` : commit.path;
      const tooltip = `${T.openHistoryCommit}: ${label}`;
      return `<button class="history-file-link" type="button" data-repo-root="${esc(repoRoot || "")}" data-path="${esc(commit.path)}" data-old-path="${esc(commit.oldPath || "")}" data-base-ref="${esc(commit.baseRef)}" data-head-ref="${esc(commit.hash)}" data-short-hash="${esc(commit.shortHash)}" data-title="${esc(commit.title)}" title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}"><span class="codicon codicon-diff" aria-hidden="true"></span>${fileIconHtml(commit.path)}<span class="name">${esc(label)}</span>${statHtml(commit)}</button>`;
    }

    /** 하나의 History commit disclosure와 메시지 상세를 만든다. */
    function commitHtml(repoRoot, commit) {
      const key = commit.hash || `${commit.path}:${commit.shortHash || ""}`;
      const expanded = !!state.historyExpanded[key];
      const title = `${commit.shortHash || commit.hash} ${commit.title || ""}`.trim();
      const meta = [commit.author, commit.relativeDate || commit.dateIso].filter(Boolean).join(" · ");
      const tooltip = `${T.toggleSection}: ${title}`;
      const message = (commit.message || commit.title || "").trim();
      return `<div class="history-item${expanded ? "" : " collapsed"}" data-key="${esc(key)}"><div class="row file history-commit" role="button" tabindex="0" data-status="${esc(commit.status)}" data-key="${esc(key)}" title="${esc(tooltip)}" aria-label="${esc(tooltip)}" aria-expanded="${expanded ? "true" : "false"}"><span class="twistie codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}"></span><span class="icon codicon ${statusCodicon(commit.status)}"></span><span class="history-hash">${esc(commit.shortHash || commit.hash.slice(0, 7))}</span><span class="name history-title">${esc(commit.title)}</span>${meta ? `<span class="history-meta">${esc(meta)}</span>` : ""}${statHtml(commit)}</div><div class="history-details"><pre class="history-message">${esc(message)}</pre>${fileLinkHtml(repoRoot, commit)}</div></div>`;
    }

    /** History의 empty/error/loaded 상태를 서로 구분해 본문 HTML로 반환한다. */
    function historyBody(history) {
      if (!history?.path) return `<p class="empty">${esc(history?.message || T.noHistoryFile)}</p>`;
      const currentFile = currentFileHtml(history);
      if (history.message) return `${currentFile}<p class="empty">${esc(history.message)}</p>`;
      const commits = history.commits || [];
      if (!commits.length) return `${currentFile}<p class="empty">${esc(T.noHistory)}</p>`;
      return `${currentFile}<div class="files history-files"><div class="rows">${commits.map((commit) => commitHtml(history.repoRoot, commit)).join("")}</div></div>`;
    }

    /** History commit disclosure와 상세 파일 diff 열기 동작을 현재 DOM에 연결한다. */
    function bindHistory() {
      rootEl.querySelectorAll(".history-commit").forEach((element) => {
        element.addEventListener("click", () => toggleHistoryItem(element));
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleHistoryItem(element);
        });
      });
      rootEl.querySelectorAll(".history-file-link").forEach((element) => {
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          post("openFileHistoryCommit", {
            repoRoot: element.dataset.repoRoot,
            path: element.dataset.path,
            oldPath: element.dataset.oldPath || undefined,
            baseRef: element.dataset.baseRef,
            headRef: element.dataset.headRef,
            shortHash: element.dataset.shortHash,
            title: element.dataset.title,
          });
        });
      });
    }

    /** 클릭한 commit 행의 persisted disclosure 상태와 Codicon을 함께 바꾼다. */
    function toggleHistoryItem(element) {
      const item = element.closest(".history-item");
      const key = item?.dataset.key || element.dataset.key;
      if (!item || !key) return;
      const expanded = !state.historyExpanded[key];
      state.historyExpanded[key] = expanded;
      vscode.setState(state);
      item.classList.toggle("collapsed", !expanded);
      element.setAttribute("aria-expanded", expanded ? "true" : "false");
      const twistie = element.querySelector(".twistie");
      twistie?.classList.toggle("codicon-chevron-down", expanded);
      twistie?.classList.toggle("codicon-chevron-right", !expanded);
    }

    return { bindHistory, historyBody };
  };
}());
