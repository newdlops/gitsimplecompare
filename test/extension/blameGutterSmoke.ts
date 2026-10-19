// 전용 profile의 실제 VS Code에서 Block Author 명령부터 네이티브 거터 첫 paint까지 측정한다.
// - 사용자 창/저장소 대신 runner의 임시 저장소와 전용 main inspector만 읽는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import WebSocket = require("ws");

interface Entry { at: number; message: string; detail: any }
interface RenderedState { rows: number; layers: number; width: number | undefined; observerActive: boolean; methods: string[]; text: string[]; screenshot?: string }

/** 조건을 짧게 관찰하되 무한 대기하지 않고, 실패 시 해당 조건을 명시한다. */
async function until<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** 테스트 profile 아래 OUTPUT 파일만 찾아 실제 제품의 timestamp와 진단을 읽는다. */
class ProductLog {
  private file?: string;
  constructor(private readonly directory: string) {}
  /** 파일 생성 전/flush 전에도 재시도할 수 있도록 아직 없는 로그는 빈 배열로 반환한다. */
  async entries(): Promise<Entry[]> {
    this.file ??= await this.find(this.directory);
    if (!this.file) return [];
    return (await readFile(this.file, "utf8")).split("\n").flatMap(line => {
      const match = /^\[([^\]]+)\] \[\w+\] (.+?)(?: (\{.*\}))?$/.exec(line);
      if (!match) return [];
      try { return [{ at: Date.parse(match[1]), message: match[2], detail: match[3] ? JSON.parse(match[3]) : {} }]; }
      catch { return []; }
    });
  }
  /** 생성된 전용 profile의 log tree만 재귀 탐색한다. 사용자 profile은 인자로 받지 않는다. */
  private async find(directory: string): Promise<string | undefined> {
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const full = path.join(directory, child.name);
      if (child.isFile() && /Git Simple Compare\.log$/.test(child.name)) return full;
      if (child.isDirectory()) { const found = await this.find(full); if (found) return found; }
    }
    return undefined;
  }
}

/** 전용 main inspector에만 연결하고 PID/profile 검증 후 테스트 창을 읽는다. */
class IsolatedWindowReader {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly requests = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly port: number, private readonly profile: string) {}
  /** main PID와 전용 user-data-dir이 모두 일치하는 연결만 허용한다. */
  async connect(): Promise<void> {
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json() as any[];
    const target = targets.find(item => String(item.webSocketDebuggerUrl).startsWith(`ws://127.0.0.1:${this.port}/`));
    assert.ok(target, "Dedicated test main inspector was not found");
    const socket = this.socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.on("message", data => {
      const message = JSON.parse(String(data)), pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      if (message.error || message.result?.exceptionDetails) pending.reject(new Error(JSON.stringify(message)));
      else pending.resolve(message.result?.result?.value);
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const identity = await this.evaluate(`({pid:process.pid,profile:require('electron').app.getPath('userData')})`);
    assert.equal(identity.pid, Number(process.env.VSCODE_PID), "Inspector did not belong to the isolated test main process");
    assert.equal(identity.profile, this.profile, "Inspector did not use the isolated test profile");
  }
  /** 사용자 창을 고르지 않고 전용 프로필의 단일 테스트 창만 앞으로 가져온다. */
  async focus(): Promise<number> {
    return this.evaluate(`(function(){var electron=require('electron');if(electron.app.getPath('userData')!==${JSON.stringify(this.profile)})throw Error('unexpected profile');var wins=electron.BrowserWindow.getAllWindows().filter(w=>w.getTitle().includes('workspace'));if(wins.length!==1)throw Error('expected one isolated workspace');if(process.platform==='darwin')wins[0].setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});wins[0].setAlwaysOnTop(true);wins[0].show();electron.app.focus({steal:true});wins[0].focus();return wins[0].id;})()`);
  }
  /** 제품 binding을 덮어쓰지 않고 독립 request ID로 읽기 expression만 평가한다. */
  private async evaluate(expression: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("Isolated window read timed out")); }, 10_000);
      this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      const wrapped = `(function(require){return (${expression});})(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))`;
      this.socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: wrapped, returnByValue: true, awaitPromise: true } }));
    });
  }
  /** 실제 renderer의 행·단일 거터·폭을 확인하고 필요하면 같은 테스트 창만 촬영한다. */
  async state(windowId: number, screenshot = false): Promise<RenderedState> {
    const renderer = `(function(){var editor=window.__gscNativeBlameEditorRef&&window.__gscNativeBlameEditorRef.deref();return {rows:document.querySelectorAll('.gsc-native-blame-row').length,layers:document.querySelectorAll('.gsc-native-blame-layer').length,width:editor&&editor.getRawOptions().lineDecorationsWidth,observerActive:!!window.__gscNativeBlameEditorCapture,methods:editor?['getModel','getDomNode','getLayoutInfo'].map(name=>editor[name].name):[],text:Array.from(document.querySelectorAll('.gsc-native-blame-row')).slice(0,4).map(n=>n.textContent)};})()`;
    return this.evaluate(`(async function(){if(require('electron').app.getPath('userData')!==${JSON.stringify(this.profile)})throw Error('profile changed');var w=require('electron').BrowserWindow.fromId(${windowId});if(!w||!w.getTitle().includes('workspace'))throw Error('unexpected test window');var state=await w.webContents.executeJavaScript(${JSON.stringify(renderer)});${screenshot ? "state.screenshot=(await w.webContents.capturePage()).toPNG().toString('base64');" : ""}return state;})()`);
  }
  /** 테스트용 추가 socket만 닫으며 제품의 bridge/debugger는 조작하지 않는다. */
  close(): void { this.socket?.close(); }
}

