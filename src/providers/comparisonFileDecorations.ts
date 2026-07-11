// 활성 비교의 파일 상태를 VS Code Explorer/탭 등 resource URI 기반 UI 에 표시한다.
// - 상태별 badge/색/툴팁 규칙과 URI 매칭을 한곳에 모아 SCM/비교 트리에서도 재사용한다.
// - git 조회나 비교 선택은 하지 않고 ComparisonController 의 스냅샷만 읽는다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComparisonSnapshot } from "../git/comparisonService";
import type { FileChange, FileChangeStatus } from "../git/gitTypes";
import { logInfo } from "../ui/outputLog";
import { ComparisonController } from "./comparisonController";

/** 상태별 표시 규칙. VS Code 기본 Git 색 토큰을 사용해 테마와 자연스럽게 맞춘다. */
export interface ComparisonStatusPresentation {
  /** Explorer 파일명 오른쪽에 표시할 한 글자 badge. */
  badge: string;
  /** 툴팁/스크린리더에 사용하는 사람이 읽을 상태명. */
  label: string;
  /** SCM/트리 아이콘에 사용할 ThemeIcon 식별자. */
  icon: string;
  /** VS Code 테마가 제공하는 Git decoration 전경색 식별자. */
  color: string;
}

/** 비교 diff 열기 명령이 받는 공통 인자 구조. */
export interface ComparisonDiffCommandArgs {
  /** 클릭 시점 비교를 다시 찾을 저장소 루트. */
  repoRoot: string;
  /** 사용자가 선택한 저장소 상대 파일 경로. */
  path: string;
}

/** 상태별 고정 badge/아이콘/색 규칙. label 은 l10n 적용을 위해 함수에서 만든다. */
const STATUS_VISUALS: Record<
  FileChangeStatus,
  Pick<ComparisonStatusPresentation, "badge" | "icon" | "color">
> = {
  A: {
    badge: "A",
    icon: "diff-added",
    color: "gitDecoration.addedResourceForeground",
  },
  M: {
    badge: "M",
    icon: "diff-modified",
    color: "gitDecoration.modifiedResourceForeground",
  },
  D: {
    badge: "D",
    icon: "diff-removed",
    color: "gitDecoration.deletedResourceForeground",
  },
  R: {
    badge: "R",
    icon: "diff-renamed",
    color: "gitDecoration.renamedResourceForeground",
  },
  C: {
    badge: "C",
    icon: "files",
    color: "gitDecoration.addedResourceForeground",
  },
  T: {
    badge: "T",
    icon: "symbol-file",
    color: "gitDecoration.modifiedResourceForeground",
  },
  U: {
    badge: "U",
    icon: "warning",
    color: "gitDecoration.conflictingResourceForeground",
  },
  X: {
    badge: "?",
    icon: "question",
    color: "gitDecoration.modifiedResourceForeground",
  },
  B: {
    badge: "?",
    icon: "question",
    color: "gitDecoration.modifiedResourceForeground",
  },
};

/**
 * 파일 변경 상태를 모든 비교 UI 가 공유하는 표시 규칙으로 변환한다.
 * @param status git diff --name-status 기반 변경 상태
 * @returns badge, 번역된 상태명, 아이콘, 테마 색 식별자
 */
export function getComparisonStatusPresentation(
  status: FileChangeStatus
): ComparisonStatusPresentation {
  const visual = STATUS_VISUALS[status] ?? STATUS_VISUALS.X;
  return {
    ...visual,
    label: statusLabel(status),
  };
}

/**
 * 파일 변경에 대응하는 작업트리 file URI 를 만든다.
 * - 삭제 파일도 실재 여부와 관계없이 URI 를 만들 수 있어 SCM/ghost 트리에 사용할 수 있다.
 * @param comparison 저장소 루트를 포함한 비교 스냅샷
 * @param change 변경 파일 한 건
 * @returns 저장소 루트와 현재 경로를 결합한 file URI
 */
