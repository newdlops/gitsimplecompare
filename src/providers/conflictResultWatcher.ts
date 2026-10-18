// native conflict Result의 실제 작업트리 파일을 감시한다.
// - 같은 부모 디렉터리의 fs.watch를 공유하고 정확한 basename으로 구독을 찾는다.
// - 파일별 debounce와 구독 수명은 분리해 탭 하나를 닫아도 다른 탭을 계속 감시한다.
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

/** 파일 탭마다 독립적으로 유지하는 알림·debounce·해제 상태다. */
interface FileSubscription {
  targetPath: string;
  filenameKey: string;
  debounceMs: number;
  onDidChange: ConflictResultWatchCallback;
  directory?: DirectoryWatcher;
  timer?: ReturnType<typeof setTimeout>;
  pendingReason?: ConflictResultWatchReason;
  disposed: boolean;
}

/** 부모 폴더의 native handle 하나와 해당 폴더의 파일별 구독 색인이다. */
interface DirectoryWatcher {
  parentPath: string;
  watcher?: fs.FSWatcher;
  targets: Map<string, Set<FileSubscription>>;
  subscriptions: number;
  closed: boolean;
}

const DEFAULT_DEBOUNCE_MS = 80;
const directories = new Map<string, DirectoryWatcher>();

/**
 * 부모 디렉터리의 공유 watcher에서 대상 basename 이벤트만 구독한다.
 * - glob을 해석하지 않아 [], *, ?나 줄바꿈이 있는 파일명도 그대로 비교한다.
 * - atomic save 중 파일이 잠시 사라져도 부모 감시기를 유지해 재생성을 감지한다.
 * - 동일 파일의 여러 구독도 callback과 debounce 시간을 독립적으로 가진다.
 * @param absolutePath 감시할 실제 작업트리 파일의 절대 경로
 * @param onDidChange 대상 파일의 change/rename을 전달받을 callback
 * @param options debounce 시간 등 watcher 선택 옵션
 * @returns 자기 구독을 해제하고 폴더의 마지막 구독일 때 native handle도 닫는 Disposable
 */
export function watchConflictResultFile(
  absolutePath: string,
  onDidChange: ConflictResultWatchCallback,
  options: ConflictResultWatcherOptions = {}
): vscode.Disposable {
  const targetPath = path.resolve(absolutePath);
  const parentPath = path.dirname(targetPath);
  const subscription: FileSubscription = {
    targetPath,
    filenameKey: filenameKey(path.basename(targetPath)),
    debounceMs: normalizeDebounceMs(options.debounceMs),
    onDidChange,
    disposed: false,
  };
  const directory = getDirectoryWatcher(parentPath);
  if (directory) {
    subscription.directory = directory;
    let targets = directory.targets.get(subscription.filenameKey);
    if (!targets) {
      targets = new Set();
      directory.targets.set(subscription.filenameKey, targets);
    }
    targets.add(subscription);
    directory.subscriptions++;
    logInfo("conflict Result watcher started", {
      path: targetPath, parentPath, debounceMs: subscription.debounceMs,
      subscriptions: directory.subscriptions, directories: directories.size,
    });
  }
  return new vscode.Disposable(() => releaseSubscription(subscription));
}

/**
 * 살아 있는 폴더 watcher를 재사용하거나 native handle 하나를 생성한다.
 * @param parentPath 정규화한 부모 디렉터리의 절대 경로
 * @returns 공유 감시 상태. 시작 실패는 OUTPUT에 남기고 undefined를 반환한다.
 */
function getDirectoryWatcher(parentPath: string): DirectoryWatcher | undefined {
  const existing = directories.get(parentPath);
  if (existing) return existing;
  const directory: DirectoryWatcher = {
    parentPath, targets: new Map(), subscriptions: 0, closed: false,
  };
  try {
    directory.watcher = fs.watch(parentPath, { persistent: false, encoding: "buffer" },
      (reason, filename) => routeDirectoryEvent(directory, reason, filename));
    directory.watcher.on("error", error => {
      if (directory.closed) return;
      logError("conflict Result watcher failed", error, {
        parentPath, subscriptions: directory.subscriptions,
      });
      stopDirectoryWatcher(directory, "error", true);
    });
    directory.watcher.on("close", () => stopDirectoryWatcher(directory, "nativeClosed", false));
    directories.set(parentPath, directory);
    logInfo("conflict Result directory watcher started", { parentPath, directories: directories.size });
    return directory;
  } catch (error) {
    logError("conflict Result watcher start failed", error, { parentPath });
    stopDirectoryWatcher(directory, "startFailed", true);
    return undefined;
  }
}

/**
 * 폴더 이벤트를 파일명 색인으로 찾아 해당 파일의 구독에만 전달한다.
 * @param directory OS 이벤트가 발생한 공유 폴더 감시 상태
 * @param reason change 또는 rename 이벤트 종류
 * @param filename 부모 기준 raw 파일명. 이름이 없는 이벤트는 기존 정책대로 건너뛴다.
 */
