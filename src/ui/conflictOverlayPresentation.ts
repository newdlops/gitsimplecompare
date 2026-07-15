// native conflict overlay가 표시할 문자열과 흐름 카드를 ConflictDocument에서 만든다.
// - Git 서비스는 구조화된 사실만 반환하고, operation 의미·최종 결과 문구·지역화는 UI 계층에 둔다.
import * as vscode from "vscode";
import type {
  ConflictDocument,
  ConflictSide,
  MergeOperation,
} from "../git/conflictService";

/** overlay 한 카드에서 commit 출처와 역할을 설명하는 직렬화 가능한 모델이다. */
export interface ConflictOverlayCard {
  tone: "current" | "incoming" | "result" | "future";
  title: string;
  identity: string;
  detail: string;
  secondary?: string;
  state?: string;
}

/** rebase 완료 뒤 파일 결과의 확실성을 전달하는 강조 영역이다. */
export interface ConflictOverlayImpact {
  tone: "info" | "success" | "warning";
  title: string;
  detail: string;
}

/** renderer가 textContent로 그릴 수 있도록 완전히 지역화한 overlay 표시 모델이다. */
export interface ConflictOverlayPresentation {
  title: string;
  operation: string;
  path: string;
  meta: string[];
  cards: ConflictOverlayCard[];
  impact: ConflictOverlayImpact;
  actions: {
    current: string;
    currentTooltip: string;
    incoming: string;
    incomingTooltip: string;
    both: string;
    bothTooltip: string;
    resolved: string;
    resolvedTooltip: string;
    mergeEditor: string;
    mergeEditorTooltip: string;
    reload: string;
    reloadTooltip: string;
    collapse: string;
    expand: string;
  };
  virtualNotice?: string;
}

interface OperationPresentation {
  currentTitle: string;
  incomingTitle: string;
  currentDetail: string;
  incomingDetail: string;
  resultDetail: string;
}

/**
 * 충돌 문서를 renderer가 해석 로직 없이 그릴 수 있는 지역화 모델로 바꾼다.
 * @param document 현재 index stage, Result 상태, operation/rebase 문맥
 * @returns 사용자 언어가 반영된 카드·메타데이터·버튼 문구
 */
export function buildConflictOverlayPresentation(
  document: ConflictDocument
): ConflictOverlayPresentation {
  const operation = operationPresentation(document);
  const rebase = document.context.rebase;
  const meta = rebase ? rebaseMeta(rebase) : operationMeta(document);
  const cards: ConflictOverlayCard[] = [
    sourceCard("current", operation.currentTitle, document.current, operation.currentDetail),
    sourceCard("incoming", operation.incomingTitle, document.incoming, operation.incomingDetail),
    {
      tone: "result",
      title: vscode.l10n.t("Proposed Result"),
      identity: vscode.l10n.t("working tree"),
      detail: operation.resultDetail,
      state: contentState(document.resultState),
    },
  ];
  if (rebase) {
    cards.push({
      tone: "future",
      title: vscode.l10n.t("{0} later commit(s)", rebase.remainingSteps),
      identity: futureSummary(rebase),
      detail: futureDetails(rebase),
    });
  }
  return {
    title: vscode.l10n.t("Resolve Conflict"),
    operation: operationLabel(document.operation),
    path: document.rel,
    meta,
    cards,
    impact: rebaseImpact(document),
    actions: actionLabels(),
    virtualNotice: document.resultState.kind === "text"
      ? undefined
      : virtualResultNotice(document),
  };
}

