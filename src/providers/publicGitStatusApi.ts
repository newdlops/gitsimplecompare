import * as vscode from "vscode";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ComparisonController } from "./comparisonController";
import type { GitSimpleCompareApi } from "../extensionApi";
import { invalidateWorkingTreeSnapshot, onWorkingTreeSnapshotInvalidated, readWorkingTreeSnapshot } from "../git/workingTreeSnapshot";

interface PublicRoot { watchers: vscode.Disposable[]; ready: Promise<void>; disposed: boolean }
const roots = new Map<string, PublicRoot>();
let closed = false;

/** deactivate 동안 새 API 조회와 metadata 감시를 멈춰 cache dispose 뒤 재생성을 막는다. */
export function shutdownPublicGitStatusApi(): void {
  closed = true;
  for (const state of roots.values()) { state.disposed = true; state.watchers.forEach(watcher => watcher.dispose()); }
  roots.clear();
}

/** 공개 API만 사용하는 저장소도 기존 metadata 이벤트의 관련 root 범위에 포함한다. */
export function publicGitStatusRoots(): string[] { return [...roots.keys()]; }

/**
 * 비교 계약 v1과 선택적인 공유 작업 상태 API를 조립하며 구독 수명을 extension에 묶는다.
 * @param context 이벤트 emitter와 공유 서비스 알림을 해제할 확장 컨텍스트
 * @param comparison 기존 비교 계약을 그대로 제공하는 controller
 * @returns 오래된 Tab Manager와도 호환되는 API
 */
export function createPublicGitStatusApi(context: vscode.ExtensionContext, comparison: ComparisonController, registerRoot: (root: string) => void): GitSimpleCompareApi {
  closed = false;
  const changed = new vscode.EventEmitter<string>();
  const release = onWorkingTreeSnapshotInvalidated(root => changed.fire(root));
  /** 연결된 root의 좁은 Git metadata만 감시하며 광범위 작업트리 watcher는 추가하지 않는다. */
  const track = async (repoRoot: string) => {
    const root = path.resolve(repoRoot); registerRoot(root);
    let state = roots.get(root);
    if (!state) {
      if (roots.size >= 32) {
        const oldest = roots.entries().next().value;
        if (oldest) { oldest[1].disposed = true; oldest[1].watchers.forEach(watcher => watcher.dispose()); roots.delete(oldest[0]); }
      }
      state = { watchers: [], disposed: false, ready: Promise.resolve() }; roots.set(root, state);
      state.ready = watchMetadata(root, state);
    }
    await state.ready;
  };
  /** VS Code 명시적 파일 이벤트가 API-only root의 완료 캐시도 즉시 무효화하게 한다. */
  const changedFiles = (uris: readonly vscode.Uri[]) => {
    for (const root of roots.keys()) if (uris.some(uri => uri.scheme === "file" && (uri.fsPath === root || uri.fsPath.startsWith(root + path.sep)))) invalidateWorkingTreeSnapshot(root);
  };
  context.subscriptions.push(changed, new vscode.Disposable(() => {
    release(); shutdownPublicGitStatusApi();
  }), vscode.workspace.onDidSaveTextDocument(document => changedFiles([document.uri])),
  vscode.workspace.onDidCreateFiles(event => changedFiles(event.files)), vscode.workspace.onDidDeleteFiles(event => changedFiles(event.files)),
  vscode.workspace.onDidRenameFiles(event => changedFiles(event.files.flatMap(file => [file.oldUri, file.newUri]))),
  vscode.window.onDidChangeWindowState(state => { if (state.focused) for (const root of roots.keys()) invalidateWorkingTreeSnapshot(root); }));
  return { version: 1, onDidChangeComparison: comparison.onDidChangeComparison, getComparison: () => comparison.getPublicComparison(),
    workingTreeStatus: { version: 1, onDidChange: changed.event, getStatus: async (root, options) => {
      if (closed) throw new DOMException("Git status provider disposed.", "AbortError");
      await track(root);
      if (closed) throw new DOMException("Git status provider disposed.", "AbortError");
      return readWorkingTreeSnapshot(root, options);
    } } };
}

/** .git 파일과 commondir를 읽어 linked worktree의 실제 index/HEAD와 공용 refs를 감시한다. */
async function watchMetadata(root: string, state: PublicRoot): Promise<void> {
  try {
    let directory = path.join(root, ".git");
    if ((await stat(directory)).isFile()) {
      const line = (await readFile(directory, "utf8")).trim();
      if (!line.startsWith("gitdir: ")) return;
      directory = path.resolve(root, line.slice(8));
    }
    const common = await readFile(path.join(directory, "commondir"), "utf8").then(value => path.resolve(directory, value.trim()), () => directory);
    for (const folder of new Set([directory, common])) {
      if (state.disposed) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "{index,HEAD,refs/**,packed-refs,MERGE_HEAD,REBASE_HEAD,rebase-merge/**,rebase-apply/**}"));
      const changed = () => { if (!state.disposed) invalidateWorkingTreeSnapshot(root); };
      state.watchers.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
    }
  } catch { /* metadata 감시가 불가능해도 TTL/force 기반 authoritative 조회는 유지한다. */ }
}
