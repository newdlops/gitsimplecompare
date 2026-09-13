// 로컬 브랜치 현황의 지역화된 표시 모델과 공용 VS Code 테마 HTML을 만든다.
import * as vscode from "vscode";
import { basename } from "node:path";
import type { InspectedLocalBranch, StaleBranchInspection } from "../git/staleBranchService";
import { sharedWebviewResources, sharedWebviewScriptTags, sharedWebviewStyleTags } from "./sharedWebviewResources";
import { makeNonce, resourceVersion, withVersion } from "./webviewResourceVersion";

/**
 * 전체 로컬 브랜치 스냅샷을 표시 모델로 바꾸고 안전한 CSP/리소스와 결합한다.
 * @param extensionUri 설치된 확장 루트 @param webview URI 변환과 CSP 제공자
 * @param inspection Git 서비스가 만든 로컬 현황. 원격 전용 브랜치는 여기에 포함되지 않는다.
 * @returns 네트워크나 Git 명령을 직접 실행하지 않는 독립적인 현황 화면
 */
export function buildStaleBranchHtml(extensionUri: vscode.Uri, webview: vscode.Webview, inspection: StaleBranchInspection): string {
  const shared = sharedWebviewResources(webview, extensionUri);
  const media = vscode.Uri.joinPath(extensionUri, "media", "stale-branches");
  const script = vscode.Uri.joinPath(media, "staleBranches.js");
  const style = vscode.Uri.joinPath(media, "staleBranches.css");
  const version = resourceVersion([script, style]);
  const nonce = makeNonce();
  const t = vscode.l10n.t;
  const strings = {
    title: t("Local Branches"), branch: t("Local branch"), status: t("Status"), latest: t("Latest commit"),
    search: t("Search local branches"), filter: t("Branch status filter"), all: t("All local branches"), staleOnly: t("Stale only"),
    selectVisible: t("Select all visible removable stale branches"), clear: t("Clear selection"), cancel: t("Cancel"),
    review: t("Review deletion"), reviewHint: t("Review the selected local branch names before deleting"),
    selectHint: t("Select stale branches to review their deletion"), opening: t("Opening confirmation…"),
    selected: t("{0} selected"), hidden: t("{0} selected outside this filter"), shown: t("{0} of {1} local branches shown"),
    noMatches: t("No local branches match this search or filter."), noBranches: t("No local branches found."),
    summary: t("{0} local · {1} stale · {2} removable", inspection.localBranches.length, inspection.branches.length, inspection.branches.filter(branch => !branch.inUse).length),
    hint: t("Stale means this local branch name is absent from every remote. Branches in use are protected."),
    notice: !inspection.remotes.length ? t("No remotes are configured. Local branches are shown, but stale status cannot be checked.")
      : !inspection.branches.length ? t("No stale local branches. Every local branch name exists on a remote.")
      : inspection.branches.every(branch => branch.inUse) ? t("All stale local branches are in use by worktrees and cannot be deleted.") : "",
  };
  const data = { strings, branches: inspection.localBranches.map(localBranchRow) };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!DOCTYPE html>
<html lang="${html(vscode.env.language)}"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
${sharedWebviewStyleTags(shared)}
<link rel="stylesheet" href="${webview.asWebviewUri(withVersion(style, version))}" />
<title>${html(strings.title)}</title></head>
<body class="gsc-surface">
<header><div class="heading"><h1>${html(strings.title)}</h1><span class="repo" title="${html(inspection.repoRoot)}">${html(basename(inspection.repoRoot))}</span></div>
<p id="summary">${html(strings.summary)}</p><p class="hint">${html(strings.hint)}</p></header>
<section aria-label="${html(strings.filter)}"><div class="filters"><label class="gsc-field"><span class="gsc-field__label">${html(strings.search)}</span><input id="search" class="gsc-input" type="search" placeholder="${html(strings.search)}" /></label>
<label class="gsc-field"><span class="gsc-field__label">${html(strings.filter)}</span><select id="filter" class="gsc-select" title="${html(strings.filter)}"><option value="all">${html(strings.all)}</option><option value="stale">${html(strings.staleOnly)}</option></select></label></div>
<p id="notice" role="status"${strings.notice ? "" : " hidden"}>${html(strings.notice)}</p>
<p id="shown" class="hint" aria-live="polite"></p></section>
<main tabindex="0" aria-label="${html(strings.title)}"><table aria-label="${html(strings.title)}"><thead><tr>
<th class="selection-column"><input id="select-visible" type="checkbox" title="${html(strings.selectVisible)}" aria-label="${html(strings.selectVisible)}" /></th>
<th scope="col">${html(strings.branch)}</th><th scope="col" class="status-column">${html(strings.status)}</th><th scope="col" class="latest-column">${html(strings.latest)}</th>
</tr></thead><tbody id="branches"></tbody></table><p id="empty" hidden></p></main>
<footer><div class="selection-summary"><span id="selected" aria-live="polite"></span><span id="hidden-selection" class="hint" hidden></span><span id="error" role="alert" hidden></span></div>
<div class="actions">${button("cancel", strings.cancel)}${button("clear", strings.clear, true)}${button("review", strings.review, true, strings.selectHint, true)}</div></footer>
<script nonce="${nonce}">window.__gscStaleBranches=${json};</script>
${sharedWebviewScriptTags(shared, nonce)}
<script nonce="${nonce}" src="${webview.asWebviewUri(withVersion(script, version))}"></script>
</body></html>`;
}

/**
 * 로컬 이름을 유지하며 원격 존재 상태와 선택 불가 이유를 현재 언어로 조립한다.
 * @param branch 최신 로컬 브랜치 한 행 @returns UI에 필요한 문자열과 선택 가능 여부
 */
function localBranchRow(branch: InspectedLocalBranch) {
  const t = vscode.l10n.t;
  const stale = branch.remoteState === "absent";
  const status = stale ? t("Stale") : branch.remoteState === "present" ? t("On remote") : t("Not checked");
  const remote = branch.remoteState === "present" ? t("Remote: {0}", branch.matchingRemotes.join(", "))
    : stale ? t("No matching remote branch") : t("No remotes configured");
  const protection = branch.current ? t("Current branch — protected")
    : branch.inUse ? t("In use by worktree: {0}", branch.worktreePaths.join(", ")) : "";
  const selectable = stale && !branch.inUse;
  const reason = protection || (selectable ? "" : remote);
  const merge = branch.merged ? t("Merged into current HEAD") : t("Not merged into current HEAD");
  return { name: branch.name, hash: branch.hash.slice(0, 10), subject: branch.subject,
    stale, status, remote, protection, merge, selectable,
    selectionLabel: selectable ? t("Select local branch {0} for deletion review", branch.name)
      : t("Cannot select {0}: {1}", branch.name, reason),
  };
}

/** 고정 문자열·속성을 이스케이프해 브랜치 이름이나 경로가 HTML로 해석되지 않게 한다. */
function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 버튼의 표시 라벨·tooltip·접근성 이름과 초기 비활성 상태를 함께 만든다. */
function button(id: string, label: string, disabled = false, tooltip = label, primary = false): string {
  return `<button id="${id}" class="gsc-button${primary ? " gsc-button--primary" : ""}" type="button" title="${html(tooltip)}" data-tooltip="${html(tooltip)}" aria-label="${html(label)}"${disabled ? " disabled" : ""}>${html(label)}</button>`;
}
