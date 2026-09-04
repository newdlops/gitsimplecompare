// VS Code 디스크 캐시 정리 명령의 네이티브 UI 흐름.
// - 스캔, 선택, 명시적 확인, 진행 상태, 부분 실패와 재시작 안내를 조립한다.
// - 실제 파일 경계와 삭제는 system/vscodeCacheService에 위임한다.
import * as vscode from "vscode";
import type { CommandDeps } from "./shared";
import {
  VscodeCacheInspectionCancelledError,
  VscodeCacheService,
  type VscodeCacheCleanupResult,
  type VscodeCacheGroupId,
  type VscodeCacheGroupSnapshot,
  type VscodeCacheInspection,
  type VscodeCacheIssue,
} from "../system/vscodeCacheService";
import {
  logInfo,
  logWarn,
  showErrorWithOutput,
  showOutputLog,
} from "../ui/outputLog";

/** 캐시 묶음 스냅샷을 그대로 보존하는 다중 선택 Quick Pick 항목. */
interface CacheGroupQuickPickItem extends vscode.QuickPickItem {
  /** 선택 뒤 서비스 식별자와 스캔 크기를 다시 찾기 위한 원본 묶음. */
  group: VscodeCacheGroupSnapshot;
}

/** 같은 창에서 스캔/삭제가 겹쳐 서로의 크기 계산과 파일 삭제가 경합하지 않게 하는 플래그. */
let cacheCleanupInProgress = false;

/**
 * 명령 팔레트와 Git Simple Compare 뷰 제목 도구 모음에서 VS Code 캐시 정리 흐름을 시작한다.
 * - 모든 삭제 전 사용자가 캐시 그룹과 근사 크기를 확인하고 modal 버튼을 눌러야 한다.
 * - 실행 중인 다른 창이 다시 만드는 파일이나 잠긴 파일은 부분 실패로 정확히 보고한다.
 * @param deps globalStorageUri를 포함한 확장 공통 의존성
 * @returns 사용자가 취소하거나 결과 안내가 끝나면 resolve되는 Promise
 */
export async function cleanupVscodeCache(deps: CommandDeps): Promise<void> {
  if (cacheCleanupInProgress) {
    logInfo("VS Code cache cleanup skipped", { reason: "already-running" });
    await vscode.window.showInformationMessage(
      vscode.l10n.t("VS Code cache cleanup is already running.")
    );
    return;
  }

  cacheCleanupInProgress = true;
  try {
    await runCacheCleanup(deps);
  } catch (error) {
    if (error instanceof VscodeCacheInspectionCancelledError) {
      logInfo("VS Code cache inspection cancelled");
      return;
    }
    showErrorWithOutput(
      "VS Code cache cleanup failed",
      error,
      vscode.l10n.t(
        "Could not clean the VS Code cache: {0}",
        errorText(error)
      ),
      { remoteName: vscode.env.remoteName }
    );
  } finally {
    cacheCleanupInProgress = false;
  }
}

/**
 * 캐시 위치 확인부터 결과 알림까지 한 번의 명령 흐름을 실행한다.
 * @param deps 현재 확장 호스트의 globalStorageUri를 제공하는 공통 의존성
 * @returns 사용자 취소 또는 정리/안내가 완료되면 resolve되는 Promise
 */
