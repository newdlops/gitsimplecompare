// native conflict Result가 가리키는 실제 작업트리 파일의 외부 변경을 감시한다.
// - glob watcher 대신 부모 디렉터리의 fs.watch와 정확한 basename 비교를 사용해 특수문자 경로를 안전하게 다룬다.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { logError, logInfo, logWarn } from "../ui/outputLog";

/** Result watcher가 구분해 전달하는 Node 파일시스템 이벤트 종류다. */
export type ConflictResultWatchReason = "change" | "rename";

/** Result watcher의 burst 병합 동작을 조절하는 선택 옵션이다. */
export interface ConflictResultWatcherOptions {
  /** 같은 파일에 연달아 들어온 change/rename 이벤트를 마지막 이벤트 하나로 합칠 시간(ms) */
  debounceMs?: number;
}

/** 외부 Result 변경을 controller에 전달하는 callback 계약이다. */
export type ConflictResultWatchCallback = (
  reason: ConflictResultWatchReason
) => void | Promise<void>;

const DEFAULT_DEBOUNCE_MS = 80;

/**
 * 실제 작업트리 Result 파일의 부모 디렉터리를 감시하고 대상 basename 이벤트만 전달한다.
 * - `fs.watch()`에 디렉터리 경로를 그대로 넘기므로 `[]`, `*`, `?` 같은 glob 특수문자를 해석하지 않는다.
 * - atomic save가 만드는 change/rename burst는 debounce한 마지막 reason 하나로 합친다.
 * - 파일이 rename으로 잠시 사라져도 부모 watcher를 유지하므로 같은 이름으로 다시 생성되는 이벤트를 계속 받는다.
 * @param absolutePath 감시할 실제 작업트리 파일의 절대 경로
 * @param onDidChange 대상 파일의 change/rename을 전달받을 callback
 * @param options debounce 시간 등 watcher 선택 옵션
 * @returns timer와 Node FSWatcher를 함께 닫는 VS Code Disposable
 */
export function watchConflictResultFile(
  absolutePath: string,
  onDidChange: ConflictResultWatchCallback,
  options: ConflictResultWatcherOptions = {}
): vscode.Disposable {
  const targetPath = path.resolve(absolutePath);
  const parentPath = path.dirname(targetPath);
  const targetName = path.basename(targetPath);
  const debounceMs = normalizeDebounceMs(options.debounceMs);
  let watcher: fs.FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingReason: ConflictResultWatchReason | undefined;
  let disposed = false;

  /**
   * debounce가 끝난 최신 이벤트를 callback으로 전달하고 동기/비동기 오류를 OUTPUT에 남긴다.
   * @returns 반환값은 없으며 callback Promise도 내부에서 관찰한다.
   */
  const publishPending = (): void => {
    timer = undefined;
    const reason = pendingReason;
    pendingReason = undefined;
    if (disposed || !reason) return;
    logInfo("conflict Result watcher change detected", {
      path: targetPath,
      reason,
    });
    try {
      void Promise.resolve(onDidChange(reason)).catch((error) => {
        logError("conflict Result watcher callback failed", error, {
          path: targetPath,
          reason,
        });
      });
    } catch (error) {
      logError("conflict Result watcher callback failed", error, {
        path: targetPath,
        reason,
      });
    }
  };

  /**
   * 정확히 같은 basename의 Node 이벤트를 debounce queue에 넣는다.
   * @param eventType Node fs.watch가 보고한 change 또는 rename
   * @param filename 부모 디렉터리 기준 이벤트 파일명. 플랫폼에 따라 null/Buffer일 수 있다.
   */
  const handleEvent = (
    eventType: ConflictResultWatchReason,
    filename: string | Buffer | null
  ): void => {
    if (disposed) return;
    if (filename === null) {
      logWarn("conflict Result watcher event skipped", {
        path: targetPath,
        eventType,
        reason: "filenameUnavailable",
      });
      return;
    }
    if (!matchesFilename(filename, targetName)) return;
    pendingReason = eventType;
    if (timer) clearTimeout(timer);
    timer = setTimeout(publishPending, debounceMs);
  };

  try {
    watcher = fs.watch(parentPath, { persistent: false }, handleEvent);
    watcher.on("error", (error) => {
      if (disposed) return;
      logError("conflict Result watcher failed", error, {
        path: targetPath,
        parentPath,
      });
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        pendingReason = undefined;
      }
      try {
        watcher?.close();
      } catch {
        // error 직후 이미 닫힌 watcher를 다시 닫는 실패는 close/error 로그로 충분하다.
      }
    });
    watcher.on("close", () => {
      logInfo("conflict Result watcher closed", {
        path: targetPath,
        parentPath,
        disposed,
      });
    });
    logInfo("conflict Result watcher started", {
      path: targetPath,
      parentPath,
      debounceMs,
    });
  } catch (error) {
    logError("conflict Result watcher start failed", error, {
      path: targetPath,
      parentPath,
    });
  }

  return new vscode.Disposable(() => {
    if (disposed) return;
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      pendingReason = undefined;
    }
    try {
      watcher?.close();
    } catch (error) {
      logError("conflict Result watcher close failed", error, {
        path: targetPath,
        parentPath,
      });
    }
  });
}

/**
 * fs.watch filename을 대상 basename과 대소문자·문자 단위로 정확히 비교한다.
 * @param filename Node가 문자열 또는 raw Buffer로 전달한 부모 기준 파일명
 * @param targetName 감시 대상 절대 경로에서 추출한 basename
 * @returns 두 파일명이 정확히 같으면 true
 */
function matchesFilename(filename: string | Buffer, targetName: string): boolean {
  return Buffer.isBuffer(filename)
    ? filename.equals(Buffer.from(targetName))
    : filename === targetName;
}

/**
 * 잘못된 debounce 값을 안전한 0 이상의 정수로 정규화한다.
 * @param value 호출자가 지정한 debounce 밀리초
 * @returns 유효한 정수 값 또는 기본 debounce 시간
 */
function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(0, Math.floor(value));
}
