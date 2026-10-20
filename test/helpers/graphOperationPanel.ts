import { Uri } from "vscode";
import type { TestContext } from "node:test";
import { GitGraphPanel } from "../../src/webview/graphPanel";
import type { GitLogService } from "../../src/git/gitLogService";
import type { ToWebviewMessage, FromWebviewMessage } from "../../src/webview/graphProtocol";
import path from "node:path";

/** production HTML이 중첩 media 경로와 cache query를 유지하도록 작은 불변 URI 대역을 만든다. */
function resourceUri(fsPath: string, query = ""): any {
  return { fsPath, query, with: (change: { query?: string }) => resourceUri(fsPath, change.query ?? query),
    toString: () => `https://gsc.fixture/${path.relative(process.cwd(), fsPath).split(path.sep).join("/")}${query ? `?${query}` : ""}` };
}

/**
 * 실제 Panel/서비스/레이아웃을 실행하고 VS Code의 HTML transport만 기록하는 시험용 표면이다.
 * @param t 리소스 URI 대역의 수명을 정리할 테스트 문맥 @param service 실제 임시 저장소 서비스
 * @returns 실제 명령 후속 경로에 접근할 panel과 수정되지 않는 게시 메시지 사본
 */
export function createOperationGraphPanel(t: Pick<TestContext, "mock">, service: GitLogService, onPost?: (message: ToWebviewMessage) => void) {
  t.mock.method(Uri, "joinPath", (base: { fsPath: string }, ...parts: string[]) => resourceUri(path.join(base.fsPath, ...parts)));
  const messages: ToWebviewMessage[] = [];
  let receive: ((message: FromWebviewMessage) => Promise<void> | void) | undefined;
  const surface = { visible: true, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    onDidChangeViewState: () => ({ dispose() {} }), webview: {
      html: "", cspSource: "https://gsc.fixture", asWebviewUri: (value: { fsPath: string }) => resourceUri(value.fsPath),
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() { if (receive === listener) receive = undefined; } }; }, postMessage: (message: ToWebviewMessage) => {
        messages.push(structuredClone(message)); onPost?.(message); return Promise.resolve(true);
      },
    } };
  const panel: any = new (GitGraphPanel as any)(surface, Uri.file(process.cwd()), service);
  /** 실제 VS Code message callback을 거치게 하며 private handler를 직접 호출하지 않는다. */
  const receiveMessage = async (message: FromWebviewMessage) => {
    if (!receive) throw new Error("Graph receive handler is not attached");
    await receive(message);
  };
  return { panel, messages, surface, receiveMessage };
}
