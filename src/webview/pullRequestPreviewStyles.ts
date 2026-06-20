// PR preview 웹뷰 스타일.
// - 패널 생애주기/메시지 코드가 과도하게 커지지 않도록 CSS 문자열을 분리한다.

/**
 * PR preview 페이지 스타일을 반환한다.
 * @returns 웹뷰 style 태그에 삽입할 CSS 문자열
 */
export function pullRequestPreviewStyles(): string {
  return `
    :root { --border: var(--vscode-panel-border); --muted: var(--vscode-descriptionForeground); --panel: var(--vscode-editorWidget-background); --subtle: var(--vscode-sideBar-background); --green: #2ea043; --green-bg: rgba(46, 160, 67, .16); --red: #f85149; --blue: #58a6ff; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .topbar-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .topbar-title .codicon { color: var(--green); }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    main { padding: 16px; }
    .actions { display: flex; gap: 6px; }
    .icon-button { position: relative; display: inline-grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .icon-button:hover { background: var(--vscode-button-hoverBackground); }
    .icon-button:disabled { cursor: not-allowed; opacity: .55; color: var(--vscode-disabledForeground, var(--muted)); background: var(--vscode-button-secondaryBackground); }
    .icon-button[data-tooltip]::after { content: attr(data-tooltip); position: fixed; z-index: 100; top: 40px; right: 10px; max-width: min(420px, calc(100vw - 20px)); padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 3px; color: var(--vscode-quickInput-foreground); background: #252526; opacity: 0; pointer-events: none; white-space: normal; overflow-wrap: anywhere; }
    .icon-button[data-tooltip]:hover::after, .icon-button[data-tooltip]:focus-visible::after { opacity: 1; }
    .pr-page { max-width: 1080px; margin: 0 auto; display: grid; gap: 12px; }
    .pr-header { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .state-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 999px; background: var(--green-bg); color: var(--green); font-weight: 600; white-space: nowrap; }
    .state-pill.draft { color: var(--vscode-charts-purple); background: color-mix(in srgb, var(--vscode-charts-purple) 18%, transparent); }
    .state-pill.empty { color: var(--muted); background: var(--subtle); }
    .pr-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600; overflow-wrap: anywhere; }
    .pr-number { color: var(--muted); font-weight: 400; }
    .branch-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: var(--muted); }
    .branch-flow code { padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--blue); background: var(--subtle); font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .branch-combo { display: inline-flex; align-items: center; gap: 5px; }
    .branch-combo-label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .branch-combobox { position: relative; display: inline-grid; grid-template-columns: minmax(160px, 240px) 24px; height: 26px; border: 1px solid var(--border); border-radius: 4px; background: var(--subtle); }
    .branch-combo-input { min-width: 0; padding: 0 6px; border: 0; color: var(--blue); background: transparent; font: inherit; font-size: 12px; outline: none; }
    .branch-combo-toggle { display: inline-grid; place-items: center; width: 24px; border: 0; border-left: 1px solid var(--border); color: var(--muted); background: transparent; cursor: pointer; }
    .branch-combo-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .branch-combo-list { position: absolute; z-index: 60; top: calc(100% + 3px); left: -1px; right: -1px; max-height: 220px; overflow: auto; padding: 3px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; background: var(--vscode-dropdown-background, var(--panel)); box-shadow: 0 6px 18px rgba(0,0,0,.28); }
    .branch-combo-option { display: block; width: 100%; min-height: 24px; padding: 3px 6px; border: 0; border-radius: 3px; color: inherit; background: transparent; text-align: left; font: inherit; font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .branch-combo-option[hidden], .branch-combo-option[data-filtered="true"] { display: none; }
    .branch-combo-option:hover, .branch-combo-option.keyboard { background: var(--vscode-list-hoverBackground); }
    .branch-combo-option.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .tabbar { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
    .tab { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font: inherit; cursor: pointer; }
    .tab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); font-weight: 600; }
    .count { min-width: 18px; padding: 1px 6px; border-radius: 999px; text-align: center; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
    .content-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
    .content-single { display: grid; min-width: 0; }
    .side-stack { display: grid; gap: 12px; }
    .panel { min-width: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overflow: hidden; }
        .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--subtle); font-weight: 600; }
        .panel-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .panel-actions { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
        .file-view-toggle { display: inline-flex; align-items: center; gap: 2px; padding: 1px; border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-editor-background); }
        .file-view-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 22px; height: 22px; padding: 0 6px; border: 0; border-radius: 3px; color: var(--muted); background: transparent; cursor: pointer; }
        .file-view-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .file-view-button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .file-view-label { font-size: 11px; line-height: 1; white-space: nowrap; }
        .file-view-button[data-tooltip]::after, .file-action[data-tooltip]::after, .file-toggle[data-tooltip]::after, .viewed-toggle[data-tooltip]::after { content: attr(data-tooltip); position: fixed; z-index: 100; top: 52px; right: 12px; max-width: min(420px, calc(100vw - 24px)); padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 3px; color: var(--vscode-quickInput-foreground); background: #252526; opacity: 0; pointer-events: none; white-space: normal; overflow-wrap: anywhere; font-weight: 400; }
        .file-view-button[data-tooltip]:hover::after, .file-view-button[data-tooltip]:focus-visible::after, .file-action[data-tooltip]:hover::after, .file-action[data-tooltip]:focus-visible::after, .file-toggle[data-tooltip]:hover::after, .file-toggle[data-tooltip]:focus-visible::after, .viewed-toggle[data-tooltip]:hover::after, .viewed-toggle[data-tooltip]:focus-visible::after { opacity: 1; }
    .avatar { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 700; }
    .markdown-body { padding: 14px; overflow: auto; line-height: 1.5; }
    .markdown-body :is(h1,h2,h3,p,ul,ol,blockquote,pre) { margin-top: 0; margin-bottom: 10px; }
    .markdown-body pre, .markdown-body code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    .markdown-body pre { padding: 10px; overflow: auto; }
    .markdown-body blockquote { padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
    .timeline { display: grid; gap: 12px; }
    .timeline-item { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 10px; }
    .timeline-card { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .timeline-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--subtle); color: var(--muted); }
    .timeline-head strong { color: var(--vscode-foreground); }
    .timeline-context { display: inline-flex; flex-wrap: wrap; gap: 5px; }
    .timeline-context code { padding: 1px 5px; border: 1px solid var(--border); border-radius: 3px; color: var(--blue); background: var(--vscode-textCodeBlock-background); }
    .timeline-body.muted { padding: 10px 12px; color: var(--muted); font-style: italic; }
    .quick-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .metric { padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    .metric-label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
    .metric-value { margin-top: 5px; font-weight: 600; overflow-wrap: anywhere; }
    .file-list { display: grid; gap: 10px; min-width: 0; padding: 10px; background: var(--vscode-editor-background); }
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
        .review-file-head { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto auto auto; gap: 8px; align-items: center; padding: 9px 10px; background: var(--subtle); }
        .review-file-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
        .review-file.viewed .review-file-title { color: var(--muted); }
    .file-action, .file-toggle { display: inline-grid; place-items: center; width: 24px; height: 22px; border: 1px solid var(--border); border-radius: 3px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
    .file-action:hover, .file-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .file-toggle { width: 22px; }
    .viewed-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 72px; height: 22px; padding: 0 7px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); background: var(--vscode-button-secondaryBackground); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .viewed-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .viewed-toggle.viewed { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-border, var(--border)); }
    .viewed-toggle:not(.viewed) .codicon { opacity: .25; }
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
    .diff-context-toggle { display: inline-flex; align-items: center; min-height: 18px; padding: 0 8px; border: 1px solid var(--border); border-radius: 3px; color: var(--blue); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
    .diff-context-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .diff-context-actions { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .diff-comment-row { display: grid; grid-template-columns: 52px 52px 24px minmax(420px, 1fr); width: max-content; min-width: 100%; background: var(--vscode-editor-background); }
    .split-diff .diff-comment-row { width: 100%; }
    .diff-comment-row .diff-marker { padding-top: 10px; color: var(--vscode-charts-purple); }
    .diff-inline-comments { display: grid; gap: 8px; min-width: 0; padding: 8px 12px 10px 0; }
    .diff-inline-comment { min-width: min(720px, calc(100vw - 220px)); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .tok-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .tok-comment { color: var(--vscode-editorCodeLens-foreground, #6a9955); font-style: italic; }
    .tok-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .tok-tag, .tok-attr { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
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
        .file-tree { display: grid; gap: 1px; overflow-x: auto; padding: 6px 8px 10px; }
        .file-tree.list { gap: 0; }
    .tree-row { display: grid; grid-template-columns: 14px 16px 16px minmax(0, 1fr) auto; gap: 6px; align-items: center; width: 100%; min-width: max-content; min-height: 24px; padding: 2px 6px 2px var(--indent, 0); border: 0; border-radius: 4px; color: inherit; background: transparent; text-align: left; font: inherit; }
    .tree-row:hover { background: var(--vscode-list-hoverBackground); }
    .tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-folder { font-weight: 600; cursor: pointer; }
    .tree-children.collapsed { display: none; }
    .tree-children { margin-left: 22px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--border)); }
    .stat { display: flex; gap: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .add { color: var(--green); }
    .del { color: var(--red); }
    .empty, .placeholder { margin: 0; padding: 14px; color: var(--muted); }
    .warning { border-color: var(--vscode-inputValidation-warningBorder, var(--border)); }
    @media (max-width: 820px) {
      main { padding: 10px; }
      .content-grid { grid-template-columns: 1fr; }
      .commit-review { grid-template-columns: 1fr; }
      .quick-stats { grid-template-columns: 1fr; }
      .pr-title { font-size: 18px; }
    }
  `;
}