/** operation별 Current/Incoming의 의미와 Result 반영 시점을 만든다. */
function operationPresentation(document: ConflictDocument): OperationPresentation {
  if (document.operation === "rebase") {
    if (document.incoming.ref !== "REBASE_HEAD") {
      return {
        currentTitle: `${vscode.l10n.t("Current")} · ${vscode.l10n.t("Accumulated result")}`,
        incomingTitle: `${vscode.l10n.t("Incoming")} · ${nestedIncomingLabel(document.incoming.ref)}`,
        currentDetail: vscode.l10n.t("Whole-file choice: replaces Result with the accumulated rebase-side file and discards all Result edits plus this step's Incoming changes in this file."),
        incomingDetail: vscode.l10n.t("Stage 3 comes from a nested merge, cherry-pick, or revert inside rebase. Choosing it replaces the whole Result with this side."),
        resultDetail: vscode.l10n.t("Resolve the active nested operation with this working-tree Result; rebase continues afterward and later steps may still change it."),
      };
    }
    return {
      currentTitle: `${vscode.l10n.t("Current")} · ${vscode.l10n.t("Accumulated result")}`,
      incomingTitle: `${vscode.l10n.t("Incoming")} · ${vscode.l10n.t("Commit being replayed")}`,
      currentDetail: vscode.l10n.t("Whole-file choice: replaces Result with the accumulated rebase-side file and discards all Result edits plus this step's Incoming changes in this file."),
      incomingDetail: vscode.l10n.t("Whole-file choice: replaces Result with the entire file from the original commit being replayed and may discard accumulated or manual Result changes in this file."),
      resultDetail: vscode.l10n.t("Continue records this Result in the rewritten version of the current todo commit."),
    };
  }
  if (document.operation === "merge") {
    return standardPresentation(
      "Current branch before the operation",
      "Version from the commit being merged",
      "Content on HEAD before the merge result is recorded.",
      "Content from the merge target commit.",
      "Continuing the merge records this Result in the merge commit."
    );
  }
  if (document.operation === "cherry-pick") {
    return standardPresentation(
      "Current branch before the operation",
      "Version from the commit being cherry-picked",
      "Content on HEAD before the selected commit is applied.",
      "Content from the commit currently being cherry-picked.",
      "Continuing records this Result in the new cherry-pick commit."
    );
  }
  if (document.operation === "revert") {
    return standardPresentation(
      "Current branch before the operation",
      "Reverse side derived from the commit being reverted",
      "Content on HEAD before the reverse patch is recorded.",
      "Reverse side of the reverted change; it is not the REVERT_HEAD snapshot itself.",
      "Continuing records this Result in the new revert commit."
    );
  }
  return standardPresentation(
    "Index stage 2 (Ours)",
    "Index stage 3 (Theirs)",
    "Current/Ours content stored in index stage 2.",
    "Incoming/Theirs content stored in index stage 3.",
    "This working-tree Result is staged when you mark the file resolved."
  );
}

/** 일반 operation의 Current/Incoming/Result 카드 문구를 공통 형식으로 만든다. */
function standardPresentation(
  currentTitle: string,
  incomingTitle: string,
  currentDetail: string,
  incomingDetail: string,
  resultDetail: string
): OperationPresentation {
  return {
    currentTitle: `${vscode.l10n.t("Current")} · ${vscode.l10n.t(currentTitle)}`,
    incomingTitle: `${vscode.l10n.t("Incoming")} · ${vscode.l10n.t(incomingTitle)}`,
    currentDetail: vscode.l10n.t(currentDetail),
    incomingDetail: vscode.l10n.t(incomingDetail),
    resultDetail: vscode.l10n.t(resultDetail),
  };
}

/** rebase 안에서 실제 stage 3을 만든 nested operation 이름을 반환한다. */
function nestedIncomingLabel(ref: string): string {
  if (ref === "MERGE_HEAD") return vscode.l10n.t("Merge target inside rebase");
  if (ref === "CHERRY_PICK_HEAD") return vscode.l10n.t("Cherry-picked commit inside rebase");
  if (ref.includes("REVERT_HEAD")) return vscode.l10n.t("Reverse side inside rebase");
  return vscode.l10n.t("Active nested operation inside rebase");
}

