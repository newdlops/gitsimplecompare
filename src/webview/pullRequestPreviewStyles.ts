// PR preview 웹뷰 스타일.
// - 패널 생애주기/메시지 코드가 과도하게 커지지 않도록 CSS 문자열을 분리한다.

/**
 * PR preview 페이지 스타일을 반환한다.
 * @returns 웹뷰 style 태그에 삽입할 CSS 문자열
 */
/** Preview 내부 CSS 조각이 공통으로 쓰는 토큰 정의다. */
const SHARED_TOKEN_CSS = `
    :root { --border: var(--vscode-panel-border); --muted: var(--vscode-descriptionForeground); --panel: var(--vscode-editorWidget-background); --subtle: var(--vscode-sideBar-background); --green: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); --green-bg: color-mix(in srgb, var(--green) 16%, transparent); --red: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); --blue: var(--vscode-textLink-foreground, var(--vscode-charts-blue)); }
`;

/** Preview 셸 전용 CSS 조각이다. */
const PREVIEW_SHELL_CSS = `    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .topbar { position: sticky; z-index: 70; top: 0; display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .topbar-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .topbar-title .codicon { color: var(--green); }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    main { min-width: 0; padding: 16px; }
    .actions { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .topbar .actions > [hidden] { display: none; }
    .gsc-icon-button.busy .codicon { animation: codicon-spin 1.5s steps(30) infinite; }
    .publish-button { grid-auto-flow: column; gap: 6px; width: auto; min-width: 28px; padding: 0 10px; }
    .publish-label { white-space: nowrap; font-size: 12px; font-weight: 600; }
    .pr-page { width: min(100%, 1560px); min-width: 0; margin: 0 auto; display: grid; gap: 12px; }
    .pr-header { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; }
    .state-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 999px; background: var(--green-bg); color: var(--green); font-weight: 600; white-space: nowrap; }
    .state-pill.draft { color: var(--vscode-charts-purple); background: color-mix(in srgb, var(--vscode-charts-purple) 18%, transparent); }
    .state-pill.empty { color: var(--muted); background: var(--subtle); }
    .pr-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600; overflow-wrap: anywhere; }
    .pr-number { color: var(--muted); font-weight: 400; }
    .branch-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: var(--muted); }
    .branch-flow code { padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--blue); background: var(--subtle); font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .branch-combo { display: inline-flex; min-width: 0; align-items: center; gap: 5px; }
    .branch-combo-label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .branch-combobox { position: relative; display: inline-grid; min-width: 0; grid-template-columns: minmax(120px, 240px) 24px; height: 26px; border: 1px solid var(--border); border-radius: 4px; background: var(--subtle); }
    .branch-combo-input { min-width: 0; padding: 0 6px; border: 0; color: var(--blue); background: transparent; font: inherit; font-size: 12px; outline: none; }
    .branch-combobox:focus-within, .gsc-icon-button:focus-visible, .branch-combo-toggle:focus-visible, .tab:focus-visible, .file-view-button:focus-visible, .file-action:focus-visible, .file-toggle:focus-visible, .commit-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .branch-combo-toggle { display: inline-grid; place-items: center; width: 24px; border: 0; border-left: 1px solid var(--border); color: var(--muted); background: transparent; cursor: pointer; }
    .branch-combo-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .branch-combo-list { position: absolute; z-index: 60; top: calc(100% + 3px); left: -1px; right: -1px; max-height: 220px; overflow: auto; padding: 3px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; background: var(--vscode-dropdown-background, var(--panel)); box-shadow: 0 6px 18px var(--vscode-widget-shadow); }
    .branch-combo-option { display: block; width: 100%; min-height: 24px; padding: 3px 6px; border: 0; border-radius: 3px; color: inherit; background: transparent; text-align: left; font: inherit; font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .branch-combo-option[hidden], .branch-combo-option[data-filtered="true"] { display: none; }
    .branch-combo-option:hover, .branch-combo-option.keyboard { background: var(--vscode-list-hoverBackground); }
    .branch-combo-option.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .tabbar { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--border); scrollbar-gutter: stable; }
    .tab { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font: inherit; cursor: pointer; }
    .tab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); font-weight: 600; }
    .count { min-width: 18px; padding: 1px 6px; border-radius: 999px; text-align: center; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
    .content-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
    .content-single { display: grid; min-width: 0; }
    .side-stack { display: grid; gap: 12px; }
`;

