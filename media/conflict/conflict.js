// Conflict editor webview script.
// - Git stage provenance, rebase timeline, and final-file uncertainty are rendered before resolution actions.
// - Current/Incoming/Base stay read-only; only Result is editable so source identity never becomes ambiguous.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const T = window.__gscConflictI18n || {};
  let currentDocument = null;
  let currentSession = "";
  let resultDirty = false;
  /** HTML 특수문자를 이스케이프한다. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  /** `{0}` 형식 placeholder를 순서대로 바꾼다. */
  function fmt(template) {
    const args = Array.prototype.slice.call(arguments, 1);
    return String(template).replace(/\{(\d+)\}/g, function (_, index) {
      return String(args[Number(index)] == null ? "" : args[Number(index)]);
    });
  }
  /** 커밋 해시를 짧게 표시한다. */
  function shortHash(hash) {
    return hash ? String(hash).slice(0, 12) : "";
  }
  /** operation 코드에 대응하는 지역화 이름을 반환한다. */
  function operationLabel(operation) {
    if (operation === "merge") return T.operationMerge;
    if (operation === "rebase") return T.operationRebase;
    if (operation === "cherry-pick") return T.operationCherryPick;
    if (operation === "revert") return T.operationRevert;
    return T.operationNone;
  }
  /** 접근성 라벨과 즉시 tooltip을 포함한 버튼 HTML을 만든다. */
  function button(id, icon, label, title, variant, disabled) {
    const cls = variant ? ` ${variant}` : "";
    return (
      `<button id="${id}" class="action${cls}" type="button" title="${esc(title)}" ` +
      `aria-label="${esc(title)}" data-tooltip="${esc(title)}"${disabled ? " disabled" : ""}>` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span>` +
      `<span>${esc(label)}</span></button>`
    );
  }
  /** operation별 Current/Incoming/Result 의미를 한 묶음으로 만든다. */
  function operationPresentation(documentData) {
    if (documentData.operation === "rebase") {
      const incomingRef = documentData.incoming && documentData.incoming.ref;
      if (incomingRef !== "REBASE_HEAD") {
        const incomingSource = incomingRef === "MERGE_HEAD"
          ? T.mergeTargetDuringRebase
          : incomingRef === "CHERRY_PICK_HEAD"
            ? T.cherryPickTargetDuringRebase
            : String(incomingRef || "").includes("REVERT_HEAD")
              ? T.revertSideDuringRebase
              : T.nestedSourceDuringRebase;
        return {
          currentTitle: `${T.current} · ${T.accumulatedResult}`,
          incomingTitle: `${T.incoming} · ${incomingSource}`,
          currentDetail: T.rebaseCurrentDetail,
          incomingDetail: T.rebaseNestedIncomingDetail,
          resultDetail: T.rebaseNestedResultDetail,
        };
      }
      return {
        currentTitle: `${T.current} · ${T.accumulatedResult}`,
        incomingTitle: `${T.incoming} · ${T.commitBeingReplayed}`,
        currentDetail: T.rebaseCurrentDetail,
        incomingDetail: T.rebaseIncomingDetail,
        resultDetail: T.rebaseResultDetail,
      };
    }
    if (documentData.operation === "merge") {
      return {
        currentTitle: `${T.current} · ${T.currentBranchVersion}`,
        incomingTitle: `${T.incoming} · ${T.mergeTargetVersion}`,
        currentDetail: T.mergeCurrentDetail,
        incomingDetail: T.mergeIncomingDetail,
        resultDetail: T.mergeResultDetail,
      };
    }
    if (documentData.operation === "cherry-pick") {
      return {
        currentTitle: `${T.current} · ${T.currentBranchVersion}`,
        incomingTitle: `${T.incoming} · ${T.cherryPickTargetVersion}`,
        currentDetail: T.cherryCurrentDetail,
        incomingDetail: T.cherryIncomingDetail,
        resultDetail: T.cherryResultDetail,
      };
    }
    if (documentData.operation === "revert") {
      return {
        currentTitle: `${T.current} · ${T.currentBranchVersion}`,
        incomingTitle: `${T.incoming} · ${T.revertReverseVersion}`,
        currentDetail: T.revertCurrentDetail,
        incomingDetail: T.revertIncomingDetail,
        resultDetail: T.revertResultDetail,
      };
    }
    return {
      currentTitle: `${T.current} · ${T.genericCurrentVersion}`,
      incomingTitle: `${T.incoming} · ${T.genericIncomingVersion}`,
      currentDetail: T.genericCurrentDetail,
      incomingDetail: T.genericIncomingDetail,
      resultDetail: T.genericResultDetail,
    };
  }
  /** commit/ref/subject와 파일별 마지막 변경 commit을 줄바꿈 가능한 HTML로 만든다. */
  function sourceIdentity(side) {
    const hash = shortHash(side.commit);
    const primary = [side.ref, hash, side.subject].filter(Boolean).join(" · ");
    const fileHash = shortHash(side.fileCommit);
    const sameCommit = fileHash && hash && side.fileCommit === side.commit;
    const fileOrigin = fileHash && !sameCommit
      ? `<div class="file-origin">${esc(fmt(T.fileLastChangedBy, fileHash, side.fileSubject || ""))}</div>`
      : "";
    return `<div class="source-identity">${esc(primary || T.unknownCommit)}</div>${fileOrigin}`;
  }
  /** stage/Result 내용 종류를 전체 텍스트가 보이는 상태 badge로 만든다. */
  function contentState(value) {
    if (!value.exists || value.kind === "absent") {
      return `<span class="content-badge absent">${esc(T.deletedOrAbsent)}</span>`;
    }
    if (value.kind === "binary") {
      return `<span class="content-badge warning">${esc(T.binaryContent)}</span>`;
    }
    if (value.kind === "submodule") {
      const label = value.oid ? fmt(T.submoduleContent, shortHash(value.oid)) : T.submoduleWorkingTree;
      return `<span class="content-badge warning">${esc(label)}</span>`;
    }
    if (value.kind === "nonfile") {
      return `<span class="content-badge warning">${esc(T.nonFileContent)}</span>`;
    }
    if (value.kind === "symlink") {
      return `<span class="content-badge warning">${esc(fmt(T.symlinkContent, value.content || value.oid || ""))}</span>`;
    }
    if (value.truncated) {
      return `<span class="content-badge warning">${esc(T.truncatedContent)}</span>`;
    }
    if (!value.content) {
      return `<span class="content-badge">${esc(T.emptyFile)}</span>`;
    }
    return "";
  }
  /** Current/Incoming/Result 한 단계의 flow card를 만든다. */
  function flowCard(kind, title, identity, detail, state) {
    return (
      `<article class="flow-card ${kind}"><div class="flow-card-title">${esc(title)}</div>` +
      `${identity || ""}<p>${esc(detail)}</p>${state || ""}</article>`
    );
  }
  /** rebase 원본 tip/onto/current step과 남은 동일 경로 변경 목록을 만든다. */
  function rebaseFlow(documentData) {
    const rebase = documentData.context && documentData.context.rebase;
    if (!rebase) return { meta: "", future: "", impact: uncertainImpact() };
    const metaParts = [];
    if (rebase.branch) metaParts.push(`${T.branchResult}: ${rebase.branch}`);
    if (rebase.originalHead && rebase.originalHead.commit) {
      metaParts.push(
        `${T.originalTip}: ${shortHash(rebase.originalHead.commit)}${rebase.originalHead.subject ? ` · ${rebase.originalHead.subject}` : ""}`
      );
    }
    if (rebase.onto && rebase.onto.commit) {
      metaParts.push(
        `${T.ontoBase}: ${shortHash(rebase.onto.commit)}${rebase.onto.subject ? ` · ${rebase.onto.subject}` : ""}`
      );
    }
    if (rebase.currentStep) {
      metaParts.push(
        `${fmt(T.stepOf, rebase.currentStep.index, rebase.currentStep.total)}` +
        `${rebase.currentStep.action ? ` · ${rebase.currentStep.action}` : ""}`
      );
    }
    const changes = rebase.futurePathChanges || [];
    const changeItems = changes.map(function (item) {
      return `<li><span class="future-index">${esc(String(item.index))}</span>` +
        `<span class="future-action">${esc(item.action)}</span>` +
        `<code>${esc(shortHash(item.commit || item.ref))}</code>` +
        `<span>${esc(item.subject || T.unknownCommit)}</span></li>`;
    }).join("");
    const omitted = rebase.futurePathChangesOmitted
      ? `<li class="future-omitted">${esc(fmt(T.moreFutureChanges, rebase.futurePathChangesOmitted))}</li>`
      : "";
    const futureSummary = rebase.futurePathChangeCount
      ? fmt(T.futurePathChanges, rebase.futurePathChangeCount)
      : rebase.futurePathAnalysisComplete
        ? T.noFuturePathChanges
        : T.futurePathAnalysisUnavailable;
    const future = `<article class="flow-card future"><div class="flow-card-title">` +
      `${esc(fmt(T.remainingSteps, rebase.remainingSteps))}</div>` +
      `<p>${esc(futureSummary)}</p>` +
      `${changeItems || omitted ? `<ul class="future-list">${changeItems}${omitted}</ul>` : ""}</article>`;
    let impact;
    if (rebase.fileOutcome === "changed-later") {
      impact = impactHtml("warning", "warning", T.changedLaterTitle, T.changedLaterDetail);
    } else if (rebase.fileOutcome === "expected-final") {
      impact = impactHtml("success", "pass", T.expectedFinalTitle, T.expectedFinalDetail);
    } else {
      impact = uncertainImpact();
    }
    return {
      meta: metaParts.length ? `<div class="operation-meta">${metaParts.map(esc).join("<span>·</span>")}</div>` : "",
      future,
      impact,
    };
  }
  /** 최종 반영 예상의 tone/icon/title/detail을 공통 markup으로 만든다. */
  function impactHtml(tone, icon, title, detail) {
    return `<div class="final-impact ${tone}" role="note">` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
      `<div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div></div>`;
  }
  /** 최종 결과를 확정할 수 없을 때 쓸 공통 경고를 만든다. */
  function uncertainImpact() {
    return impactHtml("warning", "question", T.uncertainFinalTitle, T.uncertainFinalDetail);
  }
  /** 선택 흐름과 rebase 최종 영향 정보를 상단 context 영역으로 만든다. */
  function contextPanel(documentData) {
    const presentation = operationPresentation(documentData);
    const rebase = documentData.operation === "rebase"
      ? rebaseFlow(documentData)
      : { meta: "", future: "", impact: impactHtml("info", "info", T.resultAfterStep, presentation.resultDetail) };
    const resultIdentity = `<div class="source-identity">${esc(T.workingTree)}</div>`;
    const target = documentData.context && documentData.context.operationTarget;
    const targetMeta = documentData.operation !== "rebase" && target
      ? `<div class="operation-meta">${esc(T.operationCommit)}: <code>${esc(shortHash(target.commit || target.ref))}</code> ${esc(target.subject || "")}</div>`
      : "";
    return `<section id="resolution-context" aria-label="${esc(T.resolutionContext)}">${rebase.meta}${targetMeta}<div class="operation-flow">` +
      flowCard("current", presentation.currentTitle, sourceIdentity(documentData.current), presentation.currentDetail, contentState(documentData.current)) +
      `<span class="flow-arrow codicon codicon-arrow-right" aria-hidden="true"></span>` +
      flowCard("incoming", presentation.incomingTitle, sourceIdentity(documentData.incoming), presentation.incomingDetail, contentState(documentData.incoming)) +
      `<span class="flow-arrow codicon codicon-arrow-right" aria-hidden="true"></span>` +
      flowCard("result", T.proposedResult, resultIdentity, presentation.resultDetail, contentState({ ...documentData.resultState, content: documentData.result })) +
      `${rebase.future ? `<span class="flow-arrow codicon codicon-arrow-right" aria-hidden="true"></span>${rebase.future}` : ""}` +
      `</div>${rebase.impact}</section>`;
  }
  /** 줄바꿈을 보존한 line 배열을 만든다. */
  function linesOf(text) {
    return String(text || "").match(/[^\n]*\n|[^\n]+/g) || [];
  }
  /** Result 안의 conflict marker 블록을 current/incoming chunk로 나눈다. */
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
        start = i; mode = "current"; current = []; incoming = []; continue;
      }
      if (mode === "current" && line.startsWith("|||||||")) {
        mode = "base"; continue;
      }
      if ((mode === "current" || mode === "base") && line.startsWith("=======")) {
        mode = "incoming"; continue;
      }
      if (mode === "incoming" && line.startsWith(">>>>>>>")) {
        chunks.push({ start, end: i + 1, current: current.join(""), incoming: incoming.join("") });
        mode = "normal"; continue;
      }
      if (mode === "current") current.push(line);
      else if (mode === "incoming") incoming.push(line);
    }
    return chunks;
  }
  /** chunk 버튼에 표시할 짧은 미리보기 문자열을 만든다. */
  function chunkPreview(chunk) {
    const text = (chunk.current || chunk.incoming || "").trim().split(/\r?\n/)[0] || T.emptyBlock;
    return text.length > 54 ? `${text.slice(0, 54)}…` : text;
  }
  /** conflict chunk 선택/적용 버튼 바를 만든다. */
  function chunkBar(documentData) {
    const chunks = conflictChunks(documentData.result);
    if (!chunks.length) {
      return `<div id="chunk-bar" class="empty-chunks">${esc(T.noConflictBlocks)}</div>`;
    }
    return `<div id="chunk-bar">${chunks.map(function (chunk, index) {
      const number = index + 1;
      return `<div class="chunk-item"><span class="chunk-label">${esc(fmt(T.block, number))}</span>` +
        chunkButton(index, "current", "arrow-right", fmt(T.applyCurrentBlock, number)) +
        chunkButton(index, "incoming", "arrow-left", fmt(T.applyIncomingBlock, number)) +
        chunkButton(index, "both", "combine", fmt(T.applyBothBlock, number)) +
        `<span class="chunk-preview">${esc(chunkPreview(chunk))}</span></div>`;
    }).join("")}</div>`;
  }
  /** 한 conflict block 적용용 icon 버튼을 만든다. */
  function chunkButton(index, side, icon, title) {
    return `<button class="chunk-apply ${side}-action" type="button" data-chunk="${index}" data-side="${side}" ` +
      `title="${esc(title)}" aria-label="${esc(title)}" data-tooltip="${esc(title)}">` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  }
  /** Base stage를 필요할 때 펼쳐 볼 수 있는 읽기 전용 영역으로 만든다. */
  function basePanel(documentData) {
    const base = documentData.base;
    const detail = documentData.operation === "rebase" ? T.baseDetailRebase : T.baseDetailGeneric;
    const text = base.kind === "text" ? base.content : "";
    return `<details id="base-panel"><summary title="${esc(T.showBase)}" aria-label="${esc(T.showBase)}" data-tooltip="${esc(T.showBase)}">` +
      `<span class="codicon codicon-layers" aria-hidden="true"></span><strong>${esc(T.showBase)}</strong>` +
      `${contentState(base)}</summary><p>${esc(detail)}</p>` +
      `${base.kind === "text" ? `<textarea readonly spellcheck="false" wrap="off" title="${esc(T.baseContent)}" aria-label="${esc(T.baseContent)}">${esc(text)}</textarea>` : ""}` +
      `</details>`;
  }
  /** 코드 pane HTML을 만들고 source pane은 항상 readonly로 고정한다. */
  function pane(kind, title, side, content, editable) {
    const state = side || { exists: true, kind: "text", content };
    const canEdit = editable && state.kind === "text" && !state.truncated;
    const textarea = state.kind === "text"
      ? `<textarea id="${kind}-text" spellcheck="false" wrap="off" ${canEdit ? "" : "readonly "}` +
        `title="${esc(kind === "result" ? T.resultContent : kind === "current" ? T.currentContent : T.incomingContent)}" ` +
        `aria-label="${esc(kind === "result" ? T.resultContent : kind === "current" ? T.currentContent : T.incomingContent)}">${esc(content)}</textarea>`
      : `<div class="non-text-content">${contentState(state)}</div>`;
    return `<section class="pane ${kind}"><header><div><span class="pane-title">${esc(title)}</span>` +
      `${contentState(state)}</div>${kind === "result" ? `<span class="pane-meta">${esc(T.workingTree)}</span>` : sourceIdentity(state)}</header>` +
      `${textarea}</section>`;
  }
  /** 충돌 문서 전체를 렌더링한다. */
  function render(documentData) {
    currentDocument = documentData;
    const presentation = operationPresentation(documentData);
    const resultEditable = documentData.resultState.kind === "text" && !documentData.resultState.truncated;
    const bothAvailable = documentData.bothAvailable === true;
    app.innerHTML = `<header id="toolbar" role="toolbar" aria-label="${esc(T.resolveConflict)}"><div class="title-block">` +
      `<span class="codicon codicon-git-merge" aria-hidden="true"></span><div>` +
      `<h1 title="${esc(documentData.rel)}">${esc(documentData.rel)}</h1>` +
      `<p>${esc(operationLabel(documentData.operation))}</p></div></div><div class="actions">` +
      button("open-native", "layout", T.nativeEditor, T.nativeEditorTooltip, "", false) +
      button("use-current", "arrow-left", T.useCurrent, T.useCurrentTooltip, "current-action", false) +
      button("use-incoming", "arrow-right", T.useIncoming, T.useIncomingTooltip, "incoming-action", false) +
      button("use-both", "combine", T.useBoth, T.useBothTooltip, "", !bothAvailable) +
      button("save-result", "save", T.saveResult, T.saveResultTooltip, "", !resultEditable) +
      button("resolve-marked", "check", T.resolveMarked, T.resolveMarkedTooltip, "primary", !resultEditable) +
      `</div></header>${contextPanel(documentData)}${basePanel(documentData)}${chunkBar(documentData)}` +
      `<main id="panes">` +
      pane("current", presentation.currentTitle, documentData.current, documentData.current.content, false) +
      pane("result", T.result, { ...documentData.resultState, content: documentData.result }, documentData.result, true) +
      pane("incoming", presentation.incomingTitle, documentData.incoming, documentData.incoming.content, false) +
      `</main><div id="status" role="status" aria-live="polite"></div>`;
    ensureButtonTooltips();
    bindActions();
    bindResultDirtyTracking();
  }
  /** 현재 Result textarea 값을 반환한다. */
  function resultValue() {
    return document.getElementById("result-text")?.value || "";
  }
  /** toolbar와 chunk 버튼 이벤트를 연결한다. */
  function bindActions() {
    document.getElementById("open-native")?.addEventListener("click", function () {
      beginHostAction({ type: "openNative" }, T.openingNative);
    });
    document.getElementById("use-current")?.addEventListener("click", function () {
      beginHostAction({ type: "acceptCurrent" }, T.applyingCurrent);
    });
    document.getElementById("use-incoming")?.addEventListener("click", function () {
      beginHostAction({ type: "acceptIncoming" }, T.applyingIncoming);
    });
    document.getElementById("use-both")?.addEventListener("click", function () {
      beginHostAction({ type: "acceptBoth" }, T.applyingBoth);
    });
    document.getElementById("save-result")?.addEventListener("click", function () {
      beginHostAction({ type: "saveResult", content: resultValue() }, T.savingResult);
    });
    document.getElementById("resolve-marked")?.addEventListener("click", function () {
      if (conflictChunks(resultValue()).length) {
        setStatus(T.markersRemain);
        return;
      }
      beginHostAction({ type: "resolveMarked", content: resultValue() }, T.resolving);
    });
    bindChunkActionsOnly();
  }
  /** 화면 Result와 host의 미저장 draft를 같은 값으로 맞춘다. */
  function syncDraft(content) {
    if (currentDocument) currentDocument.result = content;
    resultDirty = true;
    vscode.postMessage({ type: "dirtyChanged", dirty: true, content, sessionId: currentSession });
  }
  /** Result 입력을 host draft와 동기화해 파일 전환 시 유실 여부를 확인할 수 있게 한다. */
  function bindResultDirtyTracking() {
    const result = document.getElementById("result-text");
    result?.addEventListener("input", function () {
      syncDraft(result.value);
    });
  }
  /** host mutation을 보내기 직전에 액션을 잠가 중복 클릭을 막는다. */
  function beginHostAction(message, status) {
    setMutationBusy(true);
    vscode.postMessage({ ...message, sessionId: currentSession });
    setStatus(status);
  }
  /** mutation 버튼의 기존 disabled 상태를 보존하면서 busy 상태를 토글한다. */
  function setMutationBusy(busy) {
    app.setAttribute("aria-busy", String(busy));
    document.querySelectorAll("#toolbar button, #chunk-bar button, #panes textarea:not([readonly])").forEach(function (element) {
      if (busy) {
        element.dataset.disabledBeforeBusy = String(element.disabled);
        element.disabled = true;
      } else if (element.dataset.disabledBeforeBusy !== undefined) {
        element.disabled = element.dataset.disabledBeforeBusy === "true";
        delete element.dataset.disabledBeforeBusy;
      }
    });
  }
  /** 선택한 conflict block의 한쪽 내용을 Result에 반영한다. */
  function applyChunk(index, side) {
    const result = document.getElementById("result-text");
    if (!result) return;
    const lines = linesOf(result.value);
    const chunk = conflictChunks(result.value)[index];
    if (!chunk) {
      setStatus(T.blockAlreadyResolved);
      return;
    }
    const replacement = side === "incoming"
      ? chunk.incoming
      : side === "both"
        ? joinBoth(chunk.current, chunk.incoming)
        : chunk.current;
    result.value = lines.slice(0, chunk.start).join("") + replacement + lines.slice(chunk.end).join("");
    syncDraft(result.value);
    setStatus(fmt(T.appliedBlock, side === "incoming" ? T.incoming : side === "both" ? T.useBoth : T.current, index + 1));
    renderChunkBarFromResult();
  }
  /** Current/Incoming chunk를 current-then-incoming 순서로 이어 붙인다. */
  function joinBoth(current, incoming) {
    return `${current}${current && incoming && !current.endsWith("\n") ? "\n" : ""}${incoming}`;
  }
  /** Result 변경 뒤 chunk bar만 최신 marker 상태로 다시 렌더링한다. */
  function renderChunkBarFromResult() {
    const result = document.getElementById("result-text");
    const bar = document.getElementById("chunk-bar");
    if (!result || !bar || !currentDocument) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = chunkBar({ ...currentDocument, result: result.value });
    bar.replaceWith(wrapper.firstElementChild);
    ensureButtonTooltips();
    bindChunkActionsOnly();
  }
  /** 렌더링된 모든 버튼에 hover tooltip과 접근성 라벨을 보장한다. */
  function ensureButtonTooltips() {
    document.querySelectorAll("button").forEach(function (element) {
      const text = element.getAttribute("title") || element.getAttribute("aria-label") || element.textContent?.trim() || "Action";
      element.setAttribute("title", text);
      element.setAttribute("aria-label", text);
      element.dataset.tooltip = text;
    });
  }
  /** chunk 적용 버튼만 다시 연결한다. */
  function bindChunkActionsOnly() {
    document.querySelectorAll("[data-chunk][data-side]").forEach(function (element) {
      element.addEventListener("click", function () {
        applyChunk(Number(element.dataset.chunk), element.dataset.side);
      });
    });
  }
  /** 해결 완료 후 source snapshot을 유지한 채 추가 해결 액션을 잠근다. */
  function showResolved(reason) {
    app.classList.add("resolved");
    document.querySelectorAll("button, textarea:not([readonly])").forEach(function (element) {
      element.disabled = true;
    });
    const message = reason === "acceptedCurrent"
      ? T.resolvedCurrent
      : reason === "acceptedIncoming"
        ? T.resolvedIncoming
        : reason === "acceptedBoth"
          ? T.resolvedBoth
          : T.resolvedManual;
    setStatus(message);
  }
  /** 하단 live status 문구를 갱신한다. */
  function setStatus(text) {
    const status = document.getElementById("status");
    if (status) status.textContent = text;
  }
  window.addEventListener("message", function (event) {
    const msg = event.data || {};
    if (msg.type === "prepareSwitch") {
      if (msg.sessionId !== currentSession) return;
      setMutationBusy(true);
      const result = document.getElementById("result-text");
      vscode.postMessage({
        type: "switchSnapshot",
        requestId: msg.requestId,
        sessionId: currentSession,
        dirty: resultDirty,
        content: result ? result.value : currentDocument?.result || "",
      });
      return;
    }
    if (msg.type !== "document" && msg.sessionId && msg.sessionId !== currentSession) return;
    if (msg.type === "document") {
      currentSession = msg.sessionId || "";
      resultDirty = Boolean(msg.draftRestored);
      setMutationBusy(false);
      render(msg.document);
      setStatus(msg.draftRestored ? T.draftRestored : T.loaded);
    } else if (msg.type === "resolved") {
      resultDirty = false;
      setMutationBusy(false);
      if (currentDocument && msg.result) {
        currentDocument = {
          ...currentDocument,
          result: msg.result.content,
          resultState: msg.result.state,
        };
        render(currentDocument);
      }
      showResolved(msg.reason);
    } else if (msg.type === "actionCancelled") {
      setMutationBusy(false);
      setStatus(T.actionCancelled);
    } else if (msg.type === "error") {
      setMutationBusy(false);
      setStatus(msg.message || T.actionFailed);
    } else if (msg.type === "warning") {
      setMutationBusy(false);
      setStatus(msg.message);
    }
  });
  vscode.postMessage({ type: "ready" });
})();
