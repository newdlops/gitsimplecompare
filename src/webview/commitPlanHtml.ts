// AI 커밋 플랜 웹뷰의 HTML shell과 지역화/정적 리소스를 조립하는 모듈.
// - 패널 생애주기에서 CSP, URI 버전, 마크업 책임을 분리한다.
// - 정적/동적 버튼이 공유할 지역화 문자열을 한 번에 웹뷰 전역으로 주입한다.
import * as vscode from "vscode";
import { instantTooltipResources } from "./instantTooltipResources";
import {
  makeNonce,
  resourceVersion,
  withVersion,
} from "./webviewResourceVersion";

/** HTML 생성에 필요한 버전 적용 웹뷰 리소스 묶음. */
interface CommitPlanResources {
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
  codiconUri: vscode.Uri;
  tooltipScriptUri: vscode.Uri;
  tooltipStyleUri: vscode.Uri;
}

/** 웹뷰 JS와 HTML 양쪽에서 사용하는 지역화 문자열 사전. */
type CommitPlanI18n = ReturnType<typeof commitPlanI18n>;

/**
 * AI 커밋 플랜 웹뷰에 주입할 완성 HTML을 만든다.
 * @param extensionUri 확장 루트 URI. media 리소스 위치 계산에 사용한다.
 * @param webview 리소스 URI와 CSP source를 제공하는 현재 웹뷰
 * @returns CSP/지역화/정적 리소스가 포함된 HTML 문서
 */
export function buildCommitPlanHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview
): string {
  const resources = commitPlanResources(extensionUri, webview);
  const nonce = makeNonce();
  const csp = commitPlanCsp(webview, nonce);
  const i18n = commitPlanI18n();
  const title = vscode.l10n.t("AI Commit Plan");
  return documentHtml(resources, nonce, csp, title, i18n);
}

/**
 * commit-plan JS/CSS, codicon, 즉시 tooltip 파일에 웹뷰 URI와 cache-buster를 적용한다.
 * @param extensionUri 확장 루트 URI
 * @param webview URI를 웹뷰 전용 scheme으로 바꿀 객체
 * @returns HTML link/script 태그에서 사용할 리소스 URI
 */
function commitPlanResources(
  extensionUri: vscode.Uri,
  webview: vscode.Webview
): CommitPlanResources {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "commit-plan");
  const scriptFile = vscode.Uri.joinPath(mediaRoot, "commitPlan.js");
  const styleFile = vscode.Uri.joinPath(mediaRoot, "commitPlan.css");
  const codiconFile = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "codicons",
    "codicon.css"
  );
  const version = resourceVersion([scriptFile, styleFile]);
  const tooltip = instantTooltipResources(webview, extensionUri);
  return {
    scriptUri: webview.asWebviewUri(withVersion(scriptFile, version)),
    styleUri: webview.asWebviewUri(withVersion(styleFile, version)),
    codiconUri: webview.asWebviewUri(withVersion(codiconFile, version)),
    tooltipScriptUri: tooltip.scriptUri,
    tooltipStyleUri: tooltip.styleUri,
  };
}

/**
 * 로컬 스타일/font와 nonce가 일치하는 script만 허용하는 CSP를 만든다.
 * @param webview 현재 웹뷰 CSP source 제공자
 * @param nonce 이번 HTML 문서에서만 유효한 script nonce
 * @returns meta 태그 content에 넣을 CSP 문자열
 */
