// 활성 비교를 VS Code Source Control 리소스 그룹과 에디터 Quick Diff 로 연결한다.
// - SCM 그룹은 비교 파일을 독립 목록으로 보여주며 삭제 항목에는 native strikeThrough 를 적용한다.
// - 대상이 현재 HEAD 와 일치할 때만 기준 ref 문서를 QuickDiff 원본으로 제공한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComparisonSnapshot } from "../git/comparisonService";
import type { FileChange, FileChangeStatus } from "../git/gitTypes";
import { logInfo } from "../ui/outputLog";
import { makeRefUri } from "../utils/uri";
import { ComparisonController } from "./comparisonController";
import {
  comparisonChangeTooltip,
  comparisonChangeUri,
  comparisonRelativePath,
  getComparisonStatusPresentation,
  makeComparisonDiffCommandArgs,
} from "./comparisonFileDecorations";

/** VS Code SCM 에 등록할 source control 식별자. */
export const COMPARISON_SOURCE_CONTROL_ID =
  "gitSimpleCompare.comparisonSourceControl";

/** 비교 변경 파일을 담는 resource group 식별자. */
export const COMPARISON_RESOURCE_GROUP_ID = "comparisonChanges";

/** 비교 항목을 클릭했을 때 실행할 명령 식별자. */
export const OPEN_COMPARISON_DIFF_COMMAND =
  "gitSimpleCompare.openComparisonDiff";

/** 비교 파일을 일반 작업파일 편집기로 여는 명령 식별자. */
export const OPEN_COMPARISON_FILE_COMMAND =
  "gitSimpleCompare.openComparisonFile";

/** status 정렬에서 사용자에게 익숙한 변경 종류 순서를 정의한다. */
const STATUS_ORDER: FileChangeStatus[] = [
  "A",
  "M",
  "R",
  "C",
  "T",
  "D",
  "U",
  "X",
  "B",
];

/**
 * VS Code 설정이 라인 번호 옆 native Quick Diff 표시를 허용하는지 확인한다.
 * - provider 등록 가능 여부와 별개로 사용자가 `none`/`overview`를 선택하면 gutter는 숨겨진다.
 * @returns `scm.diffDecorations`가 all 또는 gutter면 true
 */
export function editorGutterSettingAllowsMarkers(): boolean {
  const mode = vscode.workspace
    .getConfiguration("scm")
    .get<string>("diffDecorations", "all");
  return mode === "all" || mode === "gutter";
}

/**
 * ComparisonController 의 상태를 SCM/Quick Diff 표면에 투영한다.
 *
 * SourceControl.rootUri 는 읽기 전용이므로 비교 저장소가 바뀌면 기존 인스턴스를
 * 안전하게 dispose 하고 새 인스턴스를 만든다. 같은 저장소 안의 ref/파일 변경은
 * resourceStates 만 교체해 VS Code 선택 상태와 UI 비용을 보존한다.
 */
