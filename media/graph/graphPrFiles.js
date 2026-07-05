// Pull Request changed files tree renderer.
// - PR 상세 drawer 의 파일 트리 HTML 과 폴더 접기 상태를 graphPr.js 에서 분리한다.
(function () {
  "use strict";

  let collapsedFolders = new Set();
  // 트리/리스트 보기 모드. PR 을 바꿔도 유지되도록 reset() 에서는 건드리지 않는다.
  let mode = "tree";

  /** PR 이 바뀔 때 이전 파일 트리 접기 상태를 초기화한다(보기 모드는 유지). */
  function reset() {
    collapsedFolders = new Set();
  }

  /** 변경 파일 보기 모드를 설정한다(tree | list). */
  function setMode(next) {
    mode = next === "list" ? "list" : "tree";
  }

  /** 현재 보기 모드를 반환한다(토글 버튼 active 표시에 사용). */
  function getMode() {
    return mode;
  }

  /** 폴더 path 를 기준으로 접기/펼치기 상태를 전환한다. */
  function toggle(folder) {
    if (!folder) {
      return;
    }
    if (collapsedFolders.has(folder)) {
      collapsedFolders.delete(folder);
    } else {
      collapsedFolders.add(folder);
    }
  }

  /** changed files 를 현재 보기 모드(tree/list)에 맞춰 HTML 로 렌더링한다. */
  function render(files) {
    if (!files || !files.length) {
      return `<p class="pr-empty">No changed files.</p>`;
    }
    if (mode === "list") {
      // 리스트 모드: 폴더 그룹 없이 전체 경로(이름변경은 old -> new)를 한 줄씩 보여준다.
      return `<ul class="pr-file-tree list" role="tree">` +
        files.map((file) => fileHtml(file, 0, displayPath(file))).join("") +
        `</ul>`;
    }
    const tree = buildTree(files);
    return `<ul class="pr-file-tree" role="tree">${treeNodesHtml(tree.nodes, 0)}</ul>`;
  }

  /** 파일 경로 배열을 공통 상위 경로부터 시작하는 폴더/파일 트리로 변환한다. */
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
        return fileHtml(node.change, depth, node.name);
      }
      const collapsed = collapsedFolders.has(node.path);
      const icon = collapsed ? "codicon-folder" : "codicon-folder-opened";
      const chevron = collapsed ? "codicon-chevron-right" : "codicon-chevron-down";
      const title = `Toggle folder ${node.path || node.name}`;
      return (
        `<li class="pr-file-folder" role="treeitem" aria-expanded="${collapsed ? "false" : "true"}">` +
        `<button type="button" class="pr-folder-row" data-pr-file-folder="${esc(node.path)}" ` +
        `style="--indent:${indent(depth)}px" ${tooltipAttrs(title)}>` +
        `<span class="twistie codicon ${chevron}" aria-hidden="true"></span>` +
        `<span class="codicon ${icon}" aria-hidden="true"></span>` +
        `<span class="path">${esc(node.name)}</span></button>` +
        `<ul class="pr-folder-children${collapsed ? " collapsed" : ""}" role="group">${treeNodesHtml(node.children, depth + 1)}</ul>` +
        `</li>`
      );
    }).join("");
  }

  /** changed file 한 줄 HTML 을 만든다(클릭/Enter 로 base↔head diff 를 연다). */
  function fileHtml(file, depth, label) {
    const title = `Open diff: ${displayPath(file)}`;
    return (
      `<li class="pr-file-row" role="treeitem" tabindex="0" data-pr-file-diff="1" ` +
      `data-path="${esc(file.path)}" data-status="${esc(file.status)}"` +
      (file.oldPath ? ` data-old-path="${esc(file.oldPath)}"` : "") +
      ` style="--indent:${indent(depth)}px" title="${esc(title)}">` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(file.status)}" aria-hidden="true"></span>` +
      `<span class="extension-icon codicon codicon-file" aria-hidden="true"></span>` +
      `<span class="name">${esc(label || file.path)}</span>` +
      commentBubble(file.commentCount || 0) +
      statHtml(file) +
      `</li>`
    );
  }

  /** 파일별 review comment 총합을 말풍선 배지로 만든다. */
  function commentBubble(count) {
    if (!count) {
      return "";
    }
    const title = `${count} file comments`;
    return `<span class="pr-file-comment-bubble" ${tooltipAttrs(title)}>` +
      `<span class="codicon codicon-comment-discussion" aria-hidden="true"></span>${count}</span>`;
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
    return `<span class="stat"><span class="add">+${file.additions || 0}</span> ` +
      `<span class="del">-${file.deletions || 0}</span></span>`;
  }

  /** 이름변경을 고려한 전체 파일 표시 경로를 만든다. */
  function displayPath(file) {
    return file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  }

  /** 트리 깊이를 파일 행 padding-left 값으로 변환한다. */
  function indent(depth) {
    return 8 + depth * 16;
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  /** tooltip/title/aria-label 속성을 함께 만든다. */
  function tooltipAttrs(title) {
    const value = esc(title);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  window.GscGraphPrFiles = { render, reset, toggle, setMode, getMode };
})();