export function comparisonChangeUri(
  comparison: Pick<ComparisonSnapshot, "repoRoot">,
  change: FileChange
): vscode.Uri {
  return vscode.Uri.file(path.resolve(comparison.repoRoot, change.path));
}

/**
 * file URI 를 현재 비교 저장소 기준의 슬래시 상대 경로로 바꾼다.
 * - `..` 또는 다른 드라이브처럼 저장소 밖인 URI 는 undefined 로 거부한다.
 * @param comparison 현재 비교 스냅샷
 * @param uri Explorer/에디터가 질의한 리소스 URI
 * @returns 저장소 내부 상대 경로, 외부/비-file URI 면 undefined
 */
export function comparisonRelativePath(
  comparison: Pick<ComparisonSnapshot, "repoRoot">,
  uri: vscode.Uri
): string | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const relative = path.relative(comparison.repoRoot, uri.fsPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return relative === "" ? "" : undefined;
  }
  return toGitPath(relative);
}

/**
 * 변경 파일에 표시할 상세 툴팁을 만든다.
 * - 상태, 비교 방향, rename/copy 원본, numstat 을 한 문자열에 포함한다.
 * @param comparison 기준/대상 label 과 ref 를 가진 비교 스냅샷
 * @param change 파일 변경 한 건
 * @returns Explorer/SCM/트리에서 함께 사용할 여러 줄 툴팁
 */
export function comparisonChangeTooltip(
  comparison: Readonly<ComparisonSnapshot>,
  change: FileChange
): string {
  const presentation = getComparisonStatusPresentation(change.status);
  const base = comparison.baseLabel || comparison.baseRef;
  const target = comparison.targetLabel || comparison.targetRef;
  const lines = [
    vscode.l10n.t("{0}: {1}", presentation.label, change.path),
    vscode.l10n.t("Comparison: {0} → {1}", base, target),
  ];
  if (change.oldPath && change.oldPath !== change.path) {
    lines.push(vscode.l10n.t("Previous path: {0}", change.oldPath));
  }
  const stats = formatChangeStats(change);
  if (stats) {
    lines.push(stats);
  }
  return lines.join("\n");
}

/**
 * Comparison Explorer 파일의 기본 클릭이 현재 상태에서 수행할 동작 이름을 만든다.
 * - ref가 없으면 안내만 가능하고, 현재 HEAD가 아니거나 삭제 파일이면 Diff를 연다.
 * - 작업파일을 열 수 있어도 VS Code 설정이 gutter를 숨기면 그 사실을 제목에 명시한다.
 * @param comparison 활성 비교의 ref/HEAD 가용성. 없으면 안전한 Diff 제목을 사용한다
 * @param deleted 작업트리에 대상 파일이 없는 삭제 변경인지 여부
 * @param gutterEnabled VS Code 설정이 라인 표시를 허용하는지 여부
 * @returns command title, tooltip, 접근성 이름에서 재사용할 지역화된 동작명
 */
export function comparisonFileOpenTitle(
  comparison:
    | Pick<ComparisonSnapshot, "diffAvailable" | "targetMatchesHead">
    | undefined,
  deleted: boolean,
  gutterEnabled: boolean
): string {
  if (comparison?.diffAvailable === false) {
    return vscode.l10n.t("Comparison file unavailable locally");
  }
  if (!comparison?.targetMatchesHead || deleted) {
    return vscode.l10n.t("Open Comparison Diff");
  }
  return gutterEnabled
    ? vscode.l10n.t("Open File with Comparison Markers")
    : vscode.l10n.t("Open File (line markers hidden)");
}

/**
 * 비교 diff 열기 명령에 전달할 독립 인자 객체를 만든다.
 * - 전체 snapshot 대신 저장소/경로 키만 전달해 대형 PR도 resource 수에 선형 메모리만 쓴다.
 * @param comparison 클릭 시점의 비교
 * @param change 클릭한 파일 변경
 * @returns gitSimpleCompare.openComparisonDiff 명령 인자
 */
