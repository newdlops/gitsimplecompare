// 실제 Extension Host·VS Code 정책·Settings와 HTTPS 자원 정리를 격리 profile에서 검증한다.
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, request, type RequestOptions } from "node:https";
import { IsolatedTestWindow } from "../helpers/isolatedTestWindow";
import { beginGitHubReadLifetime, readGitHubInteractive } from "../../src/git/githubReadCache";
import { createGitHubReadSession, completeGitHubReadSession, gitHubReadSessionState } from "../../src/git/githubReadSession";
import { setGitHubReadPolicyResolver, GitHubReadRuntime } from "../../src/git/githubReadRuntime";
import { graphQLRequest } from "../../src/git/githubReadRequest";
import { gitHubReadNetworkPolicy } from "../../src/ui/githubTransportSettings";
import { GitHubHttpTransport } from "../../src/git/githubHttpTransport";
import { GitHubCredentialProvider } from "../../src/git/githubCredential";
import { searchPullRequests } from "../../src/git/pullRequestSearchService";
import { verifyProgressiveComments } from "./httpFollowupCommentsSmoke";

/** 시간 자체를 성과로 쓰지 않으며 실제 상태가 도착했는지 bounded 대기로 확인한다. */
async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!await check()) { assert(Date.now() < until, `${label} did not settle`); await new Promise(resolve => setTimeout(resolve, 50)); }
}