/** Preview 내부 panel·markdown 영역이 공통으로 쓰는 CSS 조각이다. */
const SHARED_PANEL_MARKDOWN_CSS = `    .panel { min-width: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overflow: hidden; }
        .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--subtle); font-weight: 600; }
        .panel-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .panel-actions { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
        .file-view-toggle { display: inline-flex; align-items: center; gap: 2px; padding: 1px; border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-editor-background); }
        .file-view-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 22px; height: 22px; padding: 0 6px; border: 0; border-radius: 3px; color: var(--muted); background: transparent; cursor: pointer; }
        .file-view-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .file-view-button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .file-view-label { font-size: 11px; line-height: 1; white-space: nowrap; }
    .avatar { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 700; }
    .markdown-body { padding: 14px; overflow: auto; line-height: 1.5; }
    .markdown-body > :not(pre) { max-inline-size: 82ch; }
    .markdown-body :is(h1,h2,h3,p,ul,ol,blockquote,pre) { margin-top: 0; margin-bottom: 10px; }
    .markdown-body pre, .markdown-body code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    .markdown-body pre { padding: 10px; overflow: auto; }
    .markdown-body blockquote { padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
    .suggested-change { display: grid; gap: 6px; margin: 10px 0; }
    .suggested-change p { margin: 0; }
    .suggested-change-diff { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 20px; }
    .suggested-change-row { display: grid; grid-template-columns: 52px 52px 24px max-content; width: max-content; min-width: 100%; min-height: 20px; }
    .suggested-change-row.add { color: var(--vscode-foreground); background: color-mix(in srgb, var(--green) 14%, transparent); }
    .suggested-change-row.del { color: var(--vscode-foreground); background: color-mix(in srgb, var(--red) 13%, transparent); }
    .suggested-change-line-no { padding: 0 8px; border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); color: var(--muted); text-align: right; user-select: none; font-variant-numeric: tabular-nums; }
    .suggested-change-row.add .suggested-change-line-no.new, .suggested-change-row.del .suggested-change-line-no.old { color: var(--vscode-foreground); background: color-mix(in srgb, currentColor 7%, transparent); }
    .suggested-change-marker { padding: 0 7px; color: var(--muted); text-align: center; user-select: none; }
    .suggested-change-code { min-width: max-content; padding: 0 16px 0 2px; white-space: pre; tab-size: 2; }
`;

/** Preview Conversation 전용 CSS 조각이다. */
const PREVIEW_CONVERSATION_CSS = `    .pr-composer { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); background: var(--panel); }
    .preview-conversation-layout { display: grid; grid-template-columns: minmax(0, 1fr) 5px minmax(220px, var(--preview-inspector-width, 300px)); gap: 12px; align-items: start; }
    .preview-conversation-main, .preview-inspector, .preview-timeline { display: grid; gap: 12px; min-width: 0; }
    .preview-opening .pr-composer { border: 0; }
    .preview-conversation-item { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .preview-conversation-item__head { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--subtle); color: var(--muted); font-size: 12px; }
    .preview-conversation-item__head strong { color: var(--vscode-foreground); }
    .preview-conversation-item__body { padding: 10px; overflow-wrap: anywhere; line-height: 1.5; }
    .preview-conversation-item__body > :not(pre) { max-inline-size: 82ch; }
    .preview-inspector { position: sticky; top: 56px; }
    .preview-inspector-splitter { align-self: stretch; min-height: 48px; border-left: 1px solid var(--vscode-panel-border); cursor: col-resize; touch-action: none; }
    .preview-inspector-splitter:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .preview-file-tree { display: block; max-width: 100%; overflow: auto hidden; padding: 6px; scrollbar-gutter: stable; }
    .preview-file-tree:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .preview-file-tree__content, .preview-tree-folder, .preview-tree-folder > div { display: grid; grid-auto-rows: max-content; align-content: start; gap: 2px; box-sizing: border-box; }
    .preview-file-tree__content { width: max-content; min-width: 100%; }
    .preview-tree-folder { width: 100%; }
    .preview-tree-folder > summary, .preview-tree-file { box-sizing: border-box; min-width: max-content; padding: 4px 6px; color: var(--vscode-foreground); background: transparent; font: inherit; font-size: 12px; text-align: left; white-space: nowrap; cursor: pointer; }
    .preview-tree-folder > summary { display: flex; width: 100%; align-items: center; list-style: none; } .preview-tree-folder > summary::-webkit-details-marker { display: none; }
    .preview-tree-folder > summary .codicon, .preview-tree-file .codicon { margin-right: 5px; }
    .preview-tree-folder > div { width: 100%; padding-inline-start: 12px; }
    .preview-tree-file { display: grid; grid-template-columns: auto minmax(max-content, 1fr) auto; align-items: center; gap: 5px; width: 100%; border: 0; }
    .preview-tree-file__name { min-width: 0; white-space: nowrap; }
    .preview-tree-file__stats { display: inline-grid; grid-template-columns: minmax(3ch, auto) minmax(3ch, auto); gap: 5px; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; text-align: right; }
    .preview-tree-file__add { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .preview-tree-file__del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .preview-tree-file:hover, .preview-tree-file:focus-visible, .preview-tree-folder > summary:hover, .preview-tree-folder > summary:focus-visible { background: var(--vscode-toolbar-hoverBackground); }
`;

