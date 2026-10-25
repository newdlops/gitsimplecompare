import path from "node:path";
import type { FromWebviewMessage, ToWebviewMessage } from "../../src/webview/graphProtocol";

/** VS Code 이벤트의 구독·해제와 Disposable 배열 등록 의미를 유지하는 작은 시험용 이벤트다. */
export function lifecycleEvent<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return {
    subscribe(callback: (value: T) => unknown, thisArg?: unknown, disposables?: Array<{ dispose(): void }>) {
      const listener = (value: T) => callback.call(thisArg, value); listeners.add(listener);
      const disposable = { dispose() { listeners.delete(listener); } }; disposables?.push(disposable); return disposable;
    },
    fire(value: T) { return Promise.all([...listeners].map(listener => listener(value))); },
    size: () => listeners.size,
  };
}

/** 중첩 media 경로·query를 유지해 production HTML을 소유 fixture origin으로 연결한다. */
export function lifecycleResourceUri(fsPath: string, query = ""): any {
  return { fsPath, query, with: (change: { query?: string }) => lifecycleResourceUri(fsPath, change.query ?? query),
    toString: () => `https://gsc.fixture/${path.relative(process.cwd(), fsPath).split(path.sep).join("/")}${query ? `?${query}` : ""}` };
}

/**
 * OS 창 없이 WebviewPanel의 실제 생성·reveal·dispose 이벤트 순서를 재현한다.
 * @param post production panel의 outbound 메시지를 전달할 함수 @returns 표면과 구독 수·늦은 게시 수 관측 API.
 */
export function createLifecycleSurface(post: (message: ToWebviewMessage) => void) {
  const disposal = lifecycleEvent<void>(), visibility = lifecycleEvent<any>(), inbound = lifecycleEvent<FromWebviewMessage>();
  let closed = false, latePosts = 0, reveals = 0;
  const surface = {
    visible: true,
    onDidDispose: disposal.subscribe, onDidChangeViewState: visibility.subscribe,
    reveal() { if (closed) throw new Error("Closed panel revealed"); reveals++; surface.visible = true; visibility.fire({ webviewPanel: surface }); },
    hide() { surface.visible = false; visibility.fire({ webviewPanel: surface }); },
    dispose() { if (closed) return; closed = true; disposal.fire(); },
    webview: { html: "", cspSource: "https://gsc.fixture", asWebviewUri: (value: { fsPath: string }) => lifecycleResourceUri(value.fsPath),
      onDidReceiveMessage: inbound.subscribe,
      postMessage(message: ToWebviewMessage) { if (closed) { latePosts++; return Promise.resolve(false); } post(structuredClone(message)); return Promise.resolve(true); },
    },
  };
  return { surface, receive: (message: FromWebviewMessage) => inbound.fire(message),
    stats: () => ({ closed, latePosts, reveals, subscriptions: disposal.size() + visibility.size() + inbound.size() }) };
}
