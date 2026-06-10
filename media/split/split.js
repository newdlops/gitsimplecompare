// 변경 분할(부분 커밋) 웹뷰의 클라이언트 스크립트.
// - 작업 변경을 파일/hunk 로 보여주고, 체크한 hunk 들만 골라 커밋 메시지와 함께
//   확장으로 보낸다. 커밋 후 남은 변경이 다시 표시되어 반복 분할할 수 있다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const filesEl = document.getElementById("files");
  const messageEl = document.getElementById("message");

  let currentFiles = [];

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** diff 한 줄을 +/-/메타 색상 클래스가 적용된 HTML 로 만든다. */
  function renderLine(line) {
    let cls = "";
    if (line.startsWith("+")) {
      cls = "line-add";
    } else if (line.startsWith("-")) {
      cls = "line-del";
    } else if (line.startsWith("@@") || line.startsWith("\\")) {
      cls = "line-meta";
    }
    return `<span class="${cls}">${esc(line)}</span>`;
  }

  /**
   * 변경 파일 목록을 렌더링한다.
   * @param files DiffFile 배열
   */
  function render(files) {
    currentFiles = files;
    filesEl.innerHTML = "";
    if (!files.length) {
      filesEl.innerHTML = `<p class="empty">No changes to commit.</p>`;
      return;
    }
    for (const file of files) {
      filesEl.appendChild(buildFile(file));
    }
  }

  /**
   * 파일 한 건의 DOM(파일 체크박스 + hunk 들)을 만든다.
   * @param file DiffFile
   */
  function buildFile(file) {
    const wrap = document.createElement("div");
    wrap.className = "file";
    wrap.dataset.path = file.path;
    wrap.dataset.binary = file.binary ? "1" : "";

    const head = document.createElement("div");
    head.className = "file-head";
    head.innerHTML =
      `<input type="checkbox" class="file-check" />` +
      `<span class="path">${esc(file.path)}</span>` +
      (file.binary ? `<span class="line-meta">(binary)</span>` : "");
    wrap.appendChild(head);

    const fileCheck = head.querySelector(".file-check");
    // 파일 체크박스: 하위 hunk 전체 선택/해제
    fileCheck.addEventListener("change", () => {
      wrap
        .querySelectorAll(".hunk-check")
        .forEach((c) => (c.checked = fileCheck.checked));
    });

    for (const hunk of file.hunks) {
      wrap.appendChild(buildHunk(hunk));
    }
    return wrap;
  }

  /**
   * hunk 한 건의 DOM(체크박스 + diff 본문)을 만든다.
   * @param hunk DiffHunk
   */
  function buildHunk(hunk) {
    const el = document.createElement("div");
    el.className = "hunk";
    el.dataset.id = hunk.id;
    const lines = hunk.text.split("\n");
    const headLine = lines[0] || "";
    const body = lines.slice(1).map(renderLine).join("\n");
    el.innerHTML =
      `<div class="hunk-head">` +
      `<input type="checkbox" class="hunk-check" />` +
      `<span class="line-meta">${esc(headLine)}</span></div>` +
      `<pre>${body}</pre>`;
    return el;
  }

  /** 체크된 hunk/파일에서 선택 정보를 수집한다. */
  function collectSelections() {
    const selections = [];
    filesEl.querySelectorAll(".file").forEach((wrap) => {
      const path = wrap.dataset.path;
      const binary = wrap.dataset.binary === "1";
      if (binary) {
        if (wrap.querySelector(".file-check").checked) {
          selections.push({ path: path, hunkIds: [], binary: true });
        }
        return;
      }
      const hunkIds = [];
      wrap.querySelectorAll(".hunk").forEach((h) => {
        if (h.querySelector(".hunk-check").checked) {
          hunkIds.push(h.dataset.id);
        }
      });
      if (hunkIds.length) {
        selections.push({ path: path, hunkIds: hunkIds, binary: false });
      }
    });
    return selections;
  }

  // 커밋 버튼: 선택과 메시지를 검증해 전송
  document.getElementById("commit").addEventListener("click", () => {
    const selections = collectSelections();
    const message = messageEl.value.trim();
    if (!selections.length) {
      vscode.postMessage({ type: "refresh" }); // 선택 없으면 그냥 새로고침
      return;
    }
    if (!message) {
      messageEl.focus();
      return;
    }
    vscode.postMessage({ type: "commit", selections: selections, message: message });
  });

  // 확장에서 오는 메시지 처리
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "changes") {
      render(msg.files);
    } else if (msg.type === "committed") {
      messageEl.value = "";
    } else if (msg.type === "error") {
      filesEl.insertAdjacentHTML(
        "afterbegin",
        `<p class="empty">⚠ ${esc(msg.message)}</p>`
      );
    }
  });

  vscode.postMessage({ type: "ready" });
})();
