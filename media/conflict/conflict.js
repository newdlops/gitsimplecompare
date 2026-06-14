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
      `<button id="${id}" class="action${cls}" type="button" title="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span>` +
      `<span>${esc(label)}</span></button>`
    );
  }

  /** 패널 헤더의 사이드 설명을 만든다. */
  function sideMeta(side) {
    const hash = shortHash(side.commit);
    return `${side.ref || ""}${hash ? ` · ${hash}` : ""}`;
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
      button("open-native", "git-merge", "Native Merge", "Open VS Code Merge Editor", "") +
      `</div></header>` +
      `<main id="panes">` +
      pane("current", "Current", sideMeta(documentData.current), documentData.current.content) +
      pane("incoming", "Incoming", sideMeta(documentData.incoming), documentData.incoming.content) +
      pane("result", "Result", "working tree", documentData.result) +
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
      vscode.postMessage({ type: "resolveMarked", content: values().result });
      setStatus("Resolving...");
    });
    document.getElementById("open-native")?.addEventListener("click", () => {
      vscode.postMessage({ type: "openMergeEditor" });
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