/** TLS 검증을 유지한 로컬 연결에서 소비자 취소가 다른 요청을 끊지 않고 dispose가 close를 기다리는지 확인한다. */
async function verifyOwnedTls(directory: string): Promise<void> {
  const key = path.join(directory, "key"), certificate = path.join(directory, "certificate");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2"], { stdio: "ignore" });
  const cert = await readFile(certificate);
  let slowStarted = 0, slowClosed = 0, connections = 0;
  const server = createServer({ key: await readFile(key), cert }, (req, res) => {
    if (req.url === "/slow") { slowStarted++; req.on("close", () => slowClosed++); res.write("{"); }
    else res.end('{"ok":true}');
  });
  server.on("secureConnection", () => connections++);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const agentIdentity: Array<{ supplied?: string; actual?: string; same: boolean }> = [];
  const transport = new GitHubHttpTransport({ request: (options: RequestOptions, callback) => {
    const outgoing = request({ ...options, hostname: "127.0.0.1", port, servername: "localhost", ca: cert }, callback);
    agentIdentity.push({ supplied: (options.agent as any)?.constructor?.name, actual: outgoing.agent?.constructor?.name, same: outgoing.agent === options.agent });
    return outgoing;
  } });
  const provider = new GitHubCredentialProvider(), credential = await provider.acquire(directory, { GH_TOKEN: "fixture-token" });
  const read = (endpoint: string, signal?: AbortSignal) => transport.read({ kind: "rest", path: endpoint, accept: "application/json" },
    credential, { operation: "host-tls", deadline: Date.now() + 5000, signal });
  try {
    const controller = new AbortController(), slow = read("/slow", controller.signal), rejected = assert.rejects(slow, { name: "AbortError" });
    await waitFor(() => slowStarted === 1, "local TLS request");
    assert.equal(await read("/quick"), '{"ok":true}'); controller.abort(); await rejected;
    await waitFor(() => slowClosed === 1, "cancelled TLS close");
    const before = connections; await read("/quick"); assert.equal(connections, before,
      JSON.stringify({ check: "host-agent-identity", proxySupport: vscode.workspace.getConfiguration("http").get("proxySupport"), agentIdentity }));
    const disposing = read("/slow"), disposed = assert.rejects(disposing, { name: "AbortError" });
    await waitFor(() => slowStarted === 2, "disposal TLS request"); await transport.dispose(); await disposed;
    await waitFor(() => slowClosed === 2, "disposed TLS close");
  } finally {
    await transport.dispose(); await provider.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** 개발 host의 실제 정책을 통과한 공개 API와 unsupported 정책의 최초 CLI 선택을 검증한다. */
async function verifyHostReads(root: string): Promise<void> {
  process.env.GH_REPO = "cli/cli"; process.env.GH_HOST = "github.com";
  const reset = setGitHubReadPolicyResolver(gitHubReadNetworkPolicy); let stop = beginGitHubReadLifetime();
  const config = vscode.workspace.getConfiguration("gitSimpleCompare", vscode.Uri.file(root));
  const query = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner url}}";
  const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${query}`];
  const request = graphQLRequest(query, { owner: "{owner}", name: "{repo}" });
  const read = async () => {
    const session = createGitHubReadSession(root, readGitHubInteractive);
    const value = await session(args, root, { operation: "host-public-read", request });
    assert.equal(JSON.parse(value).data.repository.nameWithOwner, "cli/cli"); await completeGitHubReadSession(session);
    return gitHubReadSessionState(session)!.transport;
  };
  try {
    await config.update("githubReadTransport", "auto", vscode.ConfigurationTarget.Workspace);
    assert.equal(await read(), "cli"); assert.equal(await read(), "http");
    const executeHttp = GitHubHttpTransport.prototype.read;
    let searchHttpReads = 0;
    GitHubHttpTransport.prototype.read = async function(this: GitHubHttpTransport, ...args: Parameters<typeof executeHttp>) {
      searchHttpReads++; return executeHttp.apply(this, args);
    };
    try {
      const result = await searchPullRequests(root, "#14848", undefined, undefined, readGitHubInteractive);
      assert(result.pullRequests.some(pr => pr.number === 14848));
      assert(searchHttpReads >= 2, "Actual search must stay on HTTP after canonical scope discovery");
    } finally { GitHubHttpTransport.prototype.read = executeHttp; }
    const http = vscode.workspace.getConfiguration("http");
    await http.update("proxySupport", "override", vscode.ConfigurationTarget.Global);
    stop = beginGitHubReadLifetime(); assert.equal(await read(), "cli");
    await http.update("proxySupport", "on", vscode.ConfigurationTarget.Global);
    await config.update("githubReadTransport", "cli", vscode.ConfigurationTarget.Workspace);
    stop = beginGitHubReadLifetime(); assert.equal(await read(), "cli");
    for (const [host, extra] of [["enterprise.example", {}], ["github.com", { HTTPS_PROXY: "http://fixture" }],
      ["github.com", { NODE_EXTRA_CA_CERTS: "/fixture" }], ["github.com", { GH_HTTP_UNIX_SOCKET: "/fixture" }]] as const) {
      let cli = 0, http = 0;
      const runtime = new GitHubReadRuntime({ policy: async () => ({ ...(await gitHubReadNetworkPolicy(root)), transport: "auto" }),
        cli: async () => { cli++; return "{}"; }, http: { read: async () => { http++; throw Error("Unsupported host network path"); }, dispose: async () => {} } });
      await runtime.execute(args, root, { operation: "host-compatibility", request, readSession: { root, env: { GH_TOKEN: "fixture", ...extra },
        scope: { host, name: "cli/cli", owner: "cli", repository: "cli" } } });
      assert.equal(cli, 1); assert.equal(http, 0); await runtime.dispose();
    }
  } finally { await stop(); reset(); await config.update("githubReadTransport", undefined, vscode.ConfigurationTarget.Workspace); }
}

/** 실제 Settings control의 표시·클릭·선택·좁은 화면을 별도로 캡처하고 profile을 원상태로 돌린다. */
async function verifySettings(root: string, owned: IsolatedTestWindow, directory: string): Promise<any[]> {
  await owned.selectOwnedWindow();
  const config = () => vscode.workspace.getConfiguration("gitSimpleCompare", vscode.Uri.file(root));
  const states: any[] = [];
  await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:newdlops.gitsimplecompare github");
  await waitFor(async () => (await owned.githubSettingsState()).rows.length === 2, "GitHub Settings rows");
  for (const [width, height] of [[1440, 900], [900, 700]]) {
    await owned.settingsViewport(width, height);
    await waitFor(async () => { const state = await owned.githubSettingsState(); return state.width === width
      && state.rows.every((row: any) => row.bounds.right <= state.width && row.bounds.left >= 0); }, "Settings viewport and layout");
    const state = await owned.githubSettingsState(); assert.equal(state.rows.length, 2);
    assert(state.rows.every((row: any) => row.bounds.right <= state.width && row.bounds.left >= 0));
    states.push(state); await writeFile(path.join(directory, `settings-${vscode.env.language}-${width}.png`), await owned.screenshot());
  }
  await owned.clickGithubSetting("gitSimpleCompare.githubGitProactiveAuth");
  await waitFor(() => config().get("githubGitProactiveAuth") === true, "Settings checkbox on");
  await writeFile(path.join(directory, `settings-${vscode.env.language}-checked.png`), await owned.screenshot());
  await owned.clickGithubSetting("gitSimpleCompare.githubGitProactiveAuth");
  await waitFor(() => config().get("githubGitProactiveAuth") === false, "Settings checkbox off");
  await owned.clickGithubSetting("gitSimpleCompare.githubReadTransport");
  await owned.githubSettingsKeys(["Home", "Down", "Enter"]);
  await waitFor(() => config().get("githubReadTransport") === "cli", "Settings CLI selection");
  await writeFile(path.join(directory, `settings-${vscode.env.language}-cli.png`), await owned.screenshot());
  await config().update("githubReadTransport", undefined, vscode.ConfigurationTarget.Global);
  await config().update("githubGitProactiveAuth", undefined, vscode.ConfigurationTarget.Global);
  return states;
}

/** 기존 native Settings의 full 기본값·blobless 선택·지역화/긴 설명을 두 desktop 크기에서 확인한다. */
async function verifyCloneSettings(root: string, owned: IsolatedTestWindow, directory: string): Promise<any[]> {
  const key = "gitSimpleCompare.cloneMode", states: any[] = [];
  const config = () => vscode.workspace.getConfiguration("gitSimpleCompare", vscode.Uri.file(root));
  await vscode.commands.executeCommand("workbench.action.openSettings", "@id:" + key);
  await waitFor(async () => (await owned.githubSettingsState([key])).rows.length === 1, "Clone Settings row");
  assert.equal(config().get("cloneMode"), "full");
  for (const [width, height] of [[1440, 900], [900, 700]]) {
    await owned.settingsViewport(width, height);
    await waitFor(async () => { const state = await owned.githubSettingsState([key]); return state.width === width
      && state.rows.length === 1 && state.rows[0].bounds.right <= state.width && state.rows[0].bounds.left >= 0; }, "Clone Settings viewport and layout");
    const state = await owned.githubSettingsState([key]);
    assert.equal(state.rows.length, 1); assert(state.rows[0].bounds.right <= state.width && state.rows[0].bounds.left >= 0);
    assert.match(state.rows[0].text, /2\.46/); states.push(state);
    await writeFile(path.join(directory, `clone-settings-${vscode.env.language}-${width}.png`), await owned.screenshot());
  }
  await owned.clickGithubSetting(key); await owned.githubSettingsKeys(["Home", "Down", "Enter"]);
  await waitFor(async () => config().get("cloneMode") === "blobless"
    && (await owned.githubSettingsState([key])).rows[0]?.value === "blobless", "Blobless rendered selection");
  await writeFile(path.join(directory, `clone-settings-${vscode.env.language}-blobless.png`), await owned.screenshot());
  states.push({ phase: "blobless", ...await owned.githubSettingsState([key]) });
  await owned.clickGithubSetting(key); await owned.githubSettingsKeys(["Up", "Enter"]);
  await waitFor(async () => config().get("cloneMode") === "full"
    && (await owned.githubSettingsState([key])).rows[0]?.value === "full", "Full rendered selection");
  states.push({ phase: "restored-full", ...await owned.githubSettingsState([key]) });
  await config().update("cloneMode", undefined, vscode.ConfigurationTarget.Global);
  return states;
}

/** 활성화 후 실 host의 네트워크 정책·자원·화면을 모두 검증한 aggregate만 저장한다. */
export async function run(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE!, profile = process.env.GSC_EXTENSION_TEST_PROFILE!;
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare")!; await extension.activate();
  const directory = process.env.GSC_HTTP_RESULT_DIR || "/private/tmp/gsc-http-host-results";
  await mkdir(directory, { recursive: true });
  await verifyHostReads(root); await verifyOwnedTls(directory);
  const owned = new IsolatedTestWindow(Number(process.env.GSC_TEST_MAIN_INSPECTOR_PORT), profile);
  await owned.connect();
  try {
    await owned.focusOwnedWindow();
    await waitFor(() => vscode.window.state.focused, "owned native UI focus");
    const settings = await verifySettings(root, owned, directory);
    const cloneSettings = await verifyCloneSettings(root, owned, directory);
    const progressiveComments = await verifyProgressiveComments(root, owned, directory);
    const record = { node: process.versions.node, vscode: vscode.version, language: vscode.env.language,
      actualPublicHttpRead: true, actualSearchHttpReads: true, forcedCli: true, unsupportedPoliciesBeforeHttp: true,
      defaultOverrideAgentPolicyUsesCli: true, verifiedDirectAgentPolicy: "on (isolated test profile only)",
      tlsValidation: true, cancellationIsolation: true, keepAliveReuse: true, disposalClose: true, settings, cloneSettings, progressiveComments };
    await writeFile(path.join(directory, `host-${vscode.env.language}.json`), JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({ githubHttpHostSmoke: "passed", node: record.node, vscode: record.vscode, language: record.language }));
  } catch (error) {
    console.error("owned-settings-failure", JSON.stringify(await owned.githubSettingsState(["gitSimpleCompare.githubReadTransport", "gitSimpleCompare.cloneMode"])));
    await writeFile(path.join(directory, `host-${vscode.env.language}-failure.png`), await owned.screenshot());
    throw error;
  } finally { owned.close(); }
}
