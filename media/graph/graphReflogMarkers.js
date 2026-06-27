// 그래프 reflog 가상 브랜치 렌더러.
// - reflog 항목을 실제 row 슬롯으로 끼워 넣고, 기존 commit row/SVG 좌표를 아래로 밀어 흐름 사이에 표시한다.
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

  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 로드된 reflog 항목들을 실제 commit row 사이의 가상 row 슬롯으로 그린다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param markers      HEAD reflog 시간순으로 표시할 reflog 후보
   */
  function renderVirtualBranch(graphContent, markers) {
    clearVirtualLayout(graphContent);
    const svg = graphContent?.querySelector("svg");
    const rowHeight = readRowHeight(graphContent);
    const slots = layoutSlots(markers || [], commitRows(graphContent).length, rowHeight);
    if (!svg || slots.length === 0) {
      return;
    }
    applyInsertedRows(graphContent, svg, slots, rowHeight);
    const visible = slots.map((slot) => slot.marker);
    const x = virtualLaneX(svg);
    const group = svgEl("g", {
      class: "reflog-virtual-branch",
      "aria-label": "Reflog virtual branch",
    });
    group.appendChild(branchLine(x, visible));
    group.appendChild(branchLabel(x, visible));
    visible.forEach((marker) => appendVirtualNode(group, x, marker));
    svg.appendChild(group);
    visible.forEach((marker) => appendVirtualRow(graphContent, x, rowHeight, marker));
    ensureGraphWidth(graphContent, x);
  }

  /**
   * reflog 항목을 실제 그래프 row 사이에 끼울 삽입 슬롯으로 변환한다.
   * @param markers   graphReflog.js 에서 만든 reflog marker 후보
   * @param rowCount  현재 렌더된 실제 commit row 수
   * @param rowHeight 현재 graph row 높이
   */
  function layoutSlots(markers, rowCount, rowHeight) {
    let insertedBefore = 0;
    return markers
      .map((marker) => markerSlot(marker, rowCount, rowHeight))
      .filter(Boolean)
      .sort((a, b) => a.insertAt - b.insertAt || a.marker.index - b.marker.index)
      .map((slot) => {
        const insertedIndex = slot.insertAt + insertedBefore++;
        return {
          ...slot,
          marker: {
            ...slot.marker,
            y: insertedIndex * rowHeight + rowHeight / 2,
          },
        };
      });
  }

  /**
   * 한 reflog marker 를 어느 commit row 앞에 끼울지 계산한다.
   * @param marker   reflog 이벤트 marker
   * @param rowCount 현재 렌더된 실제 commit row 수
   * @param rowHeight 현재 graph row 높이
   */
  function markerSlot(marker, rowCount, rowHeight) {
    if (!marker?.hash) {
      return undefined;
    }
    const fromIndex = rowIndex(marker.fromRow, rowHeight);
    const toIndex = rowIndex(marker.toRow, rowHeight);
    let insertAt = rowCount;
    if (fromIndex != null && toIndex != null && fromIndex !== toIndex) {
      insertAt = Math.min(fromIndex, toIndex) + 1;
    } else if (toIndex != null) {
      insertAt = toIndex + 1;
    } else if (fromIndex != null) {
      insertAt = fromIndex + 1;
    }
    return { marker, insertAt: Math.min(Math.max(0, insertAt), rowCount) };
  }

  /**
   * 렌더된 row 높이를 읽고, 없으면 graph.js 의 기본 행 높이와 같은 값을 쓴다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   */
  function readRowHeight(graphContent) {
    return graphContent?.querySelector(".row:not([data-reflog-virtual])")?.offsetHeight || 30;
  }

  /** 현재 graph 의 실제 commit row 목록을 반환한다. */
  function commitRows(graphContent) {
    return Array.from(graphContent?.querySelectorAll(".row:not([data-reflog-virtual])") || []);
  }

  /** commit row DOM 에서 원래 row index 를 계산한다. */
  function rowIndex(row, rowHeight) {
    if (!row) {
      return undefined;
    }
    return Math.max(0, Math.round(baseTop(row) / rowHeight));
  }

  /** commit row 의 원래 top 좌표를 읽고 저장한다. */
  function baseTop(row) {
    row.dataset.reflogBaseTop = row.dataset.reflogBaseTop || row.style.top || `${row.offsetTop}px`;
    return parseFloat(row.dataset.reflogBaseTop) || 0;
  }

  /**
   * 삽입 슬롯만큼 기존 commit row 와 SVG 그래프를 아래로 밀어 실제 빈 row 를 만든다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param svg          실제 git graph 를 담은 SVG
   * @param slots        reflog row 를 끼울 슬롯 목록
   * @param rowHeight    graph row 높이
   */
  function applyInsertedRows(graphContent, svg, slots, rowHeight) {
    const offsetForY = insertedOffset(slots, rowHeight);
    commitRows(graphContent).forEach((row) => {
      const top = baseTop(row);
      row.style.top = formatNumber(top + offsetForY(top)) + "px";
    });
    shiftSvg(svg, offsetForY, slots.length * rowHeight);
    shiftGraphContentHeight(graphContent, slots.length * rowHeight);
  }

  /**
   * y 좌표보다 위에 끼워진 reflog row 수만큼 추가 offset 을 계산하는 함수를 만든다.
   * @param slots     reflog 삽입 슬롯 목록
   * @param rowHeight graph row 높이
   */
  function insertedOffset(slots, rowHeight) {
    const thresholds = slots.map((slot) => slot.insertAt * rowHeight).sort((a, b) => a - b);
    return (y) => thresholds.filter((threshold) => y >= threshold).length * rowHeight;
  }

  /**
   * SVG 안의 기존 node/edge y 좌표를 삽입 row 만큼 이동한다.
   * @param svg        실제 git graph SVG
   * @param offsetForY y 좌표별 추가 offset 함수
   * @param extra      SVG 높이에 더할 총 높이
   */
  function shiftSvg(svg, offsetForY, extra) {
    if (!svg) {
      return;
    }
    const baseHeight = storeBaseAttr(svg, "height", "reflogBaseHeight");
    svg.setAttribute("height", formatNumber((parseFloat(baseHeight) || 0) + extra));
    svg.querySelectorAll("*").forEach((element) => {
      shiftNumberAttr(element, "cy", "reflogBaseCy", offsetForY);
      shiftNumberAttr(element, "y", "reflogBaseY", offsetForY);
      shiftNumberAttr(element, "data-compact-jump-y", "reflogBaseJumpY", offsetForY);
      shiftPointsAttr(element, offsetForY);
      shiftPathAttr(element, offsetForY);
    });
  }

  /**
   * graph-content 높이를 삽입 row 만큼 늘려 아래쪽 row 가 잘리지 않게 한다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param extra        추가할 총 높이
   */
  function shiftGraphContentHeight(graphContent, extra) {
    if (!graphContent) {
      return;
    }
    graphContent.dataset.reflogBaseHeight = graphContent.dataset.reflogBaseHeight || graphContent.style.height || "";
    const base = parseFloat(graphContent.dataset.reflogBaseHeight) || graphContent.clientHeight || 0;
    graphContent.style.height = formatNumber(base + extra) + "px";
  }

  /**
   * 숫자형 SVG 속성을 원본 기준으로 y offset 만큼 이동한다.
   * @param element    SVG 요소
   * @param attr       이동할 속성 이름
   * @param key        원본 값을 보관할 dataset key
   * @param offsetForY y 좌표별 추가 offset 함수
   */
  function shiftNumberAttr(element, attr, key, offsetForY) {
    if (!element.hasAttribute(attr)) {
      return;
    }
    const base = parseFloat(storeBaseAttr(element, attr, key));
    if (!Number.isFinite(base)) {
      return;
    }
    element.setAttribute(attr, formatNumber(base + offsetForY(base)));
  }

  /**
   * polygon/polyline points 속성의 y 좌표만 이동한다.
   * @param element    SVG 요소
   * @param offsetForY y 좌표별 추가 offset 함수
   */
  function shiftPointsAttr(element, offsetForY) {
    if (!element.hasAttribute("points")) {
      return;
    }
    const base = storeBaseAttr(element, "points", "reflogBasePoints");
    const nums = base.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    if (!nums || nums.length < 2) {
      return;
    }
    const shifted = nums.map((token, index) => {
      const value = Number(token);
      return index % 2 === 1 ? formatNumber(value + offsetForY(value)) : formatNumber(value);
    });
    element.setAttribute("points", pairTokens(shifted));
  }

  /**
   * path d 속성의 absolute y 좌표만 이동한다.
   * @param element    SVG path 요소
   * @param offsetForY y 좌표별 추가 offset 함수
   */
  function shiftPathAttr(element, offsetForY) {
    if (!element.hasAttribute("d")) {
      return;
    }
    const base = storeBaseAttr(element, "d", "reflogBaseD");
    element.setAttribute("d", shiftPathD(base, offsetForY));
  }

  /**
   * SVG path 문자열에서 M/L/C 계열 명령의 y 좌표만 이동한다.
   * @param d          원본 path d 문자열
   * @param offsetForY y 좌표별 추가 offset 함수
   */
  function shiftPathD(d, offsetForY) {
    let command = "";
    let coordIndex = 0;
    return (d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map((token) => {
      if (/^[A-Za-z]$/.test(token)) {
        command = token.toUpperCase();
        coordIndex = 0;
        return token;
      }
      const value = Number(token);
      const shifted = isPathY(command, coordIndex) ? value + offsetForY(value) : value;
      coordIndex += 1;
      return formatNumber(shifted);
    }).join(" ");
  }

  /**
   * path 명령별 숫자 인덱스가 y 좌표인지 판별한다.
   * @param command    현재 SVG path 명령
   * @param coordIndex 명령 안에서의 숫자 위치
   */
  function isPathY(command, coordIndex) {
    if (command === "M" || command === "L" || command === "T") {
      return coordIndex % 2 === 1;
    }
    if (command === "C") {
      return coordIndex % 6 === 1 || coordIndex % 6 === 3 || coordIndex % 6 === 5;
    }
    if (command === "S" || command === "Q") {
      return coordIndex % 4 === 1 || coordIndex % 4 === 3;
    }
    if (command === "A") {
      return coordIndex % 7 === 6;
    }
    return command === "V";
  }

  /**
   * 수정 전 SVG 속성값을 dataset 에 저장하고 이후에는 저장된 원본을 반환한다.
   * @param element SVG 요소
   * @param attr    원본을 보관할 속성 이름
   * @param key     dataset key
   */
  function storeBaseAttr(element, attr, key) {
    element.dataset[key] = element.dataset[key] ?? (element.getAttribute(attr) || "");
    return element.dataset[key];
  }

  /**
   * reflog 삽입 row 로 변경했던 DOM/SVG 좌표를 원래 graph 렌더링 상태로 되돌린다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   */
  function clearVirtualLayout(graphContent) {
    if (!graphContent) {
      return;
    }
    const svg = graphContent.querySelector("svg");
    const shouldRestoreHeight = Boolean(
      graphContent.querySelector("[data-reflog-base-top]") || svg?.dataset.reflogBaseHeight
    );
    graphContent.querySelectorAll(".reflog-virtual-branch,.reflog-virtual-row").forEach((node) => node.remove());
    restoreRows(graphContent);
    restoreGraphContentHeight(graphContent, shouldRestoreHeight);
    restoreSvg(svg);
  }

  /** 기존 commit row 의 top 좌표를 원래 값으로 되돌린다. */
  function restoreRows(graphContent) {
    commitRows(graphContent).forEach((row) => {
      if (row.dataset.reflogBaseTop == null) {
        return;
      }
      row.style.top = row.dataset.reflogBaseTop;
      delete row.dataset.reflogBaseTop;
    });
  }

  /** graph-content 높이를 reflog 삽입 전 값으로 되돌린다. */
  function restoreGraphContentHeight(graphContent, shouldRestore) {
    if (graphContent.dataset.reflogBaseHeight == null) {
      return;
    }
    if (shouldRestore) {
      graphContent.style.height = graphContent.dataset.reflogBaseHeight;
    }
    delete graphContent.dataset.reflogBaseHeight;
  }

  /** SVG 와 내부 요소의 변경된 좌표 속성을 원래 값으로 되돌린다. */
  function restoreSvg(svg) {
    if (!svg) {
      return;
    }
    restoreAttr(svg, "height", "reflogBaseHeight");
    svg.querySelectorAll("*").forEach((element) => {
      restoreAttr(element, "cy", "reflogBaseCy");
      restoreAttr(element, "y", "reflogBaseY");
      restoreAttr(element, "data-compact-jump-y", "reflogBaseJumpY");
      restoreAttr(element, "points", "reflogBasePoints");
      restoreAttr(element, "d", "reflogBaseD");
    });
  }

  /**
   * dataset 에 저장한 속성 원본을 복원한다.
   * @param element SVG 요소
   * @param attr    복원할 속성 이름
   * @param key     dataset key
   */
  function restoreAttr(element, attr, key) {
    if (element.dataset[key] == null) {
      return;
    }
    element.setAttribute(attr, element.dataset[key]);
    delete element.dataset[key];
  }

  /** points 속성 숫자 목록을 `x,y x,y` 형태로 재조립한다. */
  function pairTokens(tokens) {
    const pairs = [];
    for (let index = 0; index < tokens.length; index += 2) {
      pairs.push(`${tokens[index]},${tokens[index + 1]}`);
    }
    return pairs.join(" ");
  }

  /** SVG 좌표가 과도하게 길어지지 않도록 소수 둘째 자리로 정리한다. */
  function formatNumber(value) {
    return String(Math.round(value * 100) / 100);
  }

  /**
   * reflog 가상 row 가 오른쪽에서 잘리지 않도록 스크롤 폭을 늘린다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param x            reflog 가상 lane x 좌표
   */
  function ensureGraphWidth(graphContent, x) {
    const currentWidth = parseFloat(graphContent?.style?.width || "0") || graphContent?.clientWidth || 0;
    const needed = x + 620;
    if (graphContent && needed > currentWidth) {
      graphContent.style.width = Math.ceil(needed) + "px";
      graphContent.style.minWidth = Math.ceil(needed) + "px";
    }
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
    text.textContent = "reflog log";
    return text;
  }

  /** 가상 branch 위의 reflog 노드와 짧은 순번 라벨을 추가한다. */
  function appendVirtualNode(group, x, marker) {
    const nodeGroup = svgEl("g", {
      class: `reflog-virtual-node reflog-virtual-node-${marker.flow} reflog-virtual-node-${marker.recovery || "reachable"}`,
      "data-hash": cleanHash(marker.hash),
      "data-index": String(marker.index),
      role: "button",
      tabindex: "0",
      "aria-label": marker.title || "Open reflog entry",
    });
    nodeGroup.appendChild(virtualShape(x, marker.y, marker.flow));
    nodeGroup.appendChild(nodeLabel(x, marker));
    const title = svgEl("title", {});
    title.textContent = marker.title || "Reflog entry";
    nodeGroup.appendChild(title);
    nodeGroup.addEventListener("click", () => selectMarker(marker));
    nodeGroup.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectMarker(marker);
      }
    });
    group.appendChild(nodeGroup);
  }

  /**
   * reflog commit 을 graph 의 일반 row 처럼 읽히는 가상 row 로 추가한다.
   * @param graphContent 그래프 전체 DOM 컨테이너
   * @param x            reflog 가상 lane x 좌표
   * @param rowHeight    graph row 높이
   * @param marker       reflog commit marker
   */
  function appendVirtualRow(graphContent, x, rowHeight, marker) {
    const row = document.createElement("div");
    row.className = [
      "row",
      "reflog-virtual-row",
      `reflog-virtual-row-${marker.flow || "timeline"}`,
      `reflog-virtual-row-${marker.recovery || "reachable"}`,
    ].join(" ");
    row.style.top = Math.max(0, marker.y - rowHeight / 2) + "px";
    row.style.left = x + 16 + "px";
    row.dataset.hash = cleanHash(marker.hash);
    row.dataset.index = String(marker.index);
    row.dataset.reflogVirtual = "1";
    row.title = marker.title || "Reflog virtual commit";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", marker.title || "Open reflog virtual commit");
    row.innerHTML = rowHtml(marker);
    row.addEventListener("click", () => selectMarker(marker));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectMarker(marker);
      }
    });
    row.querySelector("[data-reflog-recover]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (marker.recovery === "recoverable") {
        window.dispatchEvent(new CustomEvent("gsc-reflog-recover", { detail: { hash: cleanHash(marker.hash) } }));
      }
    });
    graphContent.appendChild(row);
  }

  /** 가상 row 내부 HTML 을 만든다. */
  function rowHtml(marker) {
    const recoverable = marker.recovery === "recoverable";
    const recoverTitle = recoverable
      ? "Recover by creating branch here"
      : marker.recovery === "expired"
        ? "This reflog object is expired"
        : "This commit is already reachable; recovery is not needed";
    return `<span class="ref virtual reflog-log-ref" title="This row comes from git reflog">reflog log</span>` +
      `<span class="subject">${esc(marker.subject || marker.event || "HEAD reflog entry")}</span>` +
      `<span class="meta">${esc(shortHash(marker.hash))} · ${esc(marker.event || "Reflog update")}</span>` +
      `<span class="reflog-row-recovery reflog-recovery-${esc(marker.recovery || "reachable")}">${esc(marker.recoveryLabel || "On branch")}</span>` +
      `<button class="reflog-row-recover" type="button" data-reflog-recover title="${esc(recoverTitle)}" ` +
      `aria-label="${esc(recoverTitle)}" data-tooltip="${esc(recoverTitle)}" ${recoverable ? "" : "disabled"}>Recover</button>`;
  }

  /** row 에 표시할 짧은 hash 를 만든다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 10);
  }

  /** 가상 reflog 이벤트 노드 선택을 graphReflog.js 로 전달한다. */
  function selectMarker(marker) {
    window.dispatchEvent(new CustomEvent("gsc-reflog-select", {
      detail: { index: marker.index, hash: cleanHash(marker.hash) },
    }));
  }

  /** 상태별로 서로 다른 reflog 가상 노드 형상을 만든다. */
  function virtualShape(x, y, flow) {
    const kind = flow === "changed" ? "changed" : flow === "dropped" ? "dropped" : flow === "timeline" ? "timeline" : "flow";
    return svgEl("circle", {
      class: `reflog-node-shape reflog-virtual-node-shape reflog-node-shape-${kind}`,
      cx: String(x),
      cy: String(y),
      r: "7",
    });
  }

  /** 가상 노드 왼쪽에 R 번호를 작게 붙인다. */
  function nodeLabel(x, marker) {
    const text = svgEl("text", {
      class: "reflog-virtual-node-code",
      x: String(x),
      y: String(marker.y + 3.5),
      "text-anchor": "middle",
    });
    text.textContent = statusCode(marker.status);
    return text;
  }

  /** 가상 노드 안에 넣을 짧은 상태 코드를 만든다. */
  function statusCode(status) {
    if (String(status || "").startsWith("Recoverable")) {
      return "R";
    }
    if (String(status || "").startsWith("Expired")) {
      return "X";
    }
    if (String(status || "").startsWith("Changed")) {
      return "C";
    }
    if (String(status || "").startsWith("Dropped")) {
      return "D";
    }
    if (String(status || "").startsWith("Branch")) {
      return "F";
    }
    return "T";
  }

  window.GscGraphReflogMarkers = { clearVirtualLayout, renderVirtualBranch };
})();
