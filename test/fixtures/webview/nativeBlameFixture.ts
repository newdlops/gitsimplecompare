/** browser/직접 preview가 같은 실제 gutter renderer와 테마·상태 fixture를 사용하게 한다. */
export interface NativeBlameFixtureOptions {
  theme?: "dark" | "light" | "contrast";
  mode?: "ready" | "loading" | "error" | "working" | "empty";
  locale?: string;
  longText?: boolean;
  delayMs?: number;
  codiconCss?: string;
  fontUrl?: string;
}

/**
 * 실제 Monaco의 URI/레이아웃/표시 이벤트만 대체하고 DOM·포인터·포커스·CSS는 browser에서 실행한다.
 * @param options 재현할 테마/지연/오류/미커밋/긴 텍스트. 네트워크나 사용자 저장소는 접근하지 않는다.
 */
export function mountNativeBlameFixture(options: NativeBlameFixtureOptions = {}): void {
  const w = window as any;
  const theme = options.theme || "dark", mode = options.mode || "ready";
  const colors = theme === "light"
    ? { editor: "#ffffff", surface: "#f8f8f8", foreground: "#242424", muted: "#5f6365", border: "#c8c8c8", link: "#006ab1", added: "#176f2c", deleted: "#9d1731", focus: "#005fb8" }
    : theme === "contrast"
      ? { editor: "#000000", surface: "#000000", foreground: "#ffffff", muted: "#eeeeee", border: "#ffffff", link: "#7cc8ff", added: "#b5f0a3", deleted: "#ff91a4", focus: "#ffff00" }
      : { editor: "#1f1f1f", surface: "#252526", foreground: "#dddddd", muted: "#b2b2b2", border: "#454545", link: "#4daafc", added: "#81b88b", deleted: "#ef9191", focus: "#007fd4" };
  const tokens: Record<string, string> = {
    "editor-background": colors.editor, "editorGutter-background": colors.editor, "editorCodeLens-foreground": colors.muted,
    "editor-foreground": colors.foreground, foreground: colors.foreground, "descriptionForeground": colors.muted,
    "editorHoverWidget-background": colors.surface, "editorHoverWidget-foreground": colors.foreground,
    "editorHoverWidget-border": colors.border, "focusBorder": colors.focus, "icon-foreground": colors.foreground,
    "textLink-foreground": colors.link, "textLink-activeForeground": colors.link,
    "scmGraph-historyItemHoverAdditionsForeground": colors.added, "scmGraph-historyItemHoverDeletionsForeground": colors.deleted,
    "toolbar-hoverBackground": theme === "light" ? "#e2e2e2" : "#3a3a3a", "disabledForeground": colors.muted,
    "errorForeground": theme === "light" ? "#b40016" : "#ff9191",
    "font-family": "system-ui, sans-serif", "font-size": "13px", "editor-font-family": "monospace", "widget-shadow": "#0006",
    "scrollbarSlider-background": colors.muted, "editor-selectionBackground": colors.link,
  };
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty("--vscode-" + key, value);
  const style = document.createElement("style");
  style.textContent = `
    html,body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);}
    .monaco-editor{position:relative;height:660px;width:100%;font:14px var(--vscode-editor-font-family);}
    .overflow-guard{position:relative;height:100%;overflow:hidden;}
    .margin-view-overlays{position:absolute;inset:0 auto 0 0;width:70px;}
    .margin-view-overlays>div{position:absolute;left:0;width:70px;height:24px;}
    .line-numbers{padding-left:20px;color:var(--vscode-descriptionForeground);}
    .view-lines{position:absolute;top:0;right:0;left:70px;}
    .view-line{position:absolute;height:24px;white-space:pre;}
  `;
  if (options.codiconCss) style.textContent += options.codiconCss.replace(/url\([^)]*\)/, 'url("' + options.fontUrl + '")');
  document.head.appendChild(style);
  // 구조 문자열은 고정된 테스트 markup뿐이며 커밋 메시지는 renderer의 textContent를 통과한다.
  document.body.innerHTML = '<div class="monaco-workbench"><div class="monaco-editor" tabindex="0"><div class="overflow-guard"><div class="margin-view-overlays"></div><div class="view-lines"></div></div></div></div>';
  const root = document.querySelector<HTMLElement>(".monaco-editor")!;
  const margin = root.querySelector(".margin-view-overlays")!, code = root.querySelector<HTMLElement>(".view-lines")!;
  for (let index = 1; index <= 16; index++) {
    const row = document.createElement("div"); row.style.top = `${index * 24}px`;
    const number = document.createElement("span"); number.className = "line-numbers"; number.setAttribute("data-line-number", String(index));
    number.textContent = String(index); row.appendChild(number); margin.appendChild(row);
    const source = document.createElement("div"); source.className = "view-line"; source.style.top = row.style.top;
    source.textContent = `const line${index} = ${index};`; code.appendChild(source);
  }
  const listeners = new Map<string, () => void>();
  let extraWidth = 0;
  const editor: any = { getModel: () => ({ uri: { toString: () => "file:///repo/example.ts" } }),
    getDomNode: () => root, getRawOptions: () => ({ lineDecorationsWidth: 10 }),
    getLayoutInfo: () => ({ contentLeft: 70 + extraWidth }),
    updateOptions: (value: any) => { extraWidth = value.lineDecorationsWidth - 10; code.style.left = `${70 + extraWidth}px`; } };
  for (const name of ["onDidScrollChange", "onDidLayoutChange", "onDidChangeModel", "onDidDispose"]) {
    editor[name] = (callback: () => void) => { listeners.set(name, callback); return { dispose: () => listeners.delete(name) }; };
  }
  root.addEventListener("mousedown", event => { event.preventDefault(); root.focus(); });
  window.addEventListener("resize", () => listeners.get("onDidLayoutChange")?.());
  const commit = mode === "working" ? "0".repeat(40) : "abcdef1234".repeat(4);
  const name = options.longText ? "김민수 Very Long Author Name ".repeat(4) : "김민수";
  const email = options.longText ? "very.long.author.email.with.many.parts@example.invalid" : "minsu@example.invalid";
  const summary = { hash: commit, authorName: mode === "working" ? "Working tree" : name, authorEmail: mode === "working" ? "" : email,
    authorDateIso: mode === "working" ? "" : "2026-10-07T08:20:00+09:00",
    message: mode === "working" ? "Changes on this line have not been committed." : "Restore complete commit information in native blame hover" };
  const body = options.longText
    ? "A long explanation <script> stays literal, with 한국어 and unbroken_identifier_".repeat(70)
    : "Preserve the commit message body and show the actual file statistics.\n\nKeep <script> text safe while inspecting history.\n\nCo-authored-by: Alex Park <alex@example.invalid>";
  const details = { ...summary, message: summary.message + "\n\n" + body,
    coAuthors: [{ name: "Alex Park", email: "alex@example.invalid" }],
    stats: mode === "empty" ? { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 } : { files: 4, insertions: 42, deletions: 7, binaryFiles: 1 },
    remoteUrl: "https://github.com/newdlops/gitsimplecompare/commit/" + commit };
  const labels = options.locale === "ko" ? { title:"커밋 상세",loading:"커밋 상세 정보를 불러오는 중…",error:"커밋 상세 정보를 불러오지 못했습니다.",retry:"다시 시도",copied:"커밋 해시를 복사했습니다",
    copyHash:"커밋 해시 복사",openCommit:"커밋 변경 내용 열기",openRemote:"브라우저에서 커밋 열기",settings:"Blame 설정 열기",coAuthor:"공동 작성자",
    fileChanged:"파일 {0}개 변경",filesChanged:"파일 {0}개 변경",noChanges:"변경된 파일 없음",insertions:"{0}줄 추가 (+)",deletions:"{0}줄 삭제 (-)",binaryFiles:"바이너리 또는 대용량 파일 {0}개" } : undefined;
  w.__gscNativeBlameEditor = editor; w.__testEditorEvents = listeners; w.__testRequests = [];
  w.__testSnapshot = { uri:"file:///repo/example.ts",repoRoot:"/repo",revision:1,columnWidthCh:31,locale:options.locale || "en",hoverLabels:labels,
    commits:{[commit]:summary},lines:Array.from({length:50_000},(_,index)=>({line:index+1,commit,label:summary.authorName+" · 2026-10-07",tooltip:`Line ${index+1}\n${name} <${email}>\n${commit}\n${summary.message}`})) };
  /** popup의 원래 request 식별자로만 모의 host 응답을 전달한다. */
  w.__testRespond = (request: any, status = "ready") => w.__gscNativeBlameOverlay.updateHover({ ...request, status, details,
    message: status === "error" ? "Could not load commit details." : status === "copied" ? "Commit hash copied" : undefined });
  w.gscNativeDiffOverlayToggle = (payload: string) => {
    const request = JSON.parse(payload); w.__testRequests.push(request);
    if (request.action === "copyHash") { w.__testRespond(request,"copied"); return; }
    if (request.action !== "load" && request.action !== "retry" || mode === "loading") return;
    setTimeout(() => w.__testRespond(request, mode === "error" && request.action === "load" ? "error" : "ready"), options.delayMs ?? 70);
  };
}