export function makeComparisonDiffCommandArgs(
  comparison: ComparisonSnapshot,
  change: FileChange
): ComparisonDiffCommandArgs {
  return {
    repoRoot: comparison.repoRoot,
    path: change.path,
  };
}

/**
 * 현재 비교를 Explorer/탭 파일명 장식으로 제공한다.
 * - 파일 장식에 propagate=true 를 지정하고 상태 변경 시 조상 URI 도 함께 알린다.
 */
export class ComparisonFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  private readonly controllerSubscription: vscode.Disposable;
  private previousAffectedUris: vscode.Uri[] = [];
  private changeByUri = new Map<string, FileChange>();
  private disposed = false;

  /** FileDecorationProvider 가 장식을 다시 질의하도록 알리는 VS Code 이벤트. */
  readonly onDidChangeFileDecorations = this.changeEmitter.event;

  /**
   * controller 변경 이벤트를 구독하는 file decoration provider 를 만든다.
   * @param controller 활성 비교/토글 상태의 단일 소스
   */
  constructor(private readonly controller: ComparisonController) {
    this.previousAffectedUris = collectAffectedUris(
      controller.peekComparison(false)
    );
    this.rebuildChangeIndex();
    this.controllerSubscription = controller.onDidChangeComparison(() => {
      this.handleComparisonChanged();
    });
  }

  /**
   * URI 에 해당하는 비교 상태 badge/색/툴팁을 반환한다.
   * @param uri VS Code Explorer/탭이 표시하려는 리소스
   * @param token 계산 취소 신호
   * @returns 변경 파일이면 FileDecoration, 아니면 undefined
   */
  provideFileDecoration(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): vscode.FileDecoration | undefined {
    if (this.disposed || token.isCancellationRequested) {
      return undefined;
    }
    const comparison = this.controller.peekComparison(false);
    if (!comparison) {
      return undefined;
    }
    const change = this.changeByUri.get(uri.toString());
    if (!change) {
      return undefined;
    }
    const presentation = getComparisonStatusPresentation(change.status);
    const decoration = new vscode.FileDecoration(
      presentation.badge,
      comparisonChangeTooltip(comparison, change),
      new vscode.ThemeColor(presentation.color)
    );
    decoration.propagate = true;
    return decoration;
  }

  /**
   * controller 이벤트를 파일/조상 URI 목록으로 변환해 VS Code 에 전달한다.
   * - 이전 비교의 URI 도 포함해야 비교 교체/비활성화 때 남은 badge 가 제거된다.
   */
  private handleComparisonChanged(): void {
    if (this.disposed) {
      return;
    }
    const next = collectAffectedUris(this.controller.peekComparison(false));
    const affected = uniqueUris([...this.previousAffectedUris, ...next]);
    this.previousAffectedUris = next;
    this.rebuildChangeIndex();
    if (affected.length > 0) {
      this.changeEmitter.fire(affected);
    }
    logInfo("comparison file decorations refreshed", {
      enabled: this.controller.enabled,
      affected: affected.length,
    });
  }

  /**
   * controller 구독과 이벤트 emitter 를 해제한다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controllerSubscription.dispose();
    this.changeEmitter.dispose();
    this.previousAffectedUris = [];
    this.changeByUri.clear();
    logInfo("comparison file decoration provider disposed");
  }

  /** 활성 스냅샷을 file URI → FileChange 상수 시간 조회 맵으로 다시 만든다. */
  private rebuildChangeIndex(): void {
    this.changeByUri.clear();
    const comparison = this.controller.peekComparison(false);
    if (!comparison) {
      return;
    }
    for (const change of comparison.changes) {
      this.changeByUri.set(
        comparisonChangeUri(comparison, change).toString(),
        change
      );
    }
  }
}

