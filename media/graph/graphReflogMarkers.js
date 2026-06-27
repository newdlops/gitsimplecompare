// 그래프 reflog 가상 브랜치 렌더러.
// - 실제 commit circle 을 덮지 않고, 그래프 오른쪽 빈 lane 에 reflog 전용 시간순 branch 를 그린다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach((key) => el.setAttribute(key, attrs[key]));
    return el;
  }

  /** reflog hash 의 앞뒤 공백을 제거한다. */
  function cleanHash(hash) {
    return String(hash || "").trim();
  }

  /**
   * 로드된 reflog 항목들을 실제 commit node 와 겹치지 않는 별도 가상 branch 로 그린다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param markers      현재 그래프 row 에 연결된 reflog 표시 후보
   */
  function renderVirtualBranch(graphContent, markers) {
    const svg = graphContent?.querySelector("svg");
    const visible = (markers || []).map(resolveMarker).filter(Boolean).sort((a, b) => a.index - b.index);
    if (!svg || visible.length === 0) {
      return;
    }
    const x = virtualLaneX(svg);
    const group = svgEl("g", {
      class: "reflog-virtual-branch",
      "aria-label": "Reflog virtual branch",
    });
    group.appendChild(branchLine(x, visible));
    group.appendChild(branchLabel(x, visible));
    visible.forEach((marker) => appendVirtualNode(group, x, marker));
    svg.appendChild(group);
  }

  /**
   * DOM row/node 에서 SVG 좌표를 계산한다.
   * @param marker graphReflog.js 에서 만든 reflog marker 후보
   */
  function resolveMarker(marker) {
    const y = nodeY(marker.node) ?? rowY(marker.row);
    if (!marker?.hash || y == null) {
      return undefined;
    }
    return { ...marker, y };
  }

  /**
   * 기존 그래프 lane 오른쪽의 빈 lane x 좌표를 계산한다.
   * @param svg 실제 git graph 를 담은 SVG
   */
  function virtualLaneX(svg) {
    const nodeXs = Array.from(svg.querySelectorAll(".node"))
      .map((node) => Number(node.getAttribute("cx")))
      .filter((value) => !Number.isNaN(value));
    const maxNodeX = nodeXs.length ? Math.max(...nodeXs) : 16;
    const width = Number(svg.getAttribute("width")) || maxNodeX + 36;
    return Math.min(maxNodeX + 20, Math.max(maxNodeX + 12, width - 14));
  }

  /** 실제 commit node 의 y 좌표를 읽는다. */
  function nodeY(node) {
    if (!node) {
      return undefined;
    }
    const y = Number(node.getAttribute("cy"));
    return Number.isNaN(y) ? undefined : y;
  }

  /** SVG node 가 없을 때 row 위치로 y 좌표를 보정한다. */
  function rowY(row) {
    if (!row) {
      return undefined;
    }
    return row.offsetTop + row.offsetHeight / 2;
  }

  /** reflog 가상 branch 의 시간순 연결선을 만든다. */
  function branchLine(x, markers) {
    const points = markers.map((marker) => `${x} ${marker.y}`);
    return svgEl("path", {
      class: "reflog-virtual-branch-line",
      d: `M ${points.join(" L ")}`,
      fill: "none",
    });
  }

  /** 가상 branch 상단 라벨을 만든다. */
  function branchLabel(x, markers) {
    const topY = Math.max(12, Math.min(...markers.map((marker) => marker.y)) - 10);
    const text = svgEl("text", {
      class: "reflog-virtual-branch-label",
      x: String(x - 8),
      y: String(topY),
      "text-anchor": "end",
    });
    text.textContent = "reflog";
    return text;
  }

  /** 가상 branch 위의 reflog 노드와 짧은 순번 라벨을 추가한다. */
  function appendVirtualNode(group, x, marker) {
    const nodeGroup = svgEl("g", {
      class: `reflog-virtual-node reflog-virtual-node-${marker.flow}`,
      "data-hash": cleanHash(marker.hash),
    });
    nodeGroup.appendChild(virtualShape(x, marker.y, marker.flow));
    nodeGroup.appendChild(nodeLabel(x, marker));
    const title = svgEl("title", {});
    title.textContent = marker.title || "Reflog entry";
    nodeGroup.appendChild(title);
    group.appendChild(nodeGroup);
  }

  /** 상태별로 서로 다른 reflog 가상 노드 형상을 만든다. */
  function virtualShape(x, y, flow) {
    if (flow === "timeline") {
      return svgEl("rect", {
        class: "reflog-node-shape reflog-virtual-node-shape reflog-node-shape-timeline",
        x: String(x - 5),
        y: String(y - 5),
        width: "10",
        height: "10",
        rx: "1.5",
      });
    }
    return svgEl("polygon", {
      class: `reflog-node-shape reflog-virtual-node-shape reflog-node-shape-${flow === "dropped" ? "dropped" : "flow"}`,
      points: `${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}`,
    });
  }

  /** 가상 노드 왼쪽에 R 번호를 작게 붙인다. */
  function nodeLabel(x, marker) {
    const text = svgEl("text", {
      class: "reflog-virtual-node-label",
      x: String(x - 10),
      y: String(marker.y + 4),
      "text-anchor": "end",
    });
    text.textContent = `R${marker.index + 1}`;
    return text;
  }

  window.GscGraphReflogMarkers = { renderVirtualBranch };
})();