async function runCacheCleanup(deps: CommandDeps): Promise<void> {
  // 최신 데스크톱 VS Code도 로컬 경로에 vscode-userdata 스킴을 사용할 수 있다.
  // Node 확장 호스트에서는 fsPath를 사용하고, 서비스가 표준 저장 구조와 삭제 루트를 다시 검증한다.
  const service = new VscodeCacheService(deps.globalStorageUri.fsPath);
  logInfo("VS Code cache inspection started", {
    userDataDir: service.userDataDir,
    storageScheme: deps.globalStorageUri.scheme,
    remoteName: vscode.env.remoteName,
  });
  const inspection = await inspectWithProgress(service);
  logIssues("VS Code cache inspection skipped a path", inspection.issues);
  logInfo("VS Code cache inspection completed", {
    userDataDir: inspection.userDataDir,
    bytes: totalBytes(inspection.groups),
    entries: inspection.groups.reduce(
      (total, group) => total + group.entries,
      0
    ),
    issues: inspection.issues.length,
  });

  const available = inspection.groups.filter(
    (group) => group.entries > 0 || group.bytes > 0
  );
  if (available.length === 0) {
    await showEmptyResult(inspection);
    return;
  }

  const selected = await vscode.window.showQuickPick<CacheGroupQuickPickItem>(
    available.map(cacheGroupQuickPickItem),
    {
      title: vscode.l10n.t("Clean VS Code Cache"),
      placeHolder: vscode.l10n.t(
        "Select cache groups to remove. Settings, installed extensions, projects, and workspace state are preserved."
      ),
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (selected === undefined) {
    logInfo("VS Code cache cleanup cancelled", { stage: "selection" });
    return;
  }
  if (selected.length === 0) {
    await vscode.window.showInformationMessage(
      vscode.l10n.t("Select at least one cache group to clean.")
    );
    return;
  }

  const groupIds = selected.map((item) => item.group.id);
  const selectedBytes = totalBytes(selected.map((item) => item.group));
  if (!(await confirmCleanup(groupIds, selectedBytes))) {
    logInfo("VS Code cache cleanup cancelled", { stage: "confirmation" });
    return;
  }

  logInfo("VS Code cache cleanup started", {
    userDataDir: inspection.userDataDir,
    groupIds,
    requestedBytes: selectedBytes,
    remoteName: vscode.env.remoteName,
  });
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Cleaning VS Code cache..."),
      cancellable: false,
    },
    () => service.cleanup(groupIds, inspection)
  );
  logIssues("VS Code cache cleanup left a path", result.issues);
  logInfo("VS Code cache cleanup completed", {
    userDataDir: inspection.userDataDir,
    groupIds: result.groupIds,
    requestedBytes: result.requestedBytes,
    reclaimedBytes: result.reclaimedBytes,
    remainingBytes: result.remainingBytes,
    removedEntries: result.removedEntries,
    issues: result.issues.length,
  });
  await showCleanupResult(result);
}

/**
 * 취소 가능한 진행 알림 안에서 재귀 캐시 크기 탐색을 실행한다.
 * @param service 현재 VS Code user-data-dir에 고정된 캐시 서비스
 * @returns 선택 UI에 표시할 전체 캐시 스냅샷
 */
function inspectWithProgress(
  service: VscodeCacheService
): Thenable<VscodeCacheInspection> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Scanning VS Code cache..."),
      cancellable: true,
    },
    (_progress, token) =>
      service.inspect(() => token.isCancellationRequested)
  );
}

/**
 * 캐시 그룹 스냅샷을 크기/항목 수/실제 경로가 보이는 기본 선택 행으로 바꾼다.
 * @param group 서비스가 측정한 캐시 묶음
 * @returns 다중 선택 Quick Pick에서 기본 체크된 접근 가능한 행
 */
function cacheGroupQuickPickItem(
  group: VscodeCacheGroupSnapshot
): CacheGroupQuickPickItem {
  const presentation = cacheGroupPresentation(group.id);
  const paths = group.targets
    .filter((target) => target.entries > 0 || target.bytes > 0)
    .map((target) => target.relativePath)
    .join(", ");
  return {
    label: `${presentation.icon} ${presentation.label}`,
    description: vscode.l10n.t(
      "{0} · {1} item(s)",
      formatBytes(group.bytes),
      group.entries
    ),
    detail: vscode.l10n.t("{0} Paths: {1}", presentation.detail, paths),
    picked: true,
    alwaysShow: true,
    group,
  };
}

/**
 * 안정적인 그룹 ID를 네이티브 Quick Pick의 이름, 아이콘, 설명으로 매핑한다.
 * @param groupId 서비스 캐시 묶음 식별자
 * @returns VS Code 제품 UI 어휘를 따르는 표시 메타데이터
 */
function cacheGroupPresentation(groupId: VscodeCacheGroupId): {
  icon: string;
  label: string;
  detail: string;
} {
  switch (groupId) {
    case "workbench":
      return {
        icon: "$(window)",
        label: vscode.l10n.t("Workbench cache"),
        detail: vscode.l10n.t(
          "Startup data, configuration copies, and HTTP resources."
        ),
      };
    case "renderer":
      return {
        icon: "$(device-desktop)",
        label: vscode.l10n.t("Renderer and GPU cache"),
        detail: vscode.l10n.t(
          "Compiled JavaScript and regenerable graphics data."
        ),
      };
    case "webview":
      return {
        icon: "$(browser)",
        label: vscode.l10n.t("Webview cache"),
        detail: vscode.l10n.t(
          "Service worker scripts and cached web resources."
        ),
      };
    case "extensions":
      return {
        icon: "$(extensions)",
        label: vscode.l10n.t("Extension download cache"),
        detail: vscode.l10n.t(
          "Downloaded VSIX packages and extension metadata; installed extensions stay intact."
        ),
      };
  }
}

/**
 * 선택한 그룹과 크기를 보여 주고 데이터 보존 범위를 modal 상세 설명으로 확인받는다.
 * @param groupIds 정리 대상으로 선택한 그룹 ID 목록
 * @param bytes 스캔에서 계산한 근사 대상 크기
 * @returns 사용자가 위험 동작 버튼을 명시적으로 선택했으면 true
 */
