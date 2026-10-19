// 선행 후보의 근거·검증 수준을 기존 VS Code 알림과 Quick Pick으로 설명한다.
import * as vscode from "vscode";
import type { PullRequestDependencyCandidate, PullRequestDependencyInput, PullRequestDependencyReport } from "../git/pullRequestDependencies";
import { PullRequestDependencyService } from "../git/pullRequestDependencyService";
import { logError, showOutputLog } from "./outputLog";

interface DependencyPick extends vscode.QuickPickItem { candidate?: PullRequestDependencyCandidate; output?: boolean }

/**
 * 원래 대상 snapshot으로 취소 가능한 진단을 실행한다. 실패해도 원래 Git 충돌 해결은 계속 사용할 수 있다.
 * @param root 원래 저장소 @param input 작업 시작 PR과 HEAD @returns 취소·진단 실패면 undefined
 */
export async function inspectPullRequestDependencies(root: string, input: PullRequestDependencyInput): Promise<PullRequestDependencyReport | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Checking prerequisites for PR #{0}", input.pr.number), cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await new PullRequestDependencyService(root).analyze({ ...input, signal: controller.signal }); }
      finally { listener.dispose(); }
    });
  } catch (error) {
    logError("PR prerequisite inspection stopped", error, { repoRoot: root, number: input.pr.number });
    return undefined;
  }
}

/**
 * 실제 충돌이 멈췄을 때 선행 후보 번호를 짧은 경고에 포함하고 자세한 근거로 연결한다.
 * @param root 원래 저장소 @param input 원래 작업의 snapshot @param fallback 기존 충돌·복구 안내
 */
export async function offerPullRequestDependencies(root: string, input: PullRequestDependencyInput, fallback: string): Promise<void> {
  const report = await inspectPullRequestDependencies(root, input);
  const verified = report?.candidates.filter(candidate => candidate.status === "resolves" || candidate.status === "reduces") || [];
  const possible = report?.candidates.filter(candidate => candidate.status === "unverified") || [];
  const candidates = verified.length ? verified : possible;
  const detail = verified.length
    ? vscode.l10n.t("Applying {0} first resolves or reduces this PR's conflicts in a simulation.", numbers(candidates))
    : possible.length ? vscode.l10n.t("Possible prerequisite PRs: {0}. Their necessity has not been verified.", numbers(candidates)) : "";
  const inspect = vscode.l10n.t("Inspect Prerequisites");
  const output = vscode.l10n.t("Show Output");
  const selected = await vscode.window.showWarningMessage([detail, fallback].filter(Boolean).join(" "), inspect, output);
  if (selected === inspect) {
    if (report) await showPullRequestDependencies(report);
    else vscode.window.showWarningMessage(vscode.l10n.t("Prerequisite inspection was cancelled or could not finish. The inspection did not change your working tree."));
  } else if (selected === output) showOutputLog(false);
}

/**
 * PR 번호·제목·현재 반영 여부·검증된 효과를 네이티브 목록에 표시한다.
 * @param report 고정된 원래 HEAD의 진단. 선택한 PR 링크만 열며 선행 PR을 자동 적용하지 않는다.
 */