export class ComparisonScmProvider
  implements vscode.QuickDiffProvider, vscode.Disposable
{
  private sourceControlValue: vscode.SourceControl | undefined;
  private resourceGroup: vscode.SourceControlResourceGroup | undefined;
  private activeRepoRoot = "";
  private readonly changeByPath = new Map<string, FileChange>();
  private disposed = false;
  private readonly controllerSubscription: vscode.Disposable;

  /**
   * controller 를 구독하고 현재 비교가 있으면 즉시 SCM 그룹을 만든다.
   * @param controller 활성 비교/표시 토글의 단일 상태 소스
   */
  constructor(private readonly controller: ComparisonController) {
    this.controllerSubscription = controller.onDidChangeComparison(() => {
      this.synchronize("controllerEvent");
    });
    this.synchronize("activation");
    logInfo("comparison SCM provider activated", {
      enabled: controller.enabled,
      hasComparison: controller.hasComparison,
    });
  }

  /**
   * 현재 생성된 SourceControl 인스턴스를 진단/통합 코드에 제공한다.
   * @returns 비교가 활성 상태면 SourceControl, 아니면 undefined
   */
  get sourceControl(): vscode.SourceControl | undefined {
    return this.sourceControlValue;
  }

  /**
   * 작업트리 파일의 Quick Diff 기준 문서 URI 를 제공한다.
   * - targetMatchesHead 가 false 면 브랜치 간 비교가 현재 편집기 내용과 무관하므로 제공하지 않는다.
   * - rename/copy 는 기준 ref 에 새 경로가 없으므로 oldPath 를 우선 사용한다.
   * @param uri 에디터에 열린 작업트리 파일 URI
   * @param token VS Code 취소 신호
   * @returns 기준 ref 의 가상 문서 URI, 조건 불일치 시 undefined
   */
  provideOriginalResource(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): vscode.Uri | undefined {
    if (this.disposed || token.isCancellationRequested) {
      return undefined;
    }
    const comparison = this.controller.peekComparison(false);
    if (
      !comparison ||
      !comparison.targetMatchesHead ||
      !comparison.diffAvailable
    ) {
      return undefined;
    }
    const relativePath = comparisonRelativePath(comparison, uri);
    const change = relativePath
      ? this.changeByPath.get(relativePath)
      : undefined;
    if (!change) {
      return undefined;
    }
    const originalPath = change.oldPath || change.path;
    // 움직이는 branch 이름 대신 snapshot 생성 시 해석한 commit을 사용해
    // 파일 목록과 gutter 원본이 항상 같은 시점을 가리키게 한다.
    const originalRef = comparison.resolvedBaseHash || comparison.baseRef;
    const original = makeRefUri(
      originalRef,
      originalPath,
      comparison.repoRoot
    );
    return original;
  }

  /**
   * controller 구독과 현재 SourceControl/resource group 을 모두 해제한다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controllerSubscription.dispose();
    this.disposeSourceControl("providerDispose");
    logInfo("comparison SCM provider disposed");
  }

  /**
   * 활성 스냅샷을 현재 SourceControl 인스턴스와 동기화한다.
   * @param reason 활성화/토글/비교 변경처럼 동기화를 일으킨 원인
   */
  private synchronize(reason: string): void {
    if (this.disposed) {
      return;
    }
    const comparison = this.controller.getComparison(false);
    if (!comparison) {
      this.disposeSourceControl(reason);
      logInfo("comparison SCM refresh skipped", {
        reason,
        enabled: this.controller.enabled,
        hasComparison: this.controller.hasComparison,
      });
      return;
    }

    if (
      !this.sourceControlValue ||
      !sameFileSystemPath(this.activeRepoRoot, comparison.repoRoot)
    ) {
      this.createSourceControl(comparison, reason);
    }
    this.updateSourceControl(comparison, reason);
  }

  /**
   * 비교 저장소 루트에 묶인 SourceControl 과 resource group 을 새로 만든다.
   * @param comparison 새 SourceControl 이 표현할 비교
   * @param reason 재생성 원인
   */
  private createSourceControl(
    comparison: ComparisonSnapshot,
    reason: string
  ): void {
    this.disposeSourceControl("repoChanged");
    const rootUri = vscode.Uri.file(comparison.repoRoot);
    const sourceControl = vscode.scm.createSourceControl(
      COMPARISON_SOURCE_CONTROL_ID,
      vscode.l10n.t("Git Simple Compare"),
      rootUri
    );
    sourceControl.inputBox.visible = false;
    sourceControl.inputBox.enabled = false;

    const group = sourceControl.createResourceGroup(
      COMPARISON_RESOURCE_GROUP_ID,
      comparisonGroupLabel(comparison)
    );
    group.hideWhenEmpty = true;

    this.sourceControlValue = sourceControl;
    this.resourceGroup = group;
    this.activeRepoRoot = path.resolve(comparison.repoRoot);
    logInfo("comparison SourceControl created", {
      reason,
      repoRoot: comparison.repoRoot,
      kind: comparison.kind,
    });
  }

  /**
   * SourceControl 제목 정보와 resourceStates 를 최신 snapshot 으로 교체한다.
   * @param comparison 새로 표시할 비교 스냅샷
   * @param reason 동기화 원인
   */
  private updateSourceControl(
    comparison: ComparisonSnapshot,
    reason: string
  ): void {
    const sourceControl = this.sourceControlValue;
    const group = this.resourceGroup;
    if (!sourceControl || !group) {
      logInfo("comparison SCM update skipped", {
        reason,
        state: "sourceControlMissing",
      });
      return;
    }
    const changes = [...comparison.changes].sort(compareChangesForScm);
    this.rebuildQuickDiffIndex(comparison);
    group.label = comparisonGroupLabel(comparison);
    group.resourceStates = changes.map((change) =>
      this.makeResourceState(comparison, change)
    );
    // 비교 provider가 내장 Git의 Activity Bar 변경 수를 더하지 않도록 명시적으로 0을 둔다.
    sourceControl.count = 0;
    this.rebindQuickDiffProvider(sourceControl, comparison, reason);
    logInfo("comparison SCM resources refreshed", {
      reason,
      repoRoot: comparison.repoRoot,
      baseRef: comparison.baseRef,
      targetRef: comparison.targetRef,
      targetMatchesHead: comparison.targetMatchesHead,
      diffAvailable: comparison.diffAvailable,
      changes: changes.length,
      deleted: changes.filter((change) => change.status === "D").length,
    });
  }

  /**
   * 현재 비교 파일을 저장소 상대 경로로 색인해 QuickDiff hot path를 상수 시간으로 만든다.
   * @param comparison 새로 적용된 활성 비교 스냅샷
   */
  private rebuildQuickDiffIndex(comparison: ComparisonSnapshot): void {
    this.changeByPath.clear();
    for (const change of comparison.changes) {
      this.changeByPath.set(change.path, change);
    }
  }

  /**
   * 열린 편집기의 native dirty-diff 모델이 새 기준 commit을 즉시 다시 읽도록 provider를 재등록한다.
   * - 편집 가능한 현재 문서가 target과 같은 commit에서 출발할 때만 정확한 base→working diff가 된다.
   * @param sourceControl VS Code에 등록된 비교 SourceControl
   * @param comparison QuickDiff 활성 가능 여부와 기준 commit을 가진 스냅샷
   * @param reason OUTPUT 진단에 남길 controller 갱신 원인
   */
  private rebindQuickDiffProvider(
    sourceControl: vscode.SourceControl,
    comparison: ComparisonSnapshot,
    reason: string
  ): void {
    const available = comparison.targetMatchesHead && comparison.diffAvailable;
    // 같은 SourceControl 인스턴스에서 base만 바뀌어도 VS Code가 열린 문서를 재질의하도록
    // 먼저 해제한 뒤 다시 연결한다. target이 HEAD가 아니면 해제 상태를 유지한다.
    sourceControl.quickDiffProvider = undefined;
    if (available) {
      sourceControl.quickDiffProvider = this;
    }
    logInfo("comparison editor gutter provider refreshed", {
      reason,
      repoRoot: comparison.repoRoot,
      baseRef: comparison.resolvedBaseHash || comparison.baseRef,
      targetRef: comparison.targetRef,
      available,
      targetMatchesHead: comparison.targetMatchesHead,
      diffAvailable: comparison.diffAvailable,
      scmDiffDecorations: vscode.workspace
        .getConfiguration("scm")
        .get<string>("diffDecorations", "all"),
      indexedFiles: this.changeByPath.size,
    });
  }

  /**
   * 파일 변경 한 건을 클릭 가능하고 테마에 맞는 SCM resource state 로 만든다.
   * - 삭제 항목은 존재하지 않는 URI 여도 목록에 남기고 strikeThrough/faded 로 ghost 표시한다.
   * @param comparison 클릭 인자와 툴팁에 넣을 비교 컨텍스트
   * @param change 변환할 파일 변경
   * @returns SourceControlResourceGroup.resourceStates 에 넣을 상태 객체
   */
  private makeResourceState(
    comparison: ComparisonSnapshot,
    change: FileChange
  ): vscode.SourceControlResourceState {
    const presentation = getComparisonStatusPresentation(change.status);
    const deleted = change.status === "D";
    return {
      resourceUri: comparisonChangeUri(comparison, change),
      command: {
        command: OPEN_COMPARISON_DIFF_COMMAND,
        title: vscode.l10n.t("Open Comparison Diff"),
        arguments: [makeComparisonDiffCommandArgs(comparison, change)],
      },
      decorations: {
        iconPath: new vscode.ThemeIcon(
          presentation.icon,
          new vscode.ThemeColor(presentation.color)
        ),
        strikeThrough: deleted,
        faded: deleted,
        tooltip: comparisonChangeTooltip(comparison, change),
      },
      contextValue: `gitSimpleCompare.comparisonChange.${change.status}`,
    };
  }

  /**
   * 현재 resource group 과 SourceControl 을 순서대로 해제한다.
   * @param reason 비활성화/저장소 교체/dispose 등 해제 원인
   */
  private disposeSourceControl(reason: string): void {
    if (!this.sourceControlValue && !this.resourceGroup) {
      return;
    }
    const repoRoot = this.activeRepoRoot;
    this.resourceGroup?.dispose();
    this.sourceControlValue?.dispose();
    this.resourceGroup = undefined;
    this.sourceControlValue = undefined;
    this.activeRepoRoot = "";
    this.changeByPath.clear();
    logInfo("comparison SourceControl removed", { reason, repoRoot });
  }
}

