// PR preview 의 source/target branch 검색 combobox 스크립트.
// - 패널 본문 파일이 커지지 않도록 branch picker 상호작용만 분리한다.

/**
 * PR preview 웹뷰에서 사용할 branch 검색 combobox 클라이언트 스크립트를 반환한다.
 * @returns pullRequestPreviewPanel 의 script 문자열에 삽입되는 JavaScript 코드
 */
export function pullRequestPreviewBranchComboboxScript(): string {
  return `
    function branchControl(id, role, caption, label, selected, branches, placeholder) {
      const values = Array.from(new Set([selected].concat(branches || []))).filter(Boolean);
      const listId = id + '-list';
      const options = values.map((branch) => branchOptionHtml(branch, branch === selected)).join('');
      return '<div class="branch-combo" data-branch-combo="' + esc(role) + '">' +
        '<label class="branch-combo-label" for="' + esc(id) + '">' + esc(caption) + '</label>' +
        '<div class="branch-combobox" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + esc(listId) + '">' +
          '<input id="' + esc(id) + '" class="branch-combo-input" type="text" value="' + esc(selected) + '" placeholder="' + esc(placeholder || '') + '" autocomplete="off" spellcheck="false" title="' + esc(label) + '" aria-label="' + esc(label) + '" data-branch-role="' + esc(role) + '" data-branch-selected="' + esc(selected) + '">' +
          '<button class="branch-combo-toggle" type="button" title="Show branch options" aria-label="Show branch options" data-tooltip="Show branch options" data-branch-toggle="' + esc(role) + '"><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>' +
          '<div id="' + esc(listId) + '" class="branch-combo-list" role="listbox" hidden>' + options + '</div>' +
        '</div></div>';
    }
    function branchOptionHtml(branch, selected) {
      return '<button class="branch-combo-option' + (selected ? ' active' : '') + '" type="button" role="option" aria-selected="' + (selected ? 'true' : 'false') + '" title="' + esc(branch) + '" aria-label="' + esc(branch) + '" data-branch-value="' + esc(branch) + '">' + esc(branch) + '</button>';
    }
    function bindPreviewBranches() {
      content.querySelectorAll('[data-branch-combo]').forEach((combo) => bindBranchCombo(combo));
    }
    function bindBranchCombo(combo) {
      const input = combo.querySelector('.branch-combo-input');
      const list = combo.querySelector('.branch-combo-list');
      const toggle = combo.querySelector('.branch-combo-toggle');
      if (!input || !list || !toggle) return;
      input.addEventListener('focus', () => openBranchCombo(combo));
      input.addEventListener('input', () => { filterBranchOptions(combo); openBranchCombo(combo); });
      input.addEventListener('keydown', (event) => handleBranchKeydown(event, combo));
      input.addEventListener('blur', () => window.setTimeout(() => commitBranchInput(combo), 120));
      toggle.addEventListener('click', () => isBranchComboOpen(combo) ? closeBranchCombo(combo) : openBranchCombo(combo));
      combo.querySelectorAll('[data-branch-value]').forEach((button) => {
        button.addEventListener('click', () => selectBranchValue(combo, button.dataset.branchValue || ''));
      });
    }
    function handleBranchKeydown(event, combo) {
      if (event.key === 'Escape') {
        closeBranchCombo(combo);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const active = combo.querySelector('.branch-combo-option.keyboard:not([hidden])') || firstVisibleBranchOption(combo);
        selectBranchValue(combo, active?.dataset.branchValue || '');
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveBranchKeyboardSelection(combo, event.key === 'ArrowDown' ? 1 : -1);
      }
    }
    function selectBranchValue(combo, value) {
      const input = combo.querySelector('.branch-combo-input');
      const branch = String(value || '').trim();
      if (!input || !branch) return;
      input.value = branch;
      input.dataset.branchSelected = branch;
      closeBranchCombo(combo);
      commitBranchSelection(input.dataset.branchRole || 'target', branch);
    }
    function commitBranchInput(combo) {
      const input = combo.querySelector('.branch-combo-input');
      if (!input) return;
      const branch = String(input.value || '').trim();
      const previous = input.dataset.branchSelected || '';
      const exact = branchOptionForValue(combo, branch);
      closeBranchCombo(combo);
      if (!branch || branch === previous || !exact) {
        input.value = previous;
        return;
      }
      input.dataset.branchSelected = branch;
      commitBranchSelection(input.dataset.branchRole || 'target', branch);
    }
    function commitBranchSelection(role, branch) {
      if (role === 'source') pendingSourceBranch = branch; else pendingTargetBranch = branch;
      if (latestPreview) render(latestPreview);
      vscode.postMessage({ type: 'setPreviewBranch', role, branch });
    }
    function openBranchCombo(combo) {
      filterBranchOptions(combo);
      combo.querySelector('.branch-combo-list')?.removeAttribute('hidden');
      combo.querySelector('.branch-combobox')?.setAttribute('aria-expanded', 'true');
    }
    function closeBranchCombo(combo) {
      combo.querySelector('.branch-combo-list')?.setAttribute('hidden', '');
      combo.querySelector('.branch-combobox')?.setAttribute('aria-expanded', 'false');
      combo.querySelectorAll('.branch-combo-option.keyboard').forEach((item) => item.classList.remove('keyboard'));
    }
    function isBranchComboOpen(combo) {
      return !combo.querySelector('.branch-combo-list')?.hasAttribute('hidden');
    }
    function filterBranchOptions(combo) {
      const query = String(combo.querySelector('.branch-combo-input')?.value || '').toLowerCase();
      let first = undefined;
      combo.querySelectorAll('.branch-combo-option').forEach((option) => {
        const matched = !query || String(option.dataset.branchValue || '').toLowerCase().includes(query);
        option.hidden = !matched;
        option.dataset.filtered = matched ? 'false' : 'true';
        option.classList.remove('keyboard');
        if (matched && !first) first = option;
      });
      first?.classList.add('keyboard');
    }
    function firstVisibleBranchOption(combo) {
      return Array.from(combo.querySelectorAll('.branch-combo-option')).find((option) => option.dataset.filtered !== 'true');
    }
    function branchOptionForValue(combo, value) {
      return Array.from(combo.querySelectorAll('.branch-combo-option')).find((option) => option.dataset.branchValue === value);
    }
    function moveBranchKeyboardSelection(combo, delta) {
      openBranchCombo(combo);
      const visible = Array.from(combo.querySelectorAll('.branch-combo-option')).filter((option) => option.dataset.filtered !== 'true');
      if (!visible.length) return;
      const current = visible.findIndex((option) => option.classList.contains('keyboard'));
      const next = visible[(current + delta + visible.length) % visible.length];
      visible.forEach((option) => option.classList.remove('keyboard'));
      next.classList.add('keyboard');
      next.scrollIntoView({ block: 'nearest' });
    }
  `;
}
