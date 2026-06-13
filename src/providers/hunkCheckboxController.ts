// editable diff 의 Working Tree 비교 문서에 라인별 stage 체크박스를 제공한다.
// - checkbox UI 는 native overlay 로만 표시하고, fallback decoration/CodeLens 경로는 사용하지 않는다.
// - 체크 상태만 관리하고, 실제 부분 stage 는 DiffHunkService 의 선택 적용 로직을 재사용한다.
import * as vscode from "vscode";
import {
  DiffFile,
  DiffHunkService,
  HunkSelection,
} from "../git/diffHunkService";
import { buildWorkingContentWithoutStagedView } from "../git/unstagedView";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  activeHunkDiffTarget,
  activeHunkWorkingModifiedUri,
  refreshHunkDiffDocuments,
  type ActiveHunkDiffTarget,
} from "./hunkDiffContext";
import { CheckboxLine, checkboxLines } from "./hunkCheckboxLines";
import {
  activeTargetForModifiedUri,
  resolveFileTarget,
  targetToFileTarget,
  visibleHunkTargets,
} from "./hunkCheckboxTargets";
import { checkboxLinesForDisplayedDiff } from "./hunkVisibleLineMap";

export type HunkControlMode = "nativeOverlay" | "command";
type CheckedLineAction = "stage" | "unstage";

export interface HunkOverlayLine {
  side: "original" | "modified";
  line: number;
  lineIds: string[];
  checked: boolean;
}

export interface HunkOverlaySnapshot {
  originalUri: string;
  uri: string;
  path: string;
  action: CheckedLineAction;
  revision: number;
  lines: HunkOverlayLine[];
}

interface HunkFileContext {
  service: DiffHunkService;
  file: DiffFile;
  virtualUnstaged: boolean;
}

interface HunkOverlayBase {
  uri: string;
  path: string;
  action: CheckedLineAction;
  file: DiffFile;
  lines: CheckboxLine[];
}

interface VisibleLineRef {
  side: "original" | "modified";
  line: number;
  marker?: string;
}

const MODE_CONFIG = "hunkControlMode";
const MODES: HunkControlMode[] = ["nativeOverlay", "command"];

/** hunk checkbox 표시 방식과 체크 상태를 관리하는 컨트롤러. */
export class HunkCheckboxController {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly selected = new Map<string, Set<string>>();
  private revision = 0;
  private readonly baseCache = new Map<string, HunkOverlayBase | undefined>();

  readonly onDidChangeHunkControls = this.onDidChangeEmitter.event;

  constructor(private readonly registry: GitServiceRegistry) {}