/** Preview 파일 action이 공통으로 쓰는 CSS 조각이다. */
const SHARED_FILE_ACTION_CSS = `    .file-viewed-button { min-height: 22px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); background: transparent; cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
    .file-viewed-button.active { color: var(--vscode-testing-iconPassed, var(--green)); border-color: var(--vscode-testing-iconPassed, var(--green)); }
    .review-file-head .file-action[hidden], .review-file-head .file-viewed-button[hidden] { display: none; }
`;

/** Preview form/status 전용 CSS 조각이다. */
const PREVIEW_FORM_STATUS_CSS = `    .gsc-field { display: grid; gap: 5px; min-width: 0; }
    .gsc-field label { color: var(--muted); font-size: 12px; font-weight: 600; }
    .gsc-field input, .gsc-field textarea { width: 100%; min-width: 0; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); font: inherit; }
    .gsc-field textarea { resize: vertical; }
    .gsc-field__error { margin: -3px 0 0; color: var(--vscode-inputValidation-errorForeground, var(--red)); font-size: 12px; }
    .preview-status, .preview-warning, .preview-error { margin: 0; padding: 8px 12px; border: 1px solid var(--border); color: var(--muted); }
    .preview-warning, .preview-error { color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); border-color: var(--vscode-inputValidation-warningBorder, var(--border)); }
`;

/** Preview 파일·diff 영역이 공통으로 쓰는 CSS 조각이다. */
const SHARED_FILE_DIFF_CSS = `    .file-list { display: grid; gap: 10px; min-width: 0; padding: 10px; background: var(--vscode-editor-background); }
    .commit-list { display: grid; min-width: 0; }
    .commit-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 10px; border: 0; border-top: 1px solid var(--border); color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
    .commit-row:hover, .commit-row.active { background: var(--vscode-list-hoverBackground); }
    .commit-row:first-child { border-top: 0; }
    .commit-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .commit-hash { color: var(--muted); font-size: 12px; }
        .review-file { min-width: 0; border-top: 1px solid var(--border); }
        .review-file:first-child { border-top: 0; }
        .file-list .review-file { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
        .file-list .review-file:first-child { border-top: 1px solid var(--border); }
        .review-file-head { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto auto auto auto; gap: 8px; align-items: center; padding: 9px 10px; background: var(--subtle); }
        .review-file-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
    .file-action, .file-toggle { display: inline-grid; place-items: center; width: 24px; height: 22px; border: 1px solid var(--border); border-radius: 3px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
    .file-action:hover:not(:disabled), .file-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .file-action:disabled { color: var(--vscode-disabledForeground); background: transparent; cursor: default; }
    .file-toggle { width: 22px; }
    .comment-chip { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
    .diff-snippet { display: block; width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; overflow-y: hidden; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 20px; }
    .github-diff { border-top: 1px solid var(--border); }
    .diff-row { display: grid; grid-template-columns: 52px 52px 24px max-content; width: max-content; min-width: 100%; min-height: 20px; }
    .split-diff .diff-row { width: 100%; }
    .diff-row.split-row { grid-template-columns: 52px 24px minmax(220px, 1fr) 52px 24px minmax(220px, 1fr); }
    .diff-row.split-meta-row { grid-template-columns: 52px 52px 24px max-content; }
    .diff-row.add { background: color-mix(in srgb, var(--green) 14%, transparent); }
    .diff-row.del { background: color-mix(in srgb, var(--red) 13%, transparent); }
    .diff-row.split-row.add, .diff-row.split-row.del, .diff-row.split-row.change { background: transparent; }
    .diff-row.hunk, .diff-row.meta, .diff-row.omitted { color: var(--blue); background: color-mix(in srgb, var(--blue) 9%, transparent); }
    .diff-line-no { padding: 0 8px; border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); color: var(--muted); text-align: right; user-select: none; font-variant-numeric: tabular-nums; }
    .diff-marker { padding: 0 7px; color: var(--muted); text-align: center; user-select: none; }
    .diff-code { min-width: max-content; padding: 0 16px 0 2px; white-space: pre; tab-size: 2; }
    .split-row .diff-code { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .split-row .diff-line-no.del, .split-row .diff-marker.del, .split-row .diff-code.del { background: color-mix(in srgb, var(--red) 13%, transparent); }
    .split-row .diff-line-no.add, .split-row .diff-marker.add, .split-row .diff-code.add { background: color-mix(in srgb, var(--green) 14%, transparent); }
    .split-row .diff-line-no.empty, .split-row .diff-marker.empty, .split-row .diff-code.empty { background: color-mix(in srgb, var(--muted) 4%, transparent); }
    .diff-row.add .diff-line-no.new, .diff-row.del .diff-line-no.old { color: var(--vscode-foreground); background: color-mix(in srgb, currentColor 7%, transparent); }
    .diff-word { border-radius: 2px; font-weight: 700; }
    .diff-word.add { background: color-mix(in srgb, var(--green) 36%, transparent); }
    .diff-word.del { background: color-mix(in srgb, var(--red) 34%, transparent); }
    .diff-context-toggle { display: inline-flex; align-items: center; min-height: 18px; padding: 0 8px; border: 1px solid var(--border); border-radius: 3px; color: var(--blue); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
    .diff-context-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .diff-context-actions { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .diff-comment-row { display: grid; grid-template-columns: 52px 52px 24px minmax(420px, 1fr); width: max-content; min-width: 100%; background: var(--vscode-editor-background); }
    .split-diff .diff-comment-row { width: 100%; }
    .diff-comment-row .diff-marker { padding-top: 10px; color: var(--vscode-charts-purple); }
    .diff-inline-comments { display: grid; gap: 8px; min-width: 0; padding: 8px 12px 10px 0; }
    .diff-inline-comment { min-width: min(720px, calc(100vw - 220px)); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-foreground)); }
    .tok-str { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-foreground)); }
    .tok-comment { color: var(--vscode-editorCodeLens-foreground, var(--muted)); font-style: italic; }
    .tok-number { color: var(--vscode-symbolIcon-numberForeground, var(--vscode-foreground)); }
    .tok-tag, .tok-attr { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
        .continuous-diff-list { display: grid; min-width: 0; background: var(--vscode-textCodeBlock-background); }
        .continuous-diff-list .review-file { border-top: 1px solid var(--border); background: transparent; }
        .continuous-diff-list .review-file:first-child { border-top: 0; }
        .continuous-diff-list .review-file-head { background: var(--vscode-editor-background); }
        .continuous-file.collapsed .review-file-body, .review-file.collapsed .review-comments { display: none; }
        .review-comments { display: grid; gap: 8px; padding: 10px; border-top: 1px solid var(--border); background: var(--vscode-editor-background); }
    .review-comment { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .comment-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--border); background: var(--subtle); color: var(--muted); }
    .comment-body { padding: 9px; line-height: 1.4; }
    .mini-diff { border-top: 1px solid var(--border); max-height: 180px; }
    .commit-review { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 12px; align-items: start; }
    .stat { display: flex; gap: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .add { color: var(--green); }
    .del { color: var(--red); }
    .empty, .placeholder { margin: 0; padding: 14px; color: var(--muted); }
    .warning { border-color: var(--vscode-inputValidation-warningBorder, var(--border)); }
`;

