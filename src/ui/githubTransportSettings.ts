// VS Code의 사용자/워크스페이스 네트워크 정책을 git 계층에 값으로 전달하는 composition 경계다.
import * as vscode from "vscode";
import { detectGitHubSystemProxy } from "../git/githubSystemProxy";
import type { GitHubNetworkPolicy } from "../git/githubHttpPolicy";

/** 선택 저장소의 전송 설정과 VS Code proxy/인증서 제약을 읽되 비밀 proxy 인증값은 반환하지 않는다. */
export async function gitHubReadNetworkPolicy(root: string): Promise<GitHubNetworkPolicy> {
  const uri = vscode.Uri.file(root), config = vscode.workspace.getConfiguration("gitSimpleCompare", uri);
  const http = vscode.workspace.getConfiguration("http", uri);
  return { transport: config.get<string>("githubReadTransport", "auto") === "cli" ? "cli" : "auto",
    systemProxy: await detectGitHubSystemProxy(), proxy: http.get<string>("proxy", ""),
    proxyStrictSSL: http.get<boolean>("proxyStrictSSL", true),
    proxyAuthorization: Boolean(http.get<string>("proxyAuthorization", "") || http.get<string>("proxyKerberosServicePrincipal", "")),
    customCertificates: Boolean(http.get<string[]>("certificates", []).length) };
}
