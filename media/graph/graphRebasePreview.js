// 그래프 interactive rebase 의 preview branch SVG 표시를 담당한다.
// - rebase 계획이 원본 그래프와 달라질 때 별도 분기처럼 보이는 선/노드를 그린다.
(function () {
  "use strict";

  /** todo 순서가 바뀐 커밋 node 를 새 위치로 옮긴다. */
  function applyNodeTransforms(graphContent, layout) {
    graphContent.querySelectorAll(".node.rebase-preview-moved-node").forEach((node) => {
      node.removeAttribute("transform");
      node.classList.remove("rebase-preview-moved-node");
    });
    layout.forEach((slot, hash) => {
      const node = nodeForHash(graphContent, hash);
      if (!node || slot.dy === 0) {
        return;
      }
      node.setAttribute("transform", `translate(0 ${slot.dy})`);
      node.classList.add("rebase-preview-moved-node");
    });
  }

  /** 원본 그래프와 달라지는 계획을 별도 branch preview 로 그린다. */
  function renderBranch(graphContent, plan, layout, visualItems, differs) {
    removeBranch(graphContent);
    if (!differs) {
      return;
    }
    const svg = graphContent.querySelector("svg");
    if (!svg) {
      return;
    }
    svg.style.overflow = "visible";
    const kept = visualItems.filter(
      (item) => item.action !== "drop" && layout.byHash.has(item.hash)
    );
    if (kept.length === 0) {
      return;
    }
    const x = previewBranchX(svg);
    const group = svgEl("g", { class: "rebase-preview-layer" });
    const points = kept.map((item) => layout.byHash.get(item.hash).y);
    const anchor = previewAnchor(graphContent, plan, layout);
    const pathParts = anchor
      ? [`M ${anchor.x} ${anchor.y}`, `L ${x} ${anchor.y}`, `L ${x} ${points[0]}`, ...points.slice(1).map((y) => `L ${x} ${y}`)]
      : points.map((y, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`);
    group.appendChild(svgEl("path", {
      class: "rebase-preview-edge",
      d: pathParts.join(" "),
    }));
    kept.forEach((item) => {
      const slot = layout.byHash.get(item.hash);
      const node = svgEl("circle", {
        class: `rebase-preview-node action-${item.action}`,
        cx: String(x),
        cy: String(slot.y),
        r: "5",
      });
      const title = svgEl("title", {});
      title.textContent = `rebase preview ${item.originalOrder + 1}: ${item.subject || item.hash}`;
      node.appendChild(title);
      group.appendChild(node);
    });
    svg.appendChild(group);
  }

  /** preview branch 가 갈라져 나오는 기준 node 좌표를 찾는다. */
  function previewAnchor(graphContent, plan, layout) {
    const anchorHash = plan?.onto || (!plan?.root ? plan?.base : "");
    if (!anchorHash) {
      return null;
    }
    const slot = layout.byHash.get(anchorHash);
    const node = nodeForHash(graphContent, anchorHash);
    if (slot && node) {
      return {
        x: Number(node.getAttribute("cx")) || 0,
        y: slot.y,
      };
    }
    if (!node) {
      return null;
    }
    return {
      x: Number(node.getAttribute("cx")) || 0,
      y: Number(node.getAttribute("cy")) || 0,
    };
  }

  /** SVG 안에 rebase preview branch 를 놓을 x 좌표를 계산한다. */
  function previewBranchX(svg) {
    const nodes = Array.from(svg.querySelectorAll(".node"));
    const maxX = nodes.reduce(
      (max, node) => Math.max(max, Number(node.getAttribute("cx")) || 0),
      0
    );
    const width = Number(svg.getAttribute("width")) || maxX + 32;
    return Math.min(Math.max(16, maxX + 24), Math.max(16, width - 8));
  }

  /** rebase preview branch SVG layer 를 제거한다. */
  function removeBranch(graphContent) {
    graphContent.querySelector(".rebase-preview-layer")?.remove();
  }

  /** rebase preview 를 위해 row/node 에 적용한 transform 을 제거한다. */
  function clearTransforms(graphContent) {
    graphContent.querySelectorAll(".row").forEach((row) => {
      row.style.transform = "";
      row.classList.remove("rebase-preview-moved");
    });
    graphContent.querySelectorAll(".node.rebase-preview-moved-node").forEach((node) => {
      node.removeAttribute("transform");
      node.classList.remove("rebase-preview-moved-node");
    });
    removeBranch(graphContent);
  }

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** 해시로 SVG node 를 찾는다. */
  function nodeForHash(graphContent, hash) {
    return Array.from(graphContent.querySelectorAll(".node")).find(
      (node) => node.dataset.hash === hash
    );
  }

  window.GscGraphRebasePreview = {
    applyNodeTransforms,
    clearTransforms,
    renderBranch,
  };
})();