export async function showPullRequestDependencies(report: PullRequestDependencyReport): Promise<void> {
  const picks: DependencyPick[] = report.candidates.map(candidate => ({
    label: `$(git-pull-request) #${candidate.pr.number} · ${statusText(candidate)}`,
    description: candidate.pr.title.replace(/\s+/g, " ").trim(),
    detail: `${reasonText(candidate)} · ${candidate.pr.url}`,
    candidate,
  }));
  const first = report.candidates.find(candidate => candidate.status === "resolves")
    || report.candidates.find(candidate => candidate.status === "reduces");
  if (first) picks.push({ label: vscode.l10n.t("Suggested order: #{0} → #{1}", first.pr.number, report.prNumber),
    detail: vscode.l10n.t("If paused, Return to Working Tree. Apply #{0}, then retry #{1}.", first.pr.number, report.prNumber) });
  if (!picks.length) picks.push({ label: vscode.l10n.t("No verified prerequisite PR was found"),
    detail: vscode.l10n.t("Conflicts can also come from independent edits or intentional deletions. This does not prove that the PR has no code dependencies.") });
  if (report.conflicts.length) picks.push({ label: vscode.l10n.t("Conflicting files: {0}", report.conflicts.length),
    detail: report.conflicts.slice(0, 3).map(path => path.replace(/\t/g, "\\t").replace(/\n/g, "\\n")).join(" · ") });
  if (report.limitations.length) picks.push({ label: `$(warning) ${vscode.l10n.t("Inspection is incomplete")}`,
    detail: report.limitations.includes("github")
      ? vscode.l10n.t("GitHub metadata was unavailable. Local candidates remain visible; check authentication or retry.")
      : vscode.l10n.t("Some source objects, history or simulations could not be checked within the inspection limits.") });
  picks.push({ label: `$(output) ${vscode.l10n.t("Show Output")}`, output: true,
    detail: vscode.l10n.t("See the inspected destination, candidate reasons and simulation results.") });
  picks.push({ label: vscode.l10n.t("Only Git application conflicts were checked"),
    detail: vscode.l10n.t("This is not an exhaustive dependency list. Build, tests and code review may reveal other prerequisites.") });
  const selected = await vscode.window.showQuickPick(picks, {
    title: vscode.l10n.t("PR #{0} prerequisites → {1}", report.prNumber, `${report.branch} @ ${report.beforeHead.slice(0, 10)}`),
    placeHolder: vscode.l10n.t("Select a PR to open it on GitHub. Review the order before applying changes."),
    matchOnDescription: true, matchOnDetail: true,
  });
  if (selected?.output) showOutputLog(false);
  if (selected?.candidate) {
    try {
      const url = new URL(selected.candidate.pr.url);
      if (url.protocol === "https:" && /\/pull\/[1-9]\d*\/?$/.test(url.pathname)) await vscode.env.openExternal(vscode.Uri.parse(url.href));
    } catch { /* 잘못된 외부 URL은 열지 않고 진단 결과를 그대로 유지한다. */ }
  }
}

/** 긴 제목 대신 PR 번호만 알림에 넣어 과도한 줄바꿈을 줄인다. */
function numbers(candidates: PullRequestDependencyCandidate[]): string { return candidates.map(candidate => `#${candidate.pr.number}`).join(", "); }

/** 후보 발견과 실제 적용 순서 검증을 혼동하지 않도록 상태를 표시한다. */
function statusText(candidate: PullRequestDependencyCandidate): string {
  switch (candidate.status) {
    case "resolves": return vscode.l10n.t("Apply first: conflicts resolved in simulation");
    case "reduces": return vscode.l10n.t("Apply first: {0} conflict(s) remain in simulation", candidate.remainingConflicts || 0);
    case "present": return vscode.l10n.t("Changes already satisfied on destination");
    case "unchanged": return vscode.l10n.t("Did not reduce the conflicts in simulation");
    case "unverified": return vscode.l10n.t("Possible prerequisite · unverified");
  }
}

/** 발견 근거를 사용자 언어로 표시하고 같은 파일만으로 필수 의존성을 단정하지 않는다. */
function reasonText(candidate: PullRequestDependencyCandidate): string {
  return candidate.reasons.map(reason => reason === "stack" ? vscode.l10n.t("PR base points to this branch")
    : reason === "declared" ? vscode.l10n.t("Declared as a prerequisite in the PR description")
      : vscode.l10n.t("Changed the source history of a conflicting file")).join(" · ");
}

/** 명시적인 진단 명령에서 취소·실패·빈 결과도 완료 상태와 구분해 안내한다. */
export async function checkPullRequestDependencies(root: string, input: PullRequestDependencyInput): Promise<void> {
  const report = await inspectPullRequestDependencies(root, input);
  if (report) await showPullRequestDependencies(report);
  else vscode.window.showWarningMessage(vscode.l10n.t("Prerequisite inspection was cancelled or could not finish. The inspection did not change your working tree."));
}