/** Preview 반응형 전용 CSS 조각이다. */
const PREVIEW_MEDIA_CSS = `    @media (max-width: 899px) { .preview-conversation-layout { grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); } .preview-inspector-splitter { display: none; } }
    @media (max-width: 800px) {
      .topbar { align-items: flex-start; flex-wrap: wrap; }
      .actions { justify-content: flex-start; }
      .branch-flow { align-items: stretch; }
      .branch-combo { flex: 1 1 240px; }
      .branch-combobox { flex: 1; }
      .tab { flex: 0 0 auto; }
    }
    @media (max-width: 560px) {
      main { padding: 10px; }
      .topbar { padding: 8px 10px; }
      .actions { width: 100%; }
      .publish-button { flex: 1 1 180px; justify-content: center; }
      .branch-combo { flex-basis: 100%; }
      .content-grid { grid-template-columns: 1fr; }
      .commit-review { grid-template-columns: 1fr; }
      .preview-conversation-layout { grid-template-columns: minmax(0, 1fr); }
      .preview-inspector { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .pr-title { font-size: 18px; }
      .preview-inspector { grid-template-columns: minmax(0, 1fr); }
      .review-file-head { grid-template-columns: auto auto minmax(0, 1fr) auto auto; }
      .review-file-head .file-viewed-button, .review-file-head .file-action { grid-row: 2; }
    }
    @media (prefers-reduced-motion: reduce) { .gsc-icon-button.busy .codicon { animation: none; } }
  `;

/** Preview의 기존 CSS byte ordering을 변경 없이 조합한다. */
export function pullRequestPreviewStyles(): string {
  return SHARED_TOKEN_CSS + PREVIEW_SHELL_CSS + SHARED_PANEL_MARKDOWN_CSS + PREVIEW_CONVERSATION_CSS + SHARED_FILE_ACTION_CSS + PREVIEW_FORM_STATUS_CSS + SHARED_FILE_DIFF_CSS + PREVIEW_MEDIA_CSS;
}
