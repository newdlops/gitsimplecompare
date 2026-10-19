import { Uri } from "vscode";
import type { TestContext } from "node:test";
import { GitGraphPanel } from "../../src/webview/graphPanel";
import type { GitLogService } from "../../src/git/gitLogService";
import type { ToWebviewMessage } from "../../src/webview/graphProtocol";

/**
 * 실제 Panel/서비스/레이아웃을 실행하고 VS Code의 HTML transport만 기록하는 시험용 표면이다.
 * @param t 리소스 URI 대역의 수명을 정리할 테스트 문맥 @param service 실제 임시 저장소 서비스
 * @returns 실제 명령 후속 경로에 접근할 panel과 수정되지 않는 게시 메시지 사본
 */
export function createOperationGraphPanel(t: Pick<TestContext, "mock">, service: GitLogService) {
  t.mock.method(Uri, "joinPath", (...parts: unknown[]) => {
    const uri = { query: "", with: () => uri, toString: () => parts.join("/") }; return uri;
  });
  const messages: ToWebviewMessage[] = [];
  const surface = { visible: true, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    onDidChangeViewState: () => ({ dispose() {} }), webview: {
      html: "", cspSource: "fixture:", asWebviewUri: (value: unknown) => {
        const uri = { query: "", with: () => uri, toString: () => String(value) }; return uri;
      },
      onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (message: ToWebviewMessage) => {
        messages.push(structuredClone(message)); return Promise.resolve(true);
      },
    } };
  const panel: any = new (GitGraphPanel as any)(surface, Uri.file(process.cwd()), service);
  return { panel, messages };
}