function commitPlanCsp(webview: vscode.Webview, nonce: string): string {
  return [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

/**
 * 웹뷰 client가 렌더/검증/tooltip에 사용할 모든 런타임 문자열을 지역화한다.
 * @returns 고정 JS key와 현재 locale 문자열의 매핑
 */
function commitPlanI18n() {
  return {
    configure: vscode.l10n.t("Configure AI CLI"),
    refresh: vscode.l10n.t("Refresh Commit Plan Context"),
    generate: vscode.l10n.t("Generate Plan"),
    regenerate: vscode.l10n.t("Regenerate Plan"),
    execute: vscode.l10n.t("Create Planned Commits"),
    promptPlaceholder: vscode.l10n.t(
      "Example: Keep tests with implementation and separate documentation."
    ),
    planTitle: vscode.l10n.t("Proposed Commits"),
    noPlan: vscode.l10n.t("Generate a plan to review proposed commits."),
    warnings: vscode.l10n.t("AI plan warnings"),
    commitNumber: vscode.l10n.t("Commit {0}"),
    commitMessage: vscode.l10n.t("Commit message"),
    commitReason: vscode.l10n.t("Reason"),
    reasonPlaceholder: vscode.l10n.t("Why these files belong together"),
    files: vscode.l10n.t("Files"),
    moveUp: vscode.l10n.t("Move commit up"),
    moveDown: vscode.l10n.t("Move commit down"),
    openFile: vscode.l10n.t("Open {0}"),
    moveFile: vscode.l10n.t("Move {0} to another commit"),
    fallback: vscode.l10n.t("Fallback group"),
    groupsAndFiles: vscode.l10n.t("{0} commit(s), {1} file(s)"),
    contextSummary: vscode.l10n.t("{0} · {1} changed file(s)"),
    stagedScope: vscode.l10n.t("Staged changes only"),
    allScope: vscode.l10n.t("All working tree changes"),
    staged: vscode.l10n.t("Staged"),
    unstaged: vscode.l10n.t("Unstaged"),
    currentBranch: vscode.l10n.t("Current branch"),
    intent: vscode.l10n.t("Intent: {0}"),
    refreshing: vscode.l10n.t("Refreshing commit plan context..."),
    generating: vscode.l10n.t("Generating AI commit plan..."),
    executing: vscode.l10n.t("Executing AI commit plan..."),
    completed: vscode.l10n.t("AI commit plan completed."),
    messageRequired: vscode.l10n.t("Every commit needs a message."),
    fileRequired: vscode.l10n.t("Every commit needs at least one file."),
    unassignedFiles: vscode.l10n.t(
      "Every changed file must belong to one commit."
    ),
  };
}

/**
 * head/body 영역을 결합하고 client 지역화 사전과 정적 스크립트를 안전하게 주입한다.
 * @param resources 웹뷰 URI로 변환된 정적 리소스
 * @param nonce script 태그와 CSP가 공유하는 nonce
 * @param csp 문서 CSP 문자열
 * @param title 지역화된 패널 제목
 * @param i18n 웹뷰 client 문자열 사전
 * @returns 완성 HTML 문서
 */
function documentHtml(
  resources: CommitPlanResources,
  nonce: string,
  csp: string,
  title: string,
  i18n: CommitPlanI18n
): string {
  return `<!DOCTYPE html>
<html lang="${htmlAttribute(vscode.env.language)}">
${headHtml(resources, csp, title)}
<body>
  ${topbarHtml(title, i18n)}
  <main>
    ${promptHtml(i18n)}
    <section id="notice" class="notice" role="status" aria-live="polite" hidden></section>
    <section id="warnings" class="warnings" aria-label="${htmlAttribute(
      i18n.warnings
    )}" hidden></section>
    ${planHtml(i18n)}
  </main>
  ${footerHtml(i18n)}
  <script nonce="${nonce}">window.__gscCommitPlanI18n=${jsonForScript(
    i18n
  )};</script>
  <script nonce="${nonce}" src="${resources.tooltipScriptUri}"></script>
  <script nonce="${nonce}" src="${resources.scriptUri}"></script>
</body>
</html>`;
}

/**
 * 문서 metadata, CSP, codicon/패널/tooltip 스타일 링크를 만든다.
 * @param resources 웹뷰용 스타일 URI 묶음
 * @param csp 문서에 적용할 Content Security Policy
 * @param title 브라우저/웹뷰 문서 제목
 * @returns HTML head 문자열
 */
function headHtml(
  resources: CommitPlanResources,
  csp: string,
  title: string
): string {
  return `<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${htmlAttribute(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${resources.codiconUri}" rel="stylesheet" />
  <link href="${resources.styleUri}" rel="stylesheet" />
  <link href="${resources.tooltipStyleUri}" rel="stylesheet" />
  <title>${htmlText(title)}</title>
</head>`;
}

/**
 * 패널 제목/컨텍스트 요약과 설정/새로고침 toolbar를 만든다.
 * @param title 지역화된 패널 제목
 * @param i18n 버튼 tooltip/aria-label 문자열
 * @returns 상단 header HTML
 */
function topbarHtml(title: string, i18n: CommitPlanI18n): string {
  return `<header class="topbar">
  <div class="heading">
    <span class="codicon codicon-sparkle" aria-hidden="true"></span>
    <div>
      <h1>${htmlText(title)}</h1>
      <p id="context-summary" class="context-summary"></p>
    </div>
  </div>
  <div class="toolbar">
    ${iconButtonHtml("configure", "codicon-settings-gear", i18n.configure)}
    ${iconButtonHtml("refresh", "codicon-refresh", i18n.refresh)}
  </div>
</header>`;
}

/**
 * 선택 추가 프롬프트 입력과 AI 생성 버튼 영역을 만든다.
 * @param i18n 입력 안내/버튼 지역화 문자열
 * @returns prompt section HTML
 */
function promptHtml(i18n: CommitPlanI18n): string {
  const promptLabel = vscode.l10n.t("Additional prompt (optional)");
  const promptHelp = vscode.l10n.t(
    "Add instructions for this plan, such as grouping by feature or keeping tests with implementation."
  );
  return `<section class="prompt-card" aria-labelledby="prompt-label">
  <label id="prompt-label" for="additional-prompt">${htmlText(promptLabel)}</label>
  <p id="prompt-help" class="help">${htmlText(promptHelp)}</p>
  <textarea id="additional-prompt" rows="4" maxlength="12000"
    title="${htmlAttribute(promptLabel)}" aria-label="${htmlAttribute(promptLabel)}"
    aria-describedby="prompt-help" placeholder="${htmlAttribute(
      i18n.promptPlaceholder
    )}"></textarea>
  <div class="prompt-actions">
    <span id="intent-label" class="intent-label"></span>
    ${primaryButtonHtml(
      "generate",
      "codicon-sparkle",
      i18n.generate,
      '<span id="generate-label">' + htmlText(i18n.generate) + "</span>"
    )}
  </div>
</section>`;
}

/**
 * 계획 헤더와 비어 있음 안내, 동적 그룹 mount 지점을 만든다.
 * @param i18n 계획 제목/빈 상태 지역화 문자열
 * @returns plan section HTML
 */
function planHtml(i18n: CommitPlanI18n): string {
  return `<section class="plan-section" aria-labelledby="plan-title">
  <div class="section-heading">
    <h2 id="plan-title">${htmlText(i18n.planTitle)}</h2>
    <span id="plan-summary" class="plan-summary"></span>
  </div>
  <div id="empty-plan" class="empty-plan">${htmlText(i18n.noPlan)}</div>
  <div id="groups" class="groups"></div>
</section>`;
}

/**
 * plan 요약과 최종 실행 버튼을 고정 하단 action bar로 만든다.
 * @param i18n 실행 버튼 지역화 문자열
 * @returns footer HTML
 */
function footerHtml(i18n: CommitPlanI18n): string {
  return `<footer class="actionbar">
  <span id="footer-status" class="footer-status"></span>
  ${primaryButtonHtml(
    "execute",
    "codicon-git-commit",
    i18n.execute,
    `<span>${htmlText(i18n.execute)}</span>`,
    true
  )}
</footer>`;
}

/**
 * icon-only 보조 버튼에 tooltip/aria-label/data-tooltip을 모두 넣는다.
 * @param id DOM id
 * @param codicon 표시할 codicon class
 * @param label hover 및 스크린리더 문구
 * @returns 접근성 속성이 완비된 button HTML
 */
function iconButtonHtml(id: string, codicon: string, label: string): string {
  return `<button id="${htmlAttribute(id)}" class="icon-button secondary" type="button"
    title="${htmlAttribute(label)}" aria-label="${htmlAttribute(label)}"
    data-tooltip="${htmlAttribute(label)}">
    <span class="codicon ${htmlAttribute(codicon)}" aria-hidden="true"></span>
  </button>`;
}

/**
 * 텍스트가 포함된 primary 버튼의 공통 tooltip/접근성 속성을 만든다.
 * @param id DOM id
 * @param codicon 표시할 codicon class
 * @param label hover 및 스크린리더 문구
 * @param content icon 뒤에 넣을 이미 escape된 HTML
 * @param disabled 초기 disabled 속성 여부
 * @returns primary button HTML
 */
function primaryButtonHtml(
  id: string,
  codicon: string,
  label: string,
  content: string,
  disabled = false
): string {
  return `<button id="${htmlAttribute(id)}" class="primary ${htmlAttribute(
    id
  )}" type="button"${disabled ? " disabled" : ""}
    title="${htmlAttribute(label)}" aria-label="${htmlAttribute(label)}"
    data-tooltip="${htmlAttribute(label)}">
    <span class="codicon ${htmlAttribute(codicon)}" aria-hidden="true"></span>
    ${content}
  </button>`;
}

/** HTML 본문 텍스트에 들어갈 문자열의 특수문자를 이스케이프한다. */
function htmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** HTML 속성에 들어갈 문자열을 따옴표까지 포함해 이스케이프한다. */
function htmlAttribute(value: unknown): string {
  return htmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** inline script JSON이 script 종료 태그로 해석되지 않도록 `<` 문자를 unicode escape한다. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