/** 한 side의 ref/hash/subject와 파일별 마지막 변경 commit을 카드로 만든다. */
function sourceCard(
  tone: "current" | "incoming",
  title: string,
  side: ConflictSide,
  detail: string
): ConflictOverlayCard {
  const hash = shortHash(side.commit);
  const identity = [side.ref, hash, side.subject].filter(Boolean).join(" · ") ||
    vscode.l10n.t("commit metadata unavailable");
  const fileHash = shortHash(side.fileCommit);
  const secondary = fileHash && side.fileCommit !== side.commit
    ? vscode.l10n.t("This file was last changed by {0} {1}", fileHash, side.fileSubject || "")
    : undefined;
  return {
    tone,
    title,
    identity,
    secondary,
    detail,
    state: contentState(side),
  };
}

/** Result/stage의 특수 content 종류를 짧은 상태 문자열로 바꾼다. */
function contentState(value: { exists: boolean; kind: string; oid?: string; truncated?: boolean }): string | undefined {
  if (!value.exists || value.kind === "absent") return vscode.l10n.t("Deleted / absent on this side");
  if (value.kind === "binary") return vscode.l10n.t("Binary content cannot be shown as text");
  if (value.kind === "submodule") {
    return value.oid
      ? vscode.l10n.t("Submodule entry {0}", shortHash(value.oid))
      : vscode.l10n.t("Submodule working tree");
  }
  if (value.kind === "nonfile") return vscode.l10n.t("Directory or unsupported non-regular working-tree entry");
  if (value.kind === "symlink") return vscode.l10n.t("Symbolic link Result is shown read-only for path safety");
  if (value.truncated) return vscode.l10n.t("Large content is shown in the native editor without preview truncation");
  return undefined;
}

/** 일반 operation의 대상 commit을 상단 meta 문자열로 만든다. */
function operationMeta(document: ConflictDocument): string[] {
  const target = document.context.operationTarget;
  if (!target) return document.context.branch ? [document.context.branch] : [];
  return [
    `${vscode.l10n.t("Operation commit")}: ${[
      shortHash(target.commit || target.ref),
      target.subject,
    ].filter(Boolean).join(" · ")}`,
  ];
}

/** rebase 원본 tip/new base/current todo 위치를 줄바꿈 가능한 meta 배열로 만든다. */
function rebaseMeta(rebase: NonNullable<ConflictDocument["context"]["rebase"]>): string[] {
  const meta: string[] = [];
  if (rebase.branch) meta.push(`${vscode.l10n.t("Branch result")}: ${rebase.branch}`);
  if (rebase.originalHead?.commit) {
    meta.push(`${vscode.l10n.t("Original tip")}: ${identityText(rebase.originalHead)}`);
  }
  if (rebase.onto?.commit) {
    meta.push(`${vscode.l10n.t("New base")}: ${identityText(rebase.onto)}`);
  }
  if (rebase.currentStep) {
    const step = vscode.l10n.t("Step {0} of {1}", rebase.currentStep.index, rebase.currentStep.total);
    meta.push(rebase.currentStep.action ? `${step} · ${rebase.currentStep.action}` : step);
  }
  return meta;
}

/** 이후 같은 경로 변경 여부를 카드의 첫 줄로 만든다. */
function futureSummary(rebase: NonNullable<ConflictDocument["context"]["rebase"]>): string {
  if (rebase.futurePathChangeCount) {
    return vscode.l10n.t(
      "{0} later commit(s) touch this file and may change or conflict with it",
      rebase.futurePathChangeCount
    );
  }
  return rebase.futurePathAnalysisComplete
    ? vscode.l10n.t("No later todo commit changes this path")
    : vscode.l10n.t("Later path changes could not be determined safely");
}

/** 이후 동일 경로 commit 목록을 줄바꿈 문자열로 만든다. */
function futureDetails(rebase: NonNullable<ConflictDocument["context"]["rebase"]>): string {
  const lines = rebase.futurePathChanges.map((item) =>
    `${item.index} · ${item.action} · ${shortHash(item.commit || item.ref)} · ${item.subject || vscode.l10n.t("commit metadata unavailable")}`
  );
  if (rebase.futurePathChangesOmitted) {
    lines.push(vscode.l10n.t("+{0} more", rebase.futurePathChangesOmitted));
  }
  return lines.join("\n");
}

