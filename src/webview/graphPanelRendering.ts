// GraphPanel의 layout·성능 metadata·VS Code postMessage 수락 기록을 한 경계로 모으는 모듈.
// - 패널은 상태를 제공하고 이 모듈은 GraphData 생성과 transport 관찰성만 담당한다.
import type * as vscode from "vscode";
import type { Commit } from "../graph/graphTypes";
import { layoutGraphData } from "./graphLayoutData";
import {
  createGraphRenderPerformance,
  type GraphPerformanceTrace,
  logGraphPerformancePhase,
  logGraphPostMessageError,
  logGraphPostMessageResult,
} from "./graphPerformance";
import type {
  GraphLoadState,
  GraphRenderPerformance,
  ToWebviewMessage,
} from "./graphProtocol";

/** Graph render payload를 만들 때 panel이 제공하는 현재 상태다. */
export interface GraphRenderRequest {
  commits: readonly Commit[];
  virtualCommits: readonly Commit[];
  compact: boolean;
  state: GraphLoadState;
  trace?: GraphPerformanceTrace;
  kind: GraphRenderPerformance["kind"];
}

/**
 * 누적 commit을 layout하고 performance metadata와 함께 webview에 게시한다.
 * @param request commit/virtual/filter/load-state와 현재 성능 trace
 * @param post 타입이 보장된 GraphPanel transport 함수
 */
export function publishGraphRender(
  request: GraphRenderRequest,
  post: (message: ToWebviewMessage) => void
): void {
  const started = Date.now();
  const data = layoutGraphData(
    [...request.commits],
    [...request.virtualCommits],
    request.compact
  );
  logGraphPerformancePhase(request.trace, "layout", Date.now() - started, {
    kind: request.kind,
    rows: data.rows.length,
    edges: data.edges.length,
  });
  post({
    type: "graph",
    data,
    state: request.state,
    performance: createGraphRenderPerformance(request.trace, request.kind),
  });
}

/**
 * extension→webview 메시지를 보내고 graph payload의 VS Code 수락 시간을 기록한다.
 * @param webview 실제 VS Code Webview transport
 * @param repoRoot OUTPUT correlation에 사용할 현재 저장소 루트
 * @param message 타입이 검증된 protocol 메시지
 */
export function postGraphWebviewMessage(
  webview: vscode.Webview,
  repoRoot: string,
  message: ToWebviewMessage
): void {
  const started = Date.now();
  const posted = webview.postMessage(message);
  if (message.type !== "graph" || !message.performance) return;
  const performance = message.performance;
  void Promise.resolve(posted).then(
    (accepted) => logGraphPostMessageResult(
      repoRoot, performance, accepted, Date.now() - started
    ),
    (error) => logGraphPostMessageError(
      repoRoot, performance, error, Date.now() - started
    )
  );
}