/**
 * Source Control 그룹 상단에 표시할 기준/대상 label 을 만든다.
 * @param comparison label/ref 를 포함한 활성 비교
 * @returns `Changes: base → target` 형태의 번역 문자열
 */
function comparisonGroupLabel(comparison: ComparisonSnapshot): string {
  const base = comparison.baseLabel || comparison.baseRef;
  const target = comparison.targetLabel || comparison.targetRef;
  return vscode.l10n.t("Comparison: {0} → {1}", base, target);
}

/**
 * SCM 목록에서 상태 우선순위, 그다음 경로 순으로 정렬한다.
 * @param left 첫 번째 변경
 * @param right 두 번째 변경
 * @returns Array.sort 호환 비교 결과
 */
function compareChangesForScm(left: FileChange, right: FileChange): number {
  const statusDifference =
    statusOrder(left.status) - statusOrder(right.status);
  if (statusDifference !== 0) {
    return statusDifference;
  }
  return left.path.localeCompare(right.path);
}

/**
 * 상태 코드를 SCM 표시 우선순위 숫자로 바꾼다.
 * @param status git 파일 변경 상태
 * @returns 작을수록 먼저 표시되는 0-based 순위
 */
function statusOrder(status: FileChangeStatus): number {
  const index = STATUS_ORDER.indexOf(status);
  return index < 0 ? STATUS_ORDER.length : index;
}

/**
 * 저장소 루트 경로 두 개가 정규화 후 같은지 검사한다.
 * @param left 현재 SourceControl 루트
 * @param right 새 snapshot 루트
 * @returns 같은 경로면 true
 */
function sameFileSystemPath(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}