/** rebase future 분석 결과를 최종 결과 강조 문구로 만든다. */
function rebaseImpact(document: ConflictDocument): ConflictOverlayImpact {
  const rebase = document.context.rebase;
  if (!rebase) {
    return {
      tone: "info",
      title: vscode.l10n.t("Result after this step"),
      detail: operationPresentation(document).resultDetail,
    };
  }
  if (rebase.fileOutcome === "expected-final") {
    return {
      tone: "success",
      title: vscode.l10n.t("Expected to remain in the final branch"),
      detail: vscode.l10n.t("No remaining todo commit changes this path. Based on the current todo, this Result should remain when rebase finishes."),
    };
  }
  if (rebase.fileOutcome === "changed-later") {
    return {
      tone: "warning",
      title: vscode.l10n.t("Later commits still touch this file"),
      detail: vscode.l10n.t("Later todo commits touch this path after Continue. They may change the Result, become empty, or conflict again."),
    };
  }
  return {
    tone: "warning",
    title: vscode.l10n.t("Final file content cannot be predicted safely"),
    detail: vscode.l10n.t("The current edit/complex step, remaining exec steps, hooks, or path rewrites may change this file after Continue."),
  };
}

/** renderer 버튼의 label/title/aria-label에 함께 쓸 지역화 문자열을 만든다. */
function actionLabels(): ConflictOverlayPresentation["actions"] {
  return {
    current: vscode.l10n.t("Use Current"),
    currentTooltip: vscode.l10n.t("Replace the whole Result with exact Current (index stage 2) and mark resolved"),
    incoming: vscode.l10n.t("Use Incoming"),
    incomingTooltip: vscode.l10n.t("Replace the whole Result with exact Incoming (index stage 3) and mark resolved"),
    both: vscode.l10n.t("Use Both"),
    bothTooltip: vscode.l10n.t("Replace the whole Result by combining Current then Incoming conflict blocks and mark resolved"),
    resolved: vscode.l10n.t("Resolve Marked"),
    resolvedTooltip: vscode.l10n.t("Save the native Result document and stage the file as resolved"),
    mergeEditor: vscode.l10n.t("Native Merge Editor"),
    mergeEditorTooltip: vscode.l10n.t("Open this conflict in VS Code's native merge editor"),
    reload: vscode.l10n.t("Reload"),
    reloadTooltip: vscode.l10n.t("Reload conflict sources and the on-disk Result"),
    collapse: vscode.l10n.t("Collapse conflict context"),
    expand: vscode.l10n.t("Expand conflict context"),
  };
}

/** non-text Result를 virtual native editor로 연 이유와 허용된 작업을 설명한다. */
function virtualResultNotice(document: ConflictDocument): string {
  const kind = contentState(document.resultState) || document.resultState.kind;
  return vscode.l10n.t(
    "This Result is opened read-only for path and byte safety ({0}). Use an exact whole-file action above.",
    kind
  );
}

/** operation enum을 사용자 표시 이름으로 바꾼다. */
function operationLabel(operation: MergeOperation): string {
  if (operation === "merge") return vscode.l10n.t("merge");
  if (operation === "rebase") return vscode.l10n.t("rebase");
  if (operation === "cherry-pick") return vscode.l10n.t("cherry-pick");
  if (operation === "revert") return vscode.l10n.t("revert");
  return vscode.l10n.t("unmerged index");
}

/** commit identity를 hash와 subject가 모두 보이도록 합친다. */
function identityText(value: { ref: string; commit?: string; subject?: string }): string {
  return [shortHash(value.commit || value.ref), value.subject].filter(Boolean).join(" · ");
}

/** 긴 commit OID를 UI에서 판별 가능한 12자리로 줄인다. */
function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : "";
}