function routeDirectoryEvent(
  directory: DirectoryWatcher,
  reason: ConflictResultWatchReason,
  filename: string | Buffer | null
): void {
  if (directory.closed) return;
  if (filename === null) {
    logWarn("conflict Result watcher event skipped", {
      parentPath: directory.parentPath, eventType: reason,
      reason: "filenameUnavailable", subscriptions: directory.subscriptions,
    });
    return;
  }
  const targets = directory.targets.get(filenameKey(filename));
  if (!targets) return;
  for (const subscription of targets) {
    if (subscription.disposed) continue;
    subscription.pendingReason = reason;
    if (subscription.timer !== undefined) clearTimeout(subscription.timer);
    subscription.timer = setTimeout(() => publishPending(subscription), subscription.debounceMs);
  }
}

/**
 * 파일별 debounce가 끝난 최신 이벤트를 전달하고 callback 오류를 격리한다.
 * @param subscription 변경이 예약된 파일 구독. 닫혔거나 감시기가 종료됐으면 전달하지 않는다.
 * @returns callback의 비동기 실패도 내부에서 관찰하므로 반환값은 없다.
 */
function publishPending(subscription: FileSubscription): void {
  subscription.timer = undefined;
  const reason = subscription.pendingReason;
  subscription.pendingReason = undefined;
  if (subscription.disposed || !subscription.directory || subscription.directory.closed || !reason) return;
  logInfo("conflict Result watcher change detected", { path: subscription.targetPath, reason });
  try {
    void Promise.resolve(subscription.onDidChange(reason)).catch(error => {
      logError("conflict Result watcher callback failed", error, { path: subscription.targetPath, reason });
    });
  } catch (error) {
    logError("conflict Result watcher callback failed", error, { path: subscription.targetPath, reason });
  }
}

/**
 * 파일 구독의 예약 알림과 폴더 색인만 해제하고 마지막 구독일 때 OS 감시기를 닫는다.
 * @param subscription 해제할 구독. 중복 호출이나 이미 실패한 감시기에도 안전하다.
 */
function releaseSubscription(subscription: FileSubscription): void {
  if (subscription.disposed) return;
  subscription.disposed = true;
  cancelPending(subscription);
  const directory = subscription.directory;
  subscription.directory = undefined;
  if (!directory || directory.closed) return;
  const targets = directory.targets.get(subscription.filenameKey);
  if (targets?.delete(subscription)) directory.subscriptions--;
  if (targets?.size === 0) directory.targets.delete(subscription.filenameKey);
  logInfo("conflict Result watcher closed", {
    path: subscription.targetPath, parentPath: directory.parentPath,
    subscriptions: directory.subscriptions,
  });
  if (directory.subscriptions === 0) stopDirectoryWatcher(directory, "unused", true);
}

/**
 * 파일 구독에 남은 timer와 이벤트를 함께 비워 닫힌 탭의 후속 조회를 막는다.
 * @param subscription 예약 알림을 취소할 파일 구독
 */
function cancelPending(subscription: FileSubscription): void {
  if (subscription.timer !== undefined) clearTimeout(subscription.timer);
  subscription.timer = undefined;
  subscription.pendingReason = undefined;
}

/**
 * 공유 감시기 종료 시 모든 예약을 취소하고 자신이 소유한 registry 항목만 해제한다.
 * - 이전 watcher의 늦은 close/error가 같은 폴더에 새로 만든 watcher를 지우지 않는다.
 * @param directory 종료할 공유 폴더 상태
 * @param reason 마지막 구독 해제, OS 오류/종료, 시작 실패 중 종료 원인
 * @param closeNative true면 native handle도 닫는다. native close 이벤트에서는 false다.
 */
function stopDirectoryWatcher(directory: DirectoryWatcher, reason: string, closeNative: boolean): void {
  if (directory.closed) return;
  directory.closed = true;
  if (directories.get(directory.parentPath) === directory) directories.delete(directory.parentPath);
  const subscriptions = directory.subscriptions;
  for (const targets of directory.targets.values()) {
    for (const subscription of targets) {
      cancelPending(subscription);
      subscription.directory = undefined;
    }
  }
  directory.targets.clear();
  directory.subscriptions = 0;
  if (closeNative) {
    try { directory.watcher?.close(); }
    catch (error) {
      logError("conflict Result watcher close failed", error, { parentPath: directory.parentPath });
    }
  }
  logInfo("conflict Result directory watcher closed", {
    parentPath: directory.parentPath, reason, subscriptions, directories: directories.size,
  });
}

/**
 * raw UTF-8 바이트를 보존하는 Map 키를 만들어 파일명 하나로 바로 구독을 찾는다.
 * - Buffer를 문자열로 디코딩하지 않아 잘못된 바이트가 U+FFFD 파일명으로 오인되지 않는다.
 * @param filename 문자열 경로의 basename 또는 fs.watch가 전달한 raw Buffer
 * @returns 바이트별로 유일한 base64 키. glob·대소문자 정규화는 하지 않는다.
 */
function filenameKey(filename: string | Buffer): string {
  return (Buffer.isBuffer(filename) ? filename : Buffer.from(filename)).toString("base64");
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
