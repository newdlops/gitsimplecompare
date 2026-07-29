// PR preview의 작성 메시지와 생성/게시 상태를 웹뷰 본문에서 분리한다.
// - 브랜치별 draft를 panel memory에만 두어 VS Code webview state에 민감한 편집 내용을 저장하지 않는다.

/**
 * PR preview script의 lexical scope에 삽입할 composer 코드를 만든다.
 * @returns draft, 상태, 작성 UI와 action handler를 소유하는 JavaScript 문자열
 */
export function pullRequestPreviewComposerScript(): string {
  return `
    // branch 조합별 draft는 refresh와 branch 왕복 동안만 유지한다.
    const messageDrafts = new Map();
    let previewUpdating = false;
    let previewError = '';
    let pendingSourceBranch = '';
    let pendingTargetBranch = '';
    let aiRequestDraftKey = '';
    let prMessageGenerationActive = false;
    let pullRequestPublishActive = false;
    generatePrMessage?.addEventListener('click', () => {
      if (!latestPreview || generatePrMessage.disabled || prMessageGenerationActive || previewUpdating || pendingSourceBranch || pendingTargetBranch) return;
      aiRequestDraftKey = draftKey(latestPreview);
      setPrMessageGenerationActive(true);
      vscode.postMessage({ type: 'generatePullRequestMessage' });
    });
    configureAiCli?.addEventListener('click', () => vscode.postMessage({ type: 'configureAiCli' }));
    copyPrMessage?.addEventListener('click', () => {
      if (!latestPreview) return;
      const message = effectiveMessage(latestPreview);
      vscode.postMessage({ type: 'copyPullRequestMessage', title: message.title, body: message.body });
    });
    publishPr?.addEventListener('click', () => {
      if (!latestPreview || publishPr.disabled || pullRequestPublishActive) return;
      setPullRequestPublishActive(true);
      const message = effectiveMessage(latestPreview);
      vscode.postMessage({ type: 'publishPullRequest', sourceBranch: pendingSourceBranch || latestPreview.sourceBranch || '', targetBranch: pendingTargetBranch || latestPreview.targetBranch || '', title: message.title, body: message.body });
    });
    /** preview 응답이 현재 선택 요청에 해당하면 baseline과 pending 상태를 함께 확정한다. */
    function acceptPreview(preview) {
      if ((pendingSourceBranch && preview.sourceBranch !== pendingSourceBranch) || (pendingTargetBranch && preview.targetBranch !== pendingTargetBranch)) return false;
      pendingSourceBranch = ''; pendingTargetBranch = ''; previewUpdating = false; previewError = '';
      return true;
    }
    /** 마지막 성공 화면을 유지한 채 새 preview를 기다리는 상태를 표시한다. */
    function beginPreviewLoading() { previewUpdating = true; if (latestPreview) render(latestPreview); }
    /** branch 변경 실패 때 pending selection을 해제하고 마지막 성공 화면에 warning을 붙인다. */
    function failPreview(message) {
      previewUpdating = false; pendingSourceBranch = ''; pendingTargetBranch = '';
      previewError = String(message || publishText.unableToUpdate);
      if (latestPreview) render(latestPreview);
      else content.innerHTML = '<section class="preview-error" role="alert"><p>' + esc(previewError) + '</p><button class="gsc-button" type="button" data-retry-preview title="' + esc(publishText.retryPreview) + '" aria-label="' + esc(publishText.retryPreview) + '" data-tooltip="' + esc(publishText.retryPreview) + '">' + esc(publishText.retryPreview) + '</button></section>';
    }
    /** 현재 preview의 repository/source/target 조합을 draft key로 만든다. */
    function draftKey(preview) { return [preview.repository || '', preview.sourceBranch || '', preview.targetBranch || ''].join('\\u0000'); }
    /** 서버 baseline과 local draft를 field 단위로 병합해 사용자의 편집을 보존한다. */
    function syncDraft(preview) {
      const key = draftKey(preview); const baseline = { title: String(preview.title || ''), body: String(preview.body || '') }; let draft = messageDrafts.get(key);
      if (!draft) { messageDrafts.set(key, { title: { value: baseline.title, baseline: baseline.title, dirty: false }, body: { value: baseline.body, baseline: baseline.body, dirty: false } }); return; }
      ['title', 'body'].forEach((field) => { const item = draft[field]; const next = baseline[field]; if (!item.dirty) item.value = next; item.baseline = next; item.dirty = item.value !== item.baseline; });
    }
    /** draft가 없을 때도 안전하게 현재 서버 message를 반환한다. */
    function effectiveMessage(preview) { const draft = messageDrafts.get(draftKey(preview)); return draft ? { title: draft.title.value, body: draft.body.value } : { title: preview.title || '', body: preview.body || '' }; }
    /** title/body 입력 UI와 title validation 상태를 렌더링한다. */
    function composerHtml(preview) {
      const message = effectiveMessage(preview); const invalid = !String(message.title || '').trim();
      return '<section class="pr-composer" aria-label="' + esc(publishText.composer) + '"><div class="gsc-field"><label for="pr-title-input">' + esc(publishText.titleLabel) + '</label><input id="pr-title-input" type="text" value="' + esc(message.title) + '" aria-invalid="' + invalid + '" aria-describedby="pr-title-error"></div><p id="pr-title-error" class="gsc-field__error"' + (invalid ? '' : ' hidden') + '>' + esc(publishText.titleRequired) + '</p><div class="gsc-field"><label for="pr-body-input">' + esc(publishText.descriptionOptional) + '</label><textarea id="pr-body-input" rows="5">' + esc(message.body) + '</textarea></div></section>';
    }
    /** 입력 변경을 현재 branch draft에 반영하고 create/copy enabled state를 갱신한다. */
    function bindComposer() {
      const title = content.querySelector('#pr-title-input'); const body = content.querySelector('#pr-body-input'); if (!latestPreview || !title || !body) return;
      const update = () => { const draft = messageDrafts.get(draftKey(latestPreview)); if (!draft) return; draft.title.value = title.value; draft.body.value = body.value; draft.title.dirty = draft.title.value !== draft.title.baseline; draft.body.dirty = draft.body.value !== draft.body.baseline; title.setAttribute('aria-invalid', String(!title.value.trim())); content.querySelector('#pr-title-error')?.toggleAttribute('hidden', !!title.value.trim()); const heading = content.querySelector('[data-preview-title]'); if (heading) heading.firstChild.textContent = title.value; const opening = content.querySelector('[data-preview-opening] .preview-conversation-item__body'); if (opening) opening.innerHTML = renderMarkdown(body.value || publishText.noDescription); syncActionButtons(latestPreview); };
      title.addEventListener('input', update); body.addEventListener('input', update);
    }
    /** toolbar action의 disabled reason과 tooltip을 현재 composer state로 동기화한다. */
    function syncActionButtons(preview) {
      const needsTarget = !preview.targetBranch; const updating = previewUpdating || !!(pendingSourceBranch || pendingTargetBranch);
      const generateTitle = prMessageGenerationActive ? publishText.generating : updating ? publishText.updating : needsTarget ? publishText.generateNeedsTarget : !preview.hasStagedChanges ? publishText.generateNeedsChanges : publishText.generate;
      if (generatePrMessage) { generatePrMessage.disabled = prMessageGenerationActive || updating || needsTarget || !preview.hasStagedChanges; generatePrMessage.title = generateTitle; generatePrMessage.setAttribute('aria-label', generateTitle); generatePrMessage.dataset.tooltip = generateTitle; generatePrMessage.classList.toggle('busy', prMessageGenerationActive); }
      if (copyPrMessage) { const message = effectiveMessage(preview); const title = message.title || message.body ? publishText.copy : publishText.copyUnavailable; copyPrMessage.disabled = !(message.title || message.body); copyPrMessage.title = title; copyPrMessage.setAttribute('aria-label', title); copyPrMessage.dataset.tooltip = title; }
      if (publishPr) { const existing = !!preview.existingPr; const title = pullRequestPublishActive ? publishText.busy : updating ? publishText.updating : existing ? publishText.existing : needsTarget ? publishText.selectTarget : !preview.sourceIsLocal ? publishText.selectLocalSource : !String(effectiveMessage(preview).title || '').trim() ? publishText.missingMessage : !preview.hasStagedChanges ? publishText.noChanges : publishText.ready; publishPr.hidden = existing; publishPr.disabled = pullRequestPublishActive || updating || existing || needsTarget || !preview.sourceIsLocal || !String(effectiveMessage(preview).title || '').trim() || !preview.hasStagedChanges; publishPr.title = title; publishPr.setAttribute('aria-label', publishText.create); publishPr.dataset.tooltip = title; publishPr.classList.toggle('busy', pullRequestPublishActive); }
    }
    /** host AI busy event를 toolbar에 반영한다. */
    function setPrMessageGenerationActive(active) { prMessageGenerationActive = !!active; if (latestPreview) syncActionButtons(latestPreview); }
    /** host publish busy event를 toolbar에 반영한다. */
    function setPullRequestPublishActive(active) { pullRequestPublishActive = !!active; if (latestPreview) syncActionButtons(latestPreview); }
    /** AI 결과를 요청 당시의 draft에만 적용해 branch 전환 중 화면 덮어쓰기를 막는다. */
    function applyGeneratedPullRequestMessage(message) { const draft = messageDrafts.get(aiRequestDraftKey); if (!draft || !message) return; if (message.title !== undefined) { draft.title.value = String(message.title); draft.title.dirty = draft.title.value !== draft.title.baseline; } if (message.body !== undefined) { draft.body.value = String(message.body); draft.body.dirty = draft.body.value !== draft.body.baseline; } if (latestPreview && draftKey(latestPreview) === aiRequestDraftKey) render(latestPreview); }
    /** 성공 화면의 update/error 상태를 HTML로 표시한다. */
    function previewStatusHtml() { if (previewUpdating) return '<p class="preview-status" role="status">' + esc(publishText.updating) + '</p>'; if (previewError) return '<div class="preview-warning" role="alert">' + esc(previewError) + ' <button class="gsc-button" type="button" data-retry-preview title="' + esc(publishText.retryPreview) + '" aria-label="' + esc(publishText.retryPreview) + '" data-tooltip="' + esc(publishText.retryPreview) + '">' + esc(publishText.retryPreview) + '</button></div>'; return ''; }
  `;
}