/** 힌트 반환 직후와 사전 준비 후의 두 UI 경로를 동일한 새 profile에서 검증한다. */
export async function run(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE!, profile = process.env.GSC_EXTENSION_TEST_PROFILE!;
  assert.ok(root && profile && /gsc-extension-smoke-/.test(root));
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  assert.equal(profile, path.join(path.dirname(root), "profile"));
  const resultDir = process.env.GSC_BLAME_RESULT_DIR!;
  await mkdir(resultDir, { recursive: true });
  const files = ["cold-blame.ts", "prepared-blame.ts"];
  const content = ["export function blameSample() {", ...Array.from({ length: 100 }, (_, index) => `  const value${index} = ${index};`), "  return value99;", "}", ""].join("\n");
  for (const file of files) await writeFile(path.join(root, file), content);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, stdio: "pipe" });
  git(["add", ...files]); git(["commit", "--quiet", "-m", "real blame fixture"]);
  const symbols = vscode.languages.registerDocumentSymbolProvider({ scheme: "file", pattern: new vscode.RelativePattern(root, "*-blame.ts") }, {
    provideDocumentSymbols: document => [new vscode.DocumentSymbol("blameSample", "", vscode.SymbolKind.Function,
      new vscode.Range(0, 0, document.lineCount - 2, 1), new vscode.Range(0, 16, 0, 27))],
  });
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare"); assert.ok(extension);
  await extension.activate();
  const gitCalls = path.join(path.dirname(root), "git-calls.log"), wrapper = path.join(path.dirname(root), "record-git");
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitCalls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  await vscode.workspace.getConfiguration("gitSimpleCompare").update("gitPath", wrapper, vscode.ConfigurationTarget.Workspace);
  const log = new ProductLog(path.join(profile, "logs"));
  const reader = new IsolatedWindowReader(Number(process.env.GSC_TEST_MAIN_INSPECTOR_PORT), profile);
  const timings: any[] = [];
  /** 실제 포커스를 얻은 후에만 클릭을 시작해 OS 전환 시간을 click latency에 섞지 않는다. */
  const focused = () => until("focused isolated editor", async () => {
    if (vscode.window.state.focused) return true;
    await reader.focus(); return undefined;
  });
  try {
    await reader.connect(); await reader.focus();
    for (const [index, file] of (process.env.GSC_BLAME_BASELINE ? files.slice(0, 1) : files).entries()) {
      const document = await vscode.workspace.openTextDocument(path.join(root, file));
      const openedAt = Date.now();
      // OS 창 포커스는 검증된 전용 BrowserWindow가 관리하고, 문서 전환이 다른 Code 인스턴스를 활성화하지 않게 한다.
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
      await focused();
      const command = await until("real Block Author CodeLens", async () => {
        if (!vscode.window.state.focused) { await reader.focus(); return undefined; }
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
        return lenses?.find(lens => lens.command?.command === "gitSimpleCompare.showBlockBlame")?.command;
      });
      const hintMs = Date.now() - openedAt;
      let prepared: Entry | undefined;
      if (index > 0) {
        prepared = await until("native editor prepared without opening gutter", async () => (await log.entries())
          .find(entry => entry.message === "native blame editor prepared before click" && entry.detail.uri === document.uri.toString()));
        const before = await reader.state(Number(/ok:(\d+):/.exec(prepared.detail.result)![1]));
        assert.equal(before.rows, 0); assert.equal(before.layers, 0);
      }
      await focused(); const clickedAt = Date.now();
      await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
      const rendered = await until("first nonempty native gutter paint", async () => {
        if (!vscode.window.state.focused) await reader.focus();
        return (await log.entries()).find(entry => entry.at >= clickedAt && entry.message === "native blame gutter rendered"
          && entry.detail.uri === document.uri.toString() && /paint:native:[1-9]\d*\//.test(entry.detail.result));
      });
      const clickToPaintMs = rendered.at - clickedAt;
      const connection = (await log.entries()).find(entry => entry.message === "native editor overlay connected");
      assert.equal(connection?.detail.pid, Number(process.env.VSCODE_PID), "Product connection selected another VS Code main process");
      const windowId = Number(/ok:(\d+):/.exec(rendered.detail.result)![1]);
      const state = await reader.state(windowId, true);
      assert.ok(state.rows > 0); assert.equal(state.layers, 1); assert.ok(state.text.some(text => text.includes("Extension Smoke")));
      assert.equal(state.observerActive, false); assert.ok(state.methods.every(name => name !== "wrapper"), "Temporary editor methods were not restored");
      await writeFile(path.join(resultDir, `${index ? "prepared" : "first"}.png`), Buffer.from(state.screenshot!, "base64"));
      delete state.screenshot;
      const events = await log.entries();
      const focusInterrupted = events.some(entry => entry.at >= clickedAt && entry.at <= rendered.at && entry.message === "block blame code vision suspended");
      const preparation = events.find(entry => entry.message === "native blame editor prepared before click" && entry.detail.uri === document.uri.toString());
      timings.push({ file, hintMs, clickToPaintMs, focusInterrupted, result: rendered.detail.result, prepared: preparation?.detail, state });
      await writeFile(path.join(resultDir, "timings.json"), JSON.stringify({ timings, log: events }, null, 2));
      if (!process.env.GSC_BLAME_BASELINE) {
        assert.ok(preparation, "Source blocks did not prepare their editor");
        assert.match(preparation.detail.result, /heapQueries=0/); assert.match(rendered.detail.result, /heapQueries=0/);
      }
      await focused();
      await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
      const closed = await until("Block Author closes its single gutter", async () => {
        if (!vscode.window.state.focused) await reader.focus();
        const state = await reader.state(windowId); return state.rows === 0 && state.layers === 0 ? state : undefined;
      });
      assert.ok(closed.width === undefined || closed.width < state.width!, "Closing the gutter did not restore its width");
      const blameReads = (await readFile(gitCalls, "utf8")).split("\n").filter(line => /(?:^|\s)blame(?:\s|$)/.test(line) && line.includes(file));
      assert.equal(blameReads.length, 1, "Code Vision refresh and gutter clicks must reuse one Git blame read per file");
      timings[timings.length - 1].blameReads = blameReads.length;
    }
    await writeFile(path.join(resultDir, "timings.json"), JSON.stringify({ timings, log: await log.entries() }, null, 2));
    console.log(`Real native Block Author timings: ${JSON.stringify(timings)}`);
  } finally { reader.close(); symbols.dispose(); }
}