async function confirmCleanup(
  groupIds: readonly VscodeCacheGroupId[],
  bytes: number
): Promise<boolean> {
  const clean = vscode.l10n.t("Clean Cache");
  const details = [
    vscode.env.remoteName
      ? vscode.l10n.t(
          "This cleans the active remote extension host cache ({0}); the local desktop cache is not affected.",
          vscode.env.remoteName
        )
      : undefined,
    vscode.l10n.t(
      "Settings, installed extensions, projects, workspace state, and backups are kept."
    ),
    vscode.l10n.t(
      "Other open VS Code windows can recreate active cache files. Close them and run this command again if space remains."
    ),
  ].filter((line): line is string => Boolean(line));
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Remove approximately {0} from {1} selected cache group(s)?",
      formatBytes(bytes),
      groupIds.length
    ),
    { modal: true, detail: details.join("\n\n") },
    clean
  );
  return choice === clean;
}

/**
 * 삭제 가능한 항목이 없을 때 정상 빈 상태와 탐색 실패 상태를 구분해 안내한다.
 * @param inspection 캐시 탐색 결과
 * @returns 알림 선택 처리가 끝나면 resolve되는 Promise
 */
async function showEmptyResult(
  inspection: VscodeCacheInspection
): Promise<void> {
  if (inspection.issues.length === 0) {
    await vscode.window.showInformationMessage(
      vscode.l10n.t("No removable VS Code cache was found.")
    );
    return;
  }
  const showOutput = vscode.l10n.t("Show Output");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "No removable VS Code cache could be read. Check the output for skipped paths."
    ),
    showOutput
  );
  if (choice === showOutput) {
    showOutputLog(false);
  }
}

/**
 * 성공, 실행 중 재생성, 실제 파일 실패를 나눠 결과와 다음 행동을 안내한다.
 * @param result 서비스가 계산한 정리 전후 결과
 * @returns 사용자가 고른 Reload/Output 후속 동작이 끝나면 resolve되는 Promise
 */
async function showCleanupResult(
  result: VscodeCacheCleanupResult
): Promise<void> {
  const reload = vscode.l10n.t("Reload Window");
  const showOutput = vscode.l10n.t("Show Output");
  let choice: string | undefined;
  if (result.issues.length > 0) {
    choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Freed approximately {0}, but {1} cache path(s) could not be cleaned. Close all VS Code windows and try again if needed.",
        formatBytes(result.reclaimedBytes),
        result.issues.length
      ),
      reload,
      showOutput
    );
  } else if (result.remainingBytes > 0) {
    choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Freed approximately {0}; {1} was recreated or remained in active caches.",
        formatBytes(result.reclaimedBytes),
        formatBytes(result.remainingBytes)
      ),
      reload,
      showOutput
    );
  } else {
    choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "VS Code cache cleanup finished. Freed approximately {0}.",
        formatBytes(result.reclaimedBytes)
      ),
      reload
    );
  }
  if (choice === reload) {
    logInfo("VS Code window reload requested after cache cleanup");
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else if (choice === showOutput) {
    showOutputLog(false);
  }
}

/**
 * 캐시 문제를 개별 구조화 로그로 남겨 권한/잠금/경로 안전 실패를 재현 가능하게 한다.
 * @param message 같은 단계의 issue를 설명할 로그 이름
 * @param issues 서비스가 반환한 경로별 문제 목록
 * @returns 반환값 없음
 */
function logIssues(message: string, issues: readonly VscodeCacheIssue[]): void {
  for (const entry of issues) {
    logWarn(message, {
      groupId: entry.groupId,
      relativePath: entry.relativePath,
      stage: entry.stage,
      error: entry.message,
    });
  }
}

/**
 * 캐시 그룹들의 근사 바이트를 합산한다.
 * @param groups 전체 또는 사용자가 선택한 캐시 그룹 목록
 * @returns 그룹 bytes 합계
 */
function totalBytes(groups: readonly VscodeCacheGroupSnapshot[]): number {
  return groups.reduce((total, group) => total + group.bytes, 0);
}

/**
 * 바이트 수를 Quick Pick과 알림에서 읽기 쉬운 이진 단위 문자열로 바꾼다.
 * @param bytes 0 이상의 근사 논리 바이트 수
 * @returns B, KB, MB, GB, TB 중 적절한 단위를 사용한 문자열
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

/**
 * 알 수 없는 throw 값을 사용자 알림에 넣을 짧은 한 줄로 바꾼다.
 * @param error Error 또는 임의 throw 값
 * @returns 사람이 읽을 오류 메시지
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
