// git graph 상세 패널 렌더러.
// - graph.js 에서 커밋 상세 화면을 분리해 브랜치/작성자/파일 보기 전환 UI 를 독립적으로 관리한다.
(function () {
  "use strict";

  let fileViewMode = "tree";
  let lastDetail = null;
  let lastHost = null;
  let collapsedFolders = new Set();

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** ISO 날짜를 YYYY-MM-DD HH:mm 형태로 짧게 표시한다. */
  function formatDate(iso) {
    if (!iso) {
      return "";
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return iso;
    }
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  }

  /**
   * 커밋 상세를 오른쪽 패널에 렌더링한다.
   * @param detail CommitDetail payload
   * @param host graph.js 가 넘겨주는 DOM/콜백 묶음
   */
  function render(detail, host) {
    lastDetail = detail;
    lastHost = host;
    collapsedFolders = new Set();
    draw();
  }

  /** 마지막 detail/host 상태로 상세 패널을 다시 그린다. */
  function draw() {
    if (!lastDetail || !lastHost?.root) {
      return;
    }
    const detail = lastDetail;
    const title = detail.message.split("\n")[0] || detail.hash.slice(0, 10);
    const actions = window.GscGraphFeatures?.commitActions(detail, esc) || "";
    lastHost.root.innerHTML =
      `<div class="detail-shell">` +
      `<section class="commit-summary">` +
      `<h2>${esc(title)}</h2>` +
      metaHtml(detail) +
      branchHtml(detail.branches || []) +
      authorHtml(detail) +
      `<div class="actions">${actions}</div>` +
      messageHtml(detail.message) +
      `</section>` +
      `<div id="detail-splitter" class="detail-splitter" role="separator" ` +
      `aria-orientation="horizontal" tabindex="0" title="Resize file list" ` +
      `aria-label="Resize file list"></div>` +
      filesPaneHtml(detail) +
      `</div>`;
    bindEvents(detail);
    lastHost.bindSplitter?.();
  }

  /** 해시/작성 시각을 담은 상세 메타 HTML 을 만든다. */
  function metaHtml(detail) {
    return (
      `<div class="commit-meta"><span>${esc(detail.hash.slice(0, 10))}</span>` +
      `<button id="copy-hash-inline" class="icon-mini" type="button" ` +
      `title="Copy commit hash" aria-label="Copy commit hash">` +
      `<span class="codicon codicon-clippy" aria-hidden="true"></span></button>` +
      `<span class="commit-date">${esc(formatDate(detail.authorDateIso))}</span></div>`
    );
  }

  /** 커밋을 포함하는 브랜치 목록을 chip 형태로 만든다. */
  function branchHtml(branches) {
    const chips = branches.length
      ? branches.slice(0, 16).map(branchChipHtml).join("")
      : `<span class="branch-empty">No branch contains this commit</span>`;
    const extra = branches.length > 16
      ? `<span class="branch-extra">+${branches.length - 16}</span>`
      : "";
    return (
      `<div class="detail-branches" aria-label="Branches containing this commit">` +
      `<span class="codicon codicon-git-branch" aria-hidden="true"></span>` +
      `<div class="branch-list">${chips}${extra}</div></div>`
    );
  }

  /** 브랜치 한 건의 chip HTML 을 만든다. */
  function branchChipHtml(branch) {
    const cls = [
      "detail-branch",
      branch.kind === "remote" ? "remote" : "local",
      branch.current ? "current" : "",
    ].filter(Boolean).join(" ");
    const color = graphColorForBranch(branch);
    const style = color ? ` style="--detail-branch-color: ${color}"` : "";
    const title = `${branch.current ? "current " : ""}${branch.kind} branch ${branch.name} contains this commit`;
    return `<span class="${cls}"${style} title="${esc(title)}">${esc(branch.name)}</span>`;
  }

  /**
   * 상세 브랜치 chip 에 쓸 그래프 색상을 찾는다.
   * - 브랜치 tip row 가 현재 렌더된 그래프에 있으면 그 row 의 ref 배지 색상을 우선 사용한다.
   * @param branch 상세 패널에 표시할 브랜치 정보
   * @returns CSS custom property 에 넣을 수 있는 안전한 색상값
   */
  function graphColorForBranch(branch) {
    return (
      graphColorForHash(branch?.tipHash) ||
      graphColorForRef(branch?.name) ||
      window.GscGraphFeatures?.branchColor?.(branch?.name) ||
      graphColorForHash(lastDetail?.hash) ||
      ""
    );
  }

  /**
   * 렌더된 그래프 row 중 특정 ref 를 가진 row 의 레인 색상을 반환한다.
   * @param ref 찾을 브랜치 ref 이름
   * @returns 그래프 row 에 설정된 색상값
   */
  function graphColorForRef(ref) {
    if (!ref) {
      return "";
    }
    const rows = document.querySelectorAll("#graph-content .row");
    for (const row of rows) {
      const refs = (row.dataset.refs || "").split("\t");
      if (refs.includes(ref)) {
        return safeGraphColor(row.style.getPropertyValue("--branch-color"));
      }
    }
    return "";
  }

  /**
   * 브랜치 tip row 를 찾지 못한 경우 선택 커밋 row 의 레인 색상을 fallback 으로 반환한다.
   * @param hash 현재 상세 패널이 보여주는 커밋 해시
   * @returns 선택 커밋 row 에 설정된 색상값
   */
  function graphColorForHash(hash) {
    if (!hash) {
      return "";
    }
    const rows = document.querySelectorAll("#graph-content .row");
    for (const row of rows) {
      if (row.dataset.hash === hash) {
        return safeGraphColor(row.style.getPropertyValue("--branch-color"));
      }
    }
    return "";
  }

  /**
   * 내부 그래프 팔레트에서 온 hex 색상만 style 속성으로 전달한다.
   * @param color row 의 `--branch-color` 값
   * @returns 안전하게 검증된 hex 색상 또는 빈 문자열
   */
  function safeGraphColor(color) {
    const value = String(color || "").trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : "";
  }

  /** 작성자 정보를 공간을 적게 쓰는 한 줄 HTML 로 만든다. */
  function authorHtml(detail) {
    const email = detail.authorEmail || "";
    return (
      `<div class="author-line">` +
      `<span class="codicon codicon-account" aria-hidden="true"></span>` +
      `<span class="author-name">${esc(detail.authorName || "Unknown author")}</span>` +
      (email ? `<span class="author-email">&lt;${esc(email)}&gt;</span>` : "") +
      `</div>`
    );
  }

  /** 커밋 메시지 박스 HTML 을 만든다. */
  function messageHtml(message) {
    return (
      `<div class="message"><button id="copy-message-inline" class="message-copy" ` +
      `type="button" title="Copy commit message" aria-label="Copy commit message">` +
      `<span class="codicon codicon-clippy" aria-hidden="true"></span></button>` +
      `<pre>${esc(message)}</pre></div>`
    );
  }

  /** 파일 패널 전체 HTML 을 만든다. */
  function filesPaneHtml(detail) {
    return (
      `<section class="files-pane">` +
      `<div class="files-header"><span class="codicon codicon-files" aria-hidden="true"></span>` +
      `<span>Changed files</span><span class="count">${detail.files.length}</span>` +
      fileViewToggleHtml() +
      `</div>` +
      filesHtml(detail.files || []) +
      `</section>`
    );
  }

  /** 파일 보기 모드 전환 버튼 HTML 을 만든다. */
  function fileViewToggleHtml() {
    return (
      `<div class="file-view-toggle" role="group" aria-label="Changed files view">` +
      viewButton("tree", "list-tree", "View changed files as tree") +
      viewButton("list", "list-selection", "View changed files as list") +
      `</div>`
    );
  }

  /** 파일 보기 전환 버튼 한 개를 만든다. */
  function viewButton(mode, icon, title) {
    const active = fileViewMode === mode;
    return (
      `<button class="file-view-button${active ? " active" : ""}" type="button" ` +
      `data-file-view="${mode}" aria-pressed="${active ? "true" : "false"}" ` +
      `title="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`
    );
  }

  /** 현재 모드에 맞는 파일 목록 HTML 을 만든다. */
  function filesHtml(files) {
    if (!files.length) {
      return `<p class="empty">No changed files.</p>`;
    }
    if (fileViewMode === "list") {
      return `<ul class="files list" role="list">${files.map((file) => fileHtml(file, 0, "listitem", displayPath(file))).join("")}</ul>`;
    }
    const tree = buildTree(files);
    return `<ul class="files tree" role="tree">${treeNodesHtml(tree.nodes, 0)}</ul>`;
  }

  /** 파일 경로 배열을 공통 상위 경로부터 시작하는 폴더/파일 트리 노드로 변환한다. */
  function buildTree(files) {
    const base = commonDirectory(files);
    const root = [];
    const folders = new Map();
    for (const file of files) {
      const parts = stripBase(file.path, base).split("/").filter(Boolean);
      let children = root;
      let currentPath = base.join("/");
      for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        let folder = folders.get(currentPath);
        if (!folder) {
          folder = { kind: "folder", name: parts[i], path: currentPath, children: [] };
          folders.set(currentPath, folder);
          children.push(folder);
        }
        children = folder.children;
      }
      children.push({ kind: "file", name: parts[parts.length - 1] || file.path, change: file });
    }
    return { nodes: root };
  }

  /** 모든 변경 파일이 공유하는 디렉터리 세그먼트를 찾는다. */
  function commonDirectory(files) {
    const dirs = files.map((file) => file.path.split("/").filter(Boolean).slice(0, -1));
    if (!dirs.length) {
      return [];
    }
    const prefix = [];
    for (let i = 0; i < dirs[0].length; i++) {
      const segment = dirs[0][i];
      if (dirs.every((dir) => dir[i] === segment)) {
        prefix.push(segment);
      } else {
        break;
      }
    }
    return prefix;
  }

  /** 공통 상위 경로를 제거한 표시용 상대 경로를 만든다. */
  function stripBase(filePath, base) {
    if (!base.length) {
      return filePath;
    }
    const prefix = `${base.join("/")}/`;
    return filePath.indexOf(prefix) === 0 ? filePath.slice(prefix.length) : filePath;
  }

  /** 트리 노드 배열을 재귀적으로 HTML 로 변환한다. */
  function treeNodesHtml(nodes, depth) {
    return nodes.map((node) => {
      if (node.kind === "file") {
        return fileHtml(node.change, depth, "treeitem", node.name);
      }
      const collapsed = collapsedFolders.has(node.path);
      const icon = collapsed ? "codicon-folder" : "codicon-folder-opened";
      const chevron = collapsed ? "codicon-chevron-right" : "codicon-chevron-down";
      return (
        `<li class="file-folder" role="treeitem" aria-expanded="${collapsed ? "false" : "true"}">` +
        `<div class="folder-row" tabindex="0" data-folder="${esc(node.path)}" ` +
        `style="--indent:${indent(depth)}px" title="${esc(node.path || node.name)}">` +
        `<span class="twistie codicon ${chevron}" aria-hidden="true"></span>` +
        `<span class="codicon ${icon}" aria-hidden="true"></span>` +
        `<span class="path">${esc(node.name)}</span></div>` +
        `<ul class="folder-children${collapsed ? " collapsed" : ""}" role="group">${treeNodesHtml(node.children, depth + 1)}</ul>` +
        `</li>`
      );
    }).join("");
  }

  /** 변경 파일 한 줄 HTML 을 만든다. */
  function fileHtml(file, depth, role, label) {
    const title = displayPath(file);
    return (
      `<li class="file" role="${role}" data-path="${esc(file.path)}" ` +
      `style="--indent:${indent(depth)}px" title="${esc(title)}">` +
      `<span class="status">${esc(file.status)}</span>` +
      `<span class="path">${esc(label || title)}</span>` +
      `<span class="stat"><span class="add">+${file.additions}</span> ` +
      `<span class="del">-${file.deletions}</span></span></li>`
    );
  }

  /** 이름변경을 고려한 전체 파일 표시 경로를 만든다. */
  function displayPath(file) {
    return file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  }

  /** 트리 깊이를 파일 행 padding-left 값으로 변환한다. */
  function indent(depth) {
    return 8 + depth * 16;
  }

  /** 상세 패널 내부 버튼과 파일 클릭 이벤트를 연결한다. */
  function bindEvents(detail) {
    const root = lastHost.root;
    const parent = detail.parents && detail.parents[0] ? detail.parents[0] : "";
    root.querySelectorAll(".file").forEach((el) => {
      el.addEventListener("click", () =>
        window.GscGraphPostMessage?.({
          type: "openFileDiff",
          hash: detail.hash,
          parent,
          path: el.dataset.path,
        })
      );
    });
    root.querySelectorAll(".file-view-button").forEach((button) => {
      button.addEventListener("click", () => {
        fileViewMode = button.dataset.fileView === "list" ? "list" : "tree";
        draw();
      });
    });
    root.querySelectorAll(".folder-row").forEach((row) => {
      row.addEventListener("click", () => toggleFolder(row));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleFolder(row);
        }
      });
    });
    window.GscGraphFeatures?.bindCommitActions(root, detail);
  }

  /** Explorer 처럼 폴더 행을 접거나 펼친다. */
  function toggleFolder(row) {
    const key = row.dataset.folder || "";
    if (!key) {
      return;
    }
    if (collapsedFolders.has(key)) {
      collapsedFolders.delete(key);
    } else {
      collapsedFolders.add(key);
    }
    draw();
  }

  window.GscGraphDetail = { render };
})();