/**
 * provider 생성과 VS Code 등록을 한 Disposable 로 묶는다.
 * @param controller 활성 비교 controller
 * @returns provider 와 등록 리소스를 함께 해제하는 Disposable
 */
export function registerComparisonFileDecorations(
  controller: ComparisonController
): vscode.Disposable {
  const provider = new ComparisonFileDecorationProvider(controller);
  const registration = vscode.window.registerFileDecorationProvider(provider);
  return vscode.Disposable.from(provider, registration);
}

/**
 * 상태 코드의 사람이 읽을 번역 문자열을 만든다.
 * @param status git 파일 변경 상태
 * @returns 런타임 l10n 이 적용된 상태명
 */
function statusLabel(status: FileChangeStatus): string {
  switch (status) {
    case "A":
      return vscode.l10n.t("Added");
    case "M":
      return vscode.l10n.t("Modified");
    case "D":
      return vscode.l10n.t("Deleted");
    case "R":
      return vscode.l10n.t("Renamed");
    case "C":
      return vscode.l10n.t("Copied");
    case "T":
      return vscode.l10n.t("Type changed");
    case "U":
      return vscode.l10n.t("Unmerged");
    case "B":
      return vscode.l10n.t("Broken pairing");
    case "X":
    default:
      return vscode.l10n.t("Unknown change");
  }
}

/**
 * numstat 기반 추가/삭제 줄 수를 짧은 번역 문자열로 만든다.
 * @param change additions/deletions 가 선택적으로 들어 있는 변경
 * @returns 통계가 있으면 `+n −m`, 없으면 빈 문자열
 */
function formatChangeStats(change: FileChange): string {
  if (change.additions === undefined && change.deletions === undefined) {
    return "";
  }
  return vscode.l10n.t(
    "Lines: +{0} −{1}",
    change.additions ?? 0,
    change.deletions ?? 0
  );
}

/**
 * 비교의 모든 변경 파일과 저장소 루트까지의 조상 URI 를 수집한다.
 * @param comparison 활성 비교, 비활성 상태면 undefined
 * @returns 중복이 제거된 file URI 목록
 */
function collectAffectedUris(
  comparison: Readonly<ComparisonSnapshot> | undefined
): vscode.Uri[] {
  if (!comparison) {
    return [];
  }
  const uris: vscode.Uri[] = [];
  const root = path.resolve(comparison.repoRoot);
  for (const change of comparison.changes) {
    const resource = comparisonChangeUri(comparison, change);
    uris.push(resource);
    let parent = path.dirname(resource.fsPath);
    while (isSameOrInside(root, parent)) {
      uris.push(vscode.Uri.file(parent));
      if (samePath(parent, root)) {
        break;
      }
      const next = path.dirname(parent);
      if (next === parent) {
        break;
      }
      parent = next;
    }
  }
  return uniqueUris(uris);
}

/**
 * URI 문자열을 키로 사용해 이벤트 대상 목록의 중복을 제거한다.
 * @param uris 중복될 수 있는 URI 배열
 * @returns 최초 등장 순서를 유지한 URI 배열
 */
function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  return uris.filter((uri) => {
    const key = uri.toString();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 플랫폼 경로가 저장소 루트 자신이거나 그 아래인지 검사한다.
 * @param root 정규화된 저장소 루트
 * @param candidate 검사할 절대 경로
 * @returns 루트 내부면 true
 */
function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * 플랫폼 경로 두 개가 정규화 후 같은지 검사한다.
 * @param left 첫 번째 경로
 * @param right 두 번째 경로
 * @returns 동일 경로면 true
 */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Windows 구분자를 git 상대 경로 표준인 슬래시로 변환한다.
 * @param value 변환할 상대 경로
 * @returns 비교 키에 사용할 정규화 경로
 */
function toGitPath(value: string): string {
  return value.split(path.sep).join("/");
}
