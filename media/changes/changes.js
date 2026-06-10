// CHANGES 사이드바 웹뷰의 클라이언트 스크립트.
// - 확장에서 받은 payload(비교/초안 + 노드 트리)를 VS Code 네이티브 트리 모양으로 그린다.
//   codicon 아이콘 + list 테마 색을 사용하고, 폴더는 접기/펼치기, #files 는 가로 스크롤.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const refsEl = document.getElementById("refs");
  const filesEl = document.getElementById("files");

  // 확장에서 주입한 지역화 문자열(없으면 영어 기본값).
  const T = Object.assign(
    {
      from: "From:",
      to: "To:",
      selectBranch: "(select a branch)",
      compare: "Compare",
      noChanges: "No changes between the selected branches.",
      change: "Change branch",
    },
    window.__gscI18n || {}
  );

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 상태 코드에 맞는 codicon 클래스를 반환한다(diff 계열 아이콘). */
  function statusCodicon(status) {
    switch (status) {
      case "A":
        return "codicon-diff-added";
      case "D":
        return "codicon-diff-removed";
      case "R":
      case "C":
        return "codicon-diff-renamed";
      default:
        return "codicon-diff-modified";
    }
  }

  /** +추가 −삭제 숫자를 색상 span 으로 만든다(정보 없으면 빈 문자열). */
  function statHtml(change) {
    if (change.additions === undefined && change.deletions === undefined) {
      return "";
    }
    const add = change.additions || 0;
    const del = change.deletions || 0;
    return (
      `<span class="stat"><span class="add">+${add}</span> ` +
      `<span class="del">−${del}</span></span>`
    );
  }

  /**
   * From/To 헤더 행과 (초안일 때) Compare 버튼을 그린다.
   * @param p 렌더 payload
   */
  function renderRefs(p) {
    const refRow = (side, value) => {
      const isEmpty = !value;
      const label = side === "from" ? T.from : T.to;
      const icon = side === "from" ? "codicon-git-commit" : "codicon-target";
      const shown = isEmpty ? T.selectBranch : value;
      return (
        `<div class="ref" data-side="${side}">` +
        `<span class="icon codicon ${icon}"></span>` +
        `<span class="label">${esc(label)}</span>` +
        `<span class="value${isEmpty ? " empty" : ""}">${esc(shown)}</span>` +
        `<span class="actions"><span class="action codicon codicon-edit" ` +
        `title="${esc(T.change)}"></span></span></div>`
      );
    };
    let html = refRow("from", p.from) + refRow("to", p.to);
    if (p.mode === "draft") {
      html +=
        `<button id="compare"><span class="codicon codicon-git-compare">` +
        `</span>${esc(T.compare)}</button>`;
    }
    refsEl.innerHTML = html;

    refsEl.querySelectorAll(".ref").forEach((el) => {
      el.addEventListener("click", () =>
        vscode.postMessage({ type: "changeRef", side: el.dataset.side })
      );
    });
    const compareBtn = document.getElementById("compare");
    if (compareBtn) {
      compareBtn.addEventListener("click", () =>
        vscode.postMessage({ type: "runCompare" })
      );
    }
  }

  /**
   * 노드(폴더/파일)를 재귀적으로 HTML 로 만든다(들여쓰기는 .children 중첩으로 표현).
   * @param node     TreeNode
   * @param viewMode tree/list
   */
  function nodeHtml(node, viewMode) {
    if (node.kind === "folder") {
      const children = node.children
        .map((c) => nodeHtml(c, viewMode))
        .join("");
      return (
        `<div class="row folder">` +
        `<span class="twistie codicon codicon-chevron-down"></span>` +
        `<span class="icon codicon codicon-folder-opened"></span>` +
        `<span class="name">${esc(node.name)}</span></div>` +
        `<div class="children">${children}</div>`
      );
    }
    const ch = node.change;
    const slash = ch.path.lastIndexOf("/");
    const fileName = slash >= 0 ? ch.path.slice(slash + 1) : ch.path;
    const dir = slash >= 0 ? ch.path.slice(0, slash) : "";
    const dirHtml =
      viewMode === "list" && dir ? `<span class="dir">${esc(dir)}</span>` : "";
    return (
      `<div class="row file" data-status="${esc(ch.status)}" ` +
      `data-path="${esc(ch.path)}">` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(ch.status)}"></span>` +
      `<span class="name">${esc(fileName)}</span>` +
      dirHtml +
      statHtml(ch) +
      `</div>`
    );
  }

  /**
   * 변경 파일 영역을 그린다.
   * @param p 렌더 payload
   */
  function renderFiles(p) {
    if (p.mode === "draft") {
      filesEl.innerHTML = "";
      return;
    }
    if (!p.nodes.length) {
      filesEl.innerHTML = `<p class="empty">${esc(T.noChanges)}</p>`;
      return;
    }
    const rows = p.nodes.map((n) => nodeHtml(n, p.viewMode)).join("");
    filesEl.innerHTML = `<div class="rows">${rows}</div>`;

    // 폴더 토글(자식 접기/펼치기 + twistie/폴더 아이콘 전환)
    filesEl.querySelectorAll(".row.folder").forEach((el) => {
      el.addEventListener("click", () => {
        const children = el.nextElementSibling;
        if (!children || !children.classList.contains("children")) {
          return;
        }
        const collapsed = children.classList.toggle("collapsed");
        const twistie = el.querySelector(".twistie");
        const folderIcon = el.querySelector(".icon");
        twistie.classList.toggle("codicon-chevron-down", !collapsed);
        twistie.classList.toggle("codicon-chevron-right", collapsed);
        folderIcon.classList.toggle("codicon-folder-opened", !collapsed);
        folderIcon.classList.toggle("codicon-folder", collapsed);
      });
    });
    // 파일 클릭 → diff 열기
    filesEl.querySelectorAll(".row.file").forEach((el) => {
      el.addEventListener("click", () =>
        vscode.postMessage({ type: "openDiff", path: el.dataset.path })
      );
    });
  }

  // 확장에서 오는 렌더 메시지 처리
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "render") {
      renderRefs(msg.payload);
      renderFiles(msg.payload);
    }
  });

  // 준비 완료를 알려 초기 상태를 받는다.
  vscode.postMessage({ type: "ready" });
})();
