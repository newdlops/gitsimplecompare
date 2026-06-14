// Conflict editor webview script.
// - Keeps Current, Incoming, and Result panes editable and sends explicit resolve actions to the extension.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let currentDocument = null;

  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 커밋 해시를 짧게 표시한다. */
  function shortHash(hash) {
    return hash ? String(hash).slice(0, 12) : "";
  }

  /** 버튼 HTML 을 만든다. */
  function button(id, icon, label, title, variant) {
    const cls = variant ? ` ${variant}` : "";
    return (
      `<button id="${id}" class="action${cls}" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span>` +
      `<span>${esc(label)}</span></button>`
    );
  }

  /** 패널 헤더의 사이드 설명을 만든다. */
  function sideMeta(side) {
    const hash = shortHash(side.commit);
    return `${side.ref || ""}${hash ? ` · ${hash}` : ""}`;
  }

  /** 줄바꿈을 보존한 line 배열을 만든다. */
  function linesOf(text) {
    return String(text || "").match(/[^\n]*\n|[^\n]+/g) || [];
  }

  /** Result 안의 conflict marker 블록을 current/incoming chunk 로 나눈다. */
  function conflictChunks(text) {
    const lines = linesOf(text);
    const chunks = [];
    let start = -1;
    let mode = "normal";
    let current = [];
    let incoming = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("<<<<<<<")) {
        start = i;
        mode = "current";
        current = [];
        incoming = [];
        continue;
      }
      if (mode === "current" && line.startsWith("|||||||")) {
        mode = "base";
        continue;
      }
      if ((mode === "current" || mode === "base") && line.startsWith("=======")) {
        mode = "incoming";
        continue;
      }
      if (mode === "incoming" && line.startsWith(">>>>>>>")) {
        chunks.push({
          start,
          end: i + 1,
          current: current.join(""),
          incoming: incoming.join(""),
        });
        mode = "normal";
        continue;
      }
      if (mode === "current") {
        current.push(line);
      } else if (mode === "incoming") {
        incoming.push(line);
      }
    }
    return chunks;
  }

  /** chunk 버튼에 표시할 짧은 미리보기 문자열을 만든다. */
  function chunkPreview(chunk) {
    const text = (chunk.current || chunk.incoming || "").trim().split(/\r?\n/)[0] || "empty block";
    return text.length > 54 ? `${text.slice(0, 54)}...` : text;
  }

  /** conflict chunk 선택/적용 버튼 바를 만든다. */
  function chunkBar(documentData) {
    const chunks = conflictChunks(documentData.result);
    if (!chunks.length) {
      return `<div id="chunk-bar" class="empty-chunks">No conflict blocks in Result</div>`;
    }
    return `<div id="chunk-bar">` + chunks.map((chunk, index) =>
      `<div class="chunk-item">` +
      `<span class="chunk-label">Block ${index + 1}</span>` +
      `<button class="chunk-apply current-action" type="button" data-chunk="${index}" data-side="current" ` +
      `title="${esc(`Apply Current block ${index + 1} to Result`)}" aria-label="${esc(`Apply Current block ${index + 1} to Result`)}" ` +
      `data-tooltip="${esc(`Apply Current block ${index + 1} to Result`)}">` +
      `<span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>` +
      `<button class="chunk-apply incoming-action" type="button" data-chunk="${index}" data-side="incoming" ` +
      `title="${esc(`Apply Incoming block ${index + 1} to Result`)}" aria-label="${esc(`Apply Incoming block ${index + 1} to Result`)}" ` +
      `data-tooltip="${esc(`Apply Incoming block ${index + 1} to Result`)}">` +
      `<span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>` +
      `<button class="chunk-apply both-action" type="button" data-chunk="${index}" data-side="both" ` +
      `title="${esc(`Apply Both block ${index + 1} to Result`)}" aria-label="${esc(`Apply Both block ${index + 1} to Result`)}" ` +
      `data-tooltip="${esc(`Apply Both block ${index + 1} to Result`)}">` +
      `<span class="codicon codicon-combine" aria-hidden="true"></span></button>` +
      `<span class="chunk-preview">${esc(chunkPreview(chunk))}</span>` +
      `</div>`
    ).join("") + `</div>`;
  }

  /** 편집 pane HTML 을 만든다. */
  function pane(kind, title, meta, content) {
    return (
      `<section class="pane ${kind}">` +
      `<header><span class="pane-title">${esc(title)}</span><span class="pane-meta">${esc(meta)}</span></header>` +
      `<textarea id="${kind}-text" spellcheck="false" wrap="off" title="${esc(`${title} content`)}" ` +
      `aria-label="${esc(`${title} content`)}">${esc(content)}</textarea>` +
      `</section>`
    );
  }

  /** 충돌 문서를 렌더링한다. */
  function render(documentData) {
    currentDocument = documentData;
    app.innerHTML =
      `<header id="toolbar">` +
      `<div class="title-block"><span class="codicon codicon-git-merge"></span>` +
      `<div><h1>${esc(documentData.rel)}</h1><p>${esc(documentData.operation)}</p></div></div>` +
      `<div class="actions">` +
      button("use-current", "arrow-left", "Use Current", "Accept Current into Result and mark resolved", "current-action") +
      button("use-incoming", "arrow-right", "Use Incoming", "Accept Incoming into Result and mark resolved", "incoming-action") +
      button("use-both", "combine", "Use Both", "Accept both sides using the standard current-then-incoming policy", "") +
      button("save-result", "save", "Save Result", "Save Result without marking resolved", "") +
      button("resolve-marked", "check", "Resolve Marked", "Save Result and mark this conflict as resolved", "primary") +
      `</div></header>` +
      chunkBar(documentData) +
      `<main id="panes">` +
      pane("current", "Current", sideMeta(documentData.current), documentData.current.content) +
      pane("result", "Result", "working tree", documentData.result) +
      pane("incoming", "Incoming", sideMeta(documentData.incoming), documentData.incoming.content) +
      `</main>` +
      `<div id="status" role="status" aria-live="polite"></div>`;
    bindActions();
  }

  /** 현재 textarea 값들을 모은다. */
  function values() {
    return {
      current: document.getElementById("current-text")?.value || "",
      incoming: document.getElementById("incoming-text")?.value || "",
      result: document.getElementById("result-text")?.value || "",
    };
  }

  /** 렌더링된 버튼 이벤트를 연결한다. */
  function bindActions() {
    document.getElementById("use-current")?.addEventListener("click", () => {
      vscode.postMessage({ type: "acceptCurrent", content: values().current });
      setStatus("Applying Current...");
    });
    document.getElementById("use-incoming")?.addEventListener("click", () => {
      vscode.postMessage({ type: "acceptIncoming", content: values().incoming });
      setStatus("Applying Incoming...");
    });
    document.getElementById("use-both")?.addEventListener("click", () => {
      const result = document.getElementById("result-text");
      if (result && currentDocument) {
        result.value = currentDocument.both || "";
      }
      vscode.postMessage({ type: "acceptBoth" });
      setStatus("Applying both sides...");
    });
    document.getElementById("save-result")?.addEventListener("click", () => {
      vscode.postMessage({ type: "saveResult", content: values().result });
      setStatus("Saving Result...");
    });
    document.getElementById("resolve-marked")?.addEventListener("click", () => {
      if (conflictChunks(values().result).length) {
        setStatus("Apply or edit all conflict blocks before Resolve Marked");
        return;
      }
      vscode.postMessage({ type: "resolveMarked", content: values().result });
      setStatus("Resolving...");
    });
    document.querySelectorAll("[data-chunk][data-side]").forEach((button) => {
      button.addEventListener("click", () =>
        applyChunk(Number(button.dataset.chunk), button.dataset.side)
      );
    });
  }

  /** 선택한 conflict block 의 한쪽 내용을 Result 에 반영한다. */
  function applyChunk(index, side) {
    const result = document.getElementById("result-text");
    if (!result) {
      return;
    }
    const lines = linesOf(result.value);
    const chunks = conflictChunks(result.value);
    const chunk = chunks[index];
    if (!chunk) {
      setStatus("Conflict block was already resolved");
      return;
    }
    const replacement =
      side === "incoming" ? chunk.incoming :
      side === "both" ? joinBoth(chunk.current, chunk.incoming) :
      chunk.current;
    result.value =
      lines.slice(0, chunk.start).join("") +
      replacement +
      lines.slice(chunk.end).join("");
    setStatus(`Applied ${side === "incoming" ? "Incoming" : side === "both" ? "Both" : "Current"} block ${index + 1} to Result`);
    renderChunkBarFromResult();
  }

  /** Current/Incoming chunk 를 보편적인 current-then-incoming 순서로 이어 붙인다. */
  function joinBoth(current, incoming) {
    return `${current}${current && incoming && !current.endsWith("\n") ? "\n" : ""}${incoming}`;
  }

  /** Result 변경 후 chunk 버튼 바를 현재 marker 상태에 맞게 다시 그린다. */
  function renderChunkBarFromResult() {
    const result = document.getElementById("result-text");
    const bar = document.getElementById("chunk-bar");
    if (!result || !bar || !currentDocument) {
      return;
    }
    const next = { ...currentDocument, result: result.value };
    const wrapper = document.createElement("div");
    wrapper.innerHTML = chunkBar(next);
    bar.replaceWith(wrapper.firstElementChild);
    bindChunkActionsOnly();
  }

  /** chunk 버튼만 다시 연결한다. */
  function bindChunkActionsOnly() {
    document.querySelectorAll("[data-chunk][data-side]").forEach((button) => {
      button.addEventListener("click", () =>
        applyChunk(Number(button.dataset.chunk), button.dataset.side)
      );
    });
  }

  /** 상태 문구를 표시한다. */
  function setStatus(text) {
    const status = document.getElementById("status");
    if (status) {
      status.textContent = text;
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "document") {
      render(msg.document);
      setStatus("Loaded");
    } else if (msg.type === "error") {
      setStatus(msg.message || "Action failed");
    }
  });

  vscode.postMessage({ type: "ready" });
})();