  /** provider 와 상태 갱신 리스너를 등록한다. */
  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.tabGroups.onDidChangeTabs(() => this.requestRender()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.requestRender()),
      vscode.window.onDidChangeActiveTextEditor(() => this.requestRender()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.requestRender()),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`gitSimpleCompare.${MODE_CONFIG}`)) {
          this.requestRender();
        }
      })
    );
  }

  /**
   * 체크박스 한 줄의 선택 상태를 뒤집는다.
   * - renderer 가 클릭한 input 의 checked 상태를 이미 바꿨으므로 전체 overlay 재렌더는 하지 않는다.
   * @param uriString 대상 문서 URI 문자열
   * @param lineIds 해당 체크박스가 대표하는 diff line id 목록
   * @param checkedState renderer 가 보고한 실제 checked 값. 없으면 기존처럼 상태를 뒤집는다.
   */
  toggle(uriString: string, lineIds: string[], checkedState?: boolean): void {
    const picked = this.selectedFor(uriString);
    const nextChecked =
      checkedState ?? !lineIds.every((id) => picked.has(id));
    for (const id of lineIds) {
      if (nextChecked) {
        picked.add(id);
      } else {
        picked.delete(id);
      }
    }
    logInfo("hunk checkbox toggled", {
      uri: uriString,
      lineIds: lineIds.length,
      checked: nextChecked,
      selectedLineIds: picked.size,
    });
  }

  /**
   * renderer 가 보낸 VS Code marker 기준 줄을 git hunk line id 로 번역해 선택 상태를 바꾼다.
   * - 화면에는 marker row 마다 checkbox 를 만들고, 실제 적용은 여기서 찾은 line id 로 수행한다.
   * @param uriString 대상 diff 오른쪽 문서 URI 문자열
   * @param visible 사용자가 본 side/line/marker 정보
   * @param checkedState renderer 가 보고한 checked 값
   * @param fallbackLineIds snapshot 이 이미 알고 있던 line id. visible 재해석 실패 시에만 사용한다.
   */
  async toggleVisible(
    uriString: string,
    visible: VisibleLineRef,
    checkedState?: boolean,
    fallbackLineIds: string[] = []
  ): Promise<void> {
    const target = visibleHunkTargets().find(
      (item) => item.modified.toString() === uriString
    );
    const base = target ? await this.overlayBase(target) : undefined;
    const mappedLine = base?.lines.find(
      (item) => item.side === visible.side && item.line === visible.line
    );
    const lineIds = mappedLine?.lineIds.length
      ? mappedLine.lineIds
      : fallbackLineIds;
    if (!lineIds.length) {
      logWarn("hunk checkbox visible line unresolved", {
        uri: uriString,
        side: visible.side,
        line: visible.line,
        marker: visible.marker,
      });
      this.requestRender();
      return;
    }
    this.toggle(uriString, lineIds, checkedState);
  }

  /**
   * 현재 보이는 diff editor 들의 checkbox snapshot 을 만든다.
   * @returns editor group 별 active hunk diff 에 대응하는 snapshot 목록
   */
  async overlaySnapshots(): Promise<HunkOverlaySnapshot[]> {
    const targets = visibleHunkTargets();
    const snapshots = await Promise.all(
      targets.map((target) => this.snapshotForTarget(target))
    );
    return snapshots.filter((item): item is HunkOverlaySnapshot => !!item);
  }

  /**
   * renderer overlay 주입 성공 여부를 반영한다.
   * - fallback UI 를 만들지 않으므로 현재는 관찰용 hook 으로만 유지한다.
   * @param available renderer overlay 가 현재 동작 가능하면 true
   */
  setNativeOverlayAvailable(_available: boolean): void {}

  /** 현재 editable diff 에 체크된 line id 가 있는지 빠르게 확인한다. */
  hasCheckedForActiveDiff(): boolean {
    const uri = activeHunkWorkingModifiedUri();
    if (!uri) {
      return false;
    }
    return !!this.selected.get(uri.toString())?.size;
  }

  /**
   * 현재 editable diff 에서 체크된 라인만 index 에 stage 한다.
   * @param showNoopWarning 체크 대상이 없을 때 사용자 경고를 띄울지 여부
   * @returns 실제 stage 가 수행되었으면 true
   */
  async stageChecked(showNoopWarning = true): Promise<boolean> {
    return this.applyChecked("stage", showNoopWarning);
  }

  /**
   * 현재 staged diff 에서 체크된 라인만 index 에서 내린다.
   * @param showNoopWarning 체크 대상이 없을 때 사용자 경고를 띄울지 여부
   * @returns 실제 unstage 가 수행되었으면 true
   */
  async unstageChecked(showNoopWarning = true): Promise<boolean> {
    return this.applyChecked("unstage", showNoopWarning);
  }

  /**
   * 현재 diff 의 체크 라인을 stage 또는 unstage 로 적용한다.
   * @param action 적용할 index 동작
   * @param showNoopWarning 체크 대상이 없을 때 사용자 경고를 띄울지 여부
   */
  private async applyChecked(
    action: CheckedLineAction,
    showNoopWarning: boolean
  ): Promise<boolean> {
    const uri = activeHunkWorkingModifiedUri();
    if (!uri) {
      if (showNoopWarning) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Place the cursor in the changed side of the diff.")
        );
      }
      return false;
    }
    const picked = this.selected.get(uri.toString());
    if (!picked?.size) {
      if (showNoopWarning) {
        vscode.window.showWarningMessage(
          action === "stage"
            ? vscode.l10n.t("No checked lines to stage.")
            : vscode.l10n.t("No checked lines to unstage.")
        );
      }
      return false;
    }
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString()
    );
    if (document?.isDirty && document.uri.scheme === "file") {
      const saved = await document.save();
      if (!saved) {
        return false;
      }
    }
    const activeTarget = activeHunkDiffTarget();
    const context = await this.resolveContext(uri);
    if (!context) {
      return false;
    }
    const requiredStage = action === "stage" ? "unstaged" : "staged";
    if (context.file.stage !== requiredStage) {
      if (showNoopWarning) {
        vscode.window.showWarningMessage(
          action === "stage"
            ? vscode.l10n.t("Open an unstaged diff to stage checked lines.")
            : vscode.l10n.t("Open a staged diff to unstage checked lines.")
        );
      }
      return false;
    }
    const boxes = checkboxLines(context.file);
    const valid = new Set(boxes.flatMap((item) => item.lineIds));
    const lineIds = [...picked].filter((id) => valid.has(id));
    const checkedBoxes = boxes.filter((item) =>
      item.lineIds.every((id) => picked.has(id))
    ).length;
    const partialBoxes = boxes.filter(
      (item) =>
        item.lineIds.some((id) => picked.has(id)) &&
        !item.lineIds.every((id) => picked.has(id))
    ).length;
    logInfo(`checked hunk lines ${action} requested`, {
      path: context.file.path,
      stage: context.file.stage,
      hunks: context.file.hunks.length,
      checkboxLines: boxes.length,
      checkedBoxes,
      partialBoxes,
      pickedLineIds: picked.size,
      validLineIds: valid.size,
      selectedLineIds: lineIds.length,
    });
    if (!lineIds.length) {
      this.selected.delete(uri.toString());
      this.refresh();
      if (showNoopWarning) {
        vscode.window.showWarningMessage(
          action === "stage"
            ? vscode.l10n.t("No checked lines to stage.")
            : vscode.l10n.t("No checked lines to unstage.")
        );
      }
      return false;
    }
    const selection: HunkSelection = {
      stage: context.file.stage,
      path: context.file.path,
      hunkIds: [],
      lineIds,
      binary: false,
    };
    try {
      if (action === "stage") {
        await context.service.stageSelections([context.file], [selection]);
      } else {
        await context.service.unstageSelections([context.file], [selection]);
      }
      logInfo(`checked hunk lines ${action} applied`, {
        path: context.file.path,
        stage: context.file.stage,
        selectedLineIds: lineIds.length,
        checkedBoxes,
      });
      this.selected.delete(uri.toString());
      refreshHunkDiffDocuments(activeTarget);
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason: `hunkCheckbox:${action}`,
      });
      this.refresh();
      vscode.window.showInformationMessage(
        action === "stage"
          ? vscode.l10n.t("Checked line(s) staged.")
          : vscode.l10n.t("Checked line(s) unstaged.")
      );
      return true;
    } catch (error) {
      logError(`checked hunk lines ${action} failed`, error, {
        path: context.file.path,
        stage: context.file.stage,
        selectedLineIds: lineIds.length,
      });
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Action failed: {0}",
          error instanceof Error ? error.message : String(error)
        )
      );
      return false;
    }
  }

  /** 현재 editable diff 의 체크 상태를 모두 지우고 화면을 갱신한다. */
  clearChecked(): void {
    const uri = activeHunkWorkingModifiedUri();
    if (uri) {
      this.selected.delete(uri.toString());
    }
    this.requestRender();
  }

  /** 현재 선택된 hunk control UI 방식을 반환한다. */
  mode(): HunkControlMode {
    const mode = vscode.workspace
      .getConfiguration("gitSimpleCompare")
      .get<string>(MODE_CONFIG, "nativeOverlay");
    return isHunkControlMode(mode) ? mode : "nativeOverlay";
  }

  /** QuickPick 으로 hunk control UI 방식을 고르고 설정에 저장한다. */
  async chooseMode(): Promise<void> {
    const current = this.mode();
    const picked = await vscode.window.showQuickPick(
      [
        {
          mode: "nativeOverlay" as const,
          label: vscode.l10n.t("Native Overlay"),
          description: vscode.l10n.t("Real checkbox controls in the diff margin."),
          detail: vscode.l10n.t(
            "Uses the VS Code workbench renderer so checkbox clicks do not open hover popups."
          ),
        },
        {
          mode: "command" as const,
          label: vscode.l10n.t("Command Only"),
          description: vscode.l10n.t("No inline controls."),
          detail: vscode.l10n.t(
            "Keeps the native diff clean; use editor title/context commands."
          ),
        },
      ].map((item) => ({
        ...item,
        picked: item.mode === current,
      })),
      { title: vscode.l10n.t("Choose Hunk Control UI") }
    );
    if (!picked) {
      return;
    }
    await vscode.workspace
      .getConfiguration("gitSimpleCompare")
      .update(MODE_CONFIG, picked.mode, vscode.ConfigurationTarget.Global);
    this.requestRender();
  }

  /** 현재 모드의 라인 컨트롤 재계산을 요청한다. */
  refresh(): void {
    this.revision++;
    this.baseCache.clear();
    this.onDidChangeEmitter.fire();
  }

  /** checkbox 체크 상태만 바뀐 경우 git diff/표시 줄 매핑 캐시를 유지한 채 화면만 다시 그린다. */
  renderCheckedState(): void {
    this.requestRender();
  }

  /** git 재조회 없이 현재 checkbox 상태만 renderer 에 다시 전달한다. */
  private requestRender(): void {
    this.onDidChangeEmitter.fire();
  }

  /** 현재 active diff 의 git 기반 checkbox 원본 좌표를 캐시해 반환한다. */
  private async overlayBase(
    target: ActiveHunkDiffTarget
  ): Promise<HunkOverlayBase | undefined> {
    const uri = target.modified;
    const key = [
      uri.toString(),
      target.repoRoot,
      target.relPath,
      target.stage,
      this.revision,
    ].join("\0");
    if (this.baseCache.has(key)) {
      return this.baseCache.get(key);
    }
    const context = await this.resolveContext(uri, target);
    if (!context || context.file.binary) {
      this.baseCache.set(key, undefined);
      return undefined;
    }
    const base: HunkOverlayBase = {
      uri: uri.toString(),
      path: context.file.path,
      action: context.file.stage === "staged" ? "unstage" : "stage",
      file: context.file,
      lines: await this.overlayLines(context, target),
    };
    this.baseCache.set(key, base);
    return base;
  }

  /** URI 하나에 대한 renderer 전달용 snapshot 을 만든다. */
  private async snapshotForTarget(
    target: ActiveHunkDiffTarget
  ): Promise<HunkOverlaySnapshot | undefined> {
    const uri = target.modified;
    const key = uri.toString();
    const base = await this.overlayBase(target);
    if (!base) {
      return undefined;
    }
    this.pruneSelection(key, base.file);
    const picked = this.selected.get(key) ?? new Set<string>();
    return {
      originalUri: target.original.toString(),
      uri: base.uri,
      path: base.path,
      action: base.action,
      revision: this.revision,
      lines: base.lines.map((item) => ({
        side: item.side,
        line: item.line,
        lineIds: item.lineIds,
        checked: item.lineIds.every((id) => picked.has(id)),
      })),
    };
  }

  /** 문서 URI 에 해당하는 staged/unstaged diff 파일 컨텍스트를 찾는다. */
  private async resolveContext(
    uri: vscode.Uri,
    target?: ActiveHunkDiffTarget
  ): Promise<HunkFileContext | undefined> {
    const fromActive = activeTargetForModifiedUri(uri);
    const fromTarget = target ? targetToFileTarget(target) : undefined;
    const fileTarget =
      fromTarget ?? fromActive ?? (await resolveFileTarget(this.registry, uri));
    if (!fileTarget) {
      return undefined;
    }
    const service = new DiffHunkService(fileTarget.repoRoot);
    const files = await service.getFileWorkingDiff(fileTarget.relPath);
    const stage = "stage" in fileTarget ? fileTarget.stage : "unstaged";
    const file = files.find(
      (item) => item.stage === stage && item.path === fileTarget.relPath
    );
    return file
      ? { service, file, virtualUnstaged: fileTarget.virtualUnstaged ?? false }
      : undefined;
  }

  /**
   * 현재 표시 문서 기준의 checkbox 줄 좌표를 만든다.
   * - :unstaged 가상 문서는 working tree 에서 staged 줄을 제거한 내용이므로
   *   git diff 의 working/index 줄 번호를 그대로 쓰면 checkbox 가 아래로 밀린다.
   * @param context 현재 diff 파일 컨텍스트
   */
  private async overlayLines(
    context: HunkFileContext,
    target: ActiveHunkDiffTarget
  ): Promise<CheckboxLine[]> {
    try {
      const [leftText, rightText] = await Promise.all([
        this.documentText(target.original),
        this.documentText(target.modified),
      ]);
      const view =
        context.virtualUnstaged && context.file.stage === "unstaged"
          ? await this.virtualUnstagedView(context)
          : undefined;
      const mapped = checkboxLinesForDisplayedDiff(
        context.file,
        leftText,
        rightText,
        { virtualUnstagedView: view }
      );
      logInfo("hunk checkbox visible diff lines mapped", {
        path: context.file.path,
        stage: context.file.stage,
        virtualUnstaged: context.virtualUnstaged,
        displayLines: mapped.displayLines,
        gitLines: mapped.gitLines,
        mappedLines: mapped.lines.length,
        exactMapped: mapped.exactMapped,
        textMapped: mapped.textMapped,
        displayOnly: mapped.displayOnly,
        candidateOnly: mapped.candidateOnly,
        droppedGitLines: mapped.droppedGitLines,
      });
      return mapped.lines;
    } catch (error) {
      logError("hunk checkbox visible line map failed", error, {
        path: context.file.path,
      });
      return checkboxLines(context.file);
    }
  }

  /** VS Code 에 실제로 열린 문서 텍스트를 읽어 표시 diff 기준 입력으로 사용한다. */
  private async documentText(uri: vscode.Uri): Promise<string> {
    const opened = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString()
    );
    return (opened ?? (await vscode.workspace.openTextDocument(uri))).getText();
  }

  /** :unstaged 가상 문서에서 git index/working 줄을 표시 문서 줄로 옮기는 보정 정보를 만든다. */
  private async virtualUnstagedView(
    context: HunkFileContext
  ): Promise<ReturnType<typeof buildWorkingContentWithoutStagedView>> {
    const gitService = this.registry.get(context.service.repoRoot);
    const [head, index, working] = await Promise.all([
      gitService.getFileContentAtRef("HEAD", context.file.path),
      gitService.getFileContentAtRef(":0", context.file.path),
      context.service.readWorkingFile(context.file.path).catch(() => ""),
    ]);
    return buildWorkingContentWithoutStagedView(head, index, working);
  }

  /** 문서별 선택 set 을 얻는다. */
  private selectedFor(uriString: string): Set<string> {
    let picked = this.selected.get(uriString);
    if (!picked) {
      picked = new Set<string>();
      this.selected.set(uriString, picked);
    }
    return picked;
  }

  /** 현재 diff 에 존재하지 않는 오래된 line id 를 제거한다. */
  private pruneSelection(uriString: string, file: DiffFile): void {
    const picked = this.selected.get(uriString);
    if (!picked) {
      return;
    }
    const valid = new Set(checkboxLines(file).flatMap((item) => item.lineIds));
    for (const id of [...picked]) {
      if (!valid.has(id)) {
        picked.delete(id);
      }
    }
  }

}

/** 설정값이 지원하는 hunk control mode 인지 확인한다. */
function isHunkControlMode(value: string): value is HunkControlMode {
  return MODES.includes(value as HunkControlMode);
}
