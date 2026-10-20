// 전용 profile/PID를 먼저 검증한 Development Host 창만 읽고 캡처하는 테스트 경계.
import assert from "node:assert/strict";
import WebSocket = require("ws");

/** 사용자 기본 profile과 다른 실행임을 증명한 뒤에만 소유 테스트 창에 접근한다. */
export class IsolatedTestWindow {
  private socket?: WebSocket;
  private nextId = 0;
  private windowId?: number;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly port: number, private readonly profile: string) {}

  /** main inspector의 실제 PID와 userData 경로가 runner의 전용 프로세스/프로필과 모두 같은지 확인한다. */
  async connect(): Promise<void> {
    assert.match(this.profile, /^\/private\/tmp\/gsc-extension-smoke-[^/]+\/profile$/);
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json() as any[];
    const target = targets.find(item => String(item.webSocketDebuggerUrl).startsWith(`ws://127.0.0.1:${this.port}/`));
    assert.ok(target, "Dedicated test main inspector was not found");
    const socket = this.socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.on("message", data => {
      const message = JSON.parse(String(data)), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) pending.reject(new Error(JSON.stringify(message)));
      else pending.resolve(message.result?.result?.value);
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const identity = await this.evaluate(`({pid:process.pid,profile:require('electron').app.getPath('userData')})`);
    assert.equal(identity.pid, Number(process.env.VSCODE_PID), "Inspector PID is not the isolated test main process");
    assert.equal(identity.profile, this.profile, "Inspector profile is not the isolated test profile");
  }

  /** 전용 창의 현재 포커스만 확인한다. 앱 활성화·창 이동 없이 실패해 사용자의 다른 작업을 방해하지 않는다. */
  async assertFocused(): Promise<void> {
    this.windowId = await this.evaluate(`(function(){var e=require('electron');if(e.app.getPath('userData')!==${JSON.stringify(this.profile)})throw Error('profile changed');var windows=e.BrowserWindow.getAllWindows().filter(w=>w.getTitle().includes('workspace'));if(windows.length!==1)throw Error('expected one isolated workspace window');return windows[0].id;})()`);
    const state = await this.focusState();
    assert.ok(state.windowFocused && state.contentsFocused, "Native UI smoke requires an already focused isolated window; use headless Graph tests while working in another app.");
  }

  /** 전용 창의 실제 native/renderer focus만 진단해 VS Code API와 차이가 나는 경계를 남긴다. */
  async focusState(): Promise<Record<string, boolean>> {
    return this.evaluate(`(async function(){${this.ownedWindow()}return{windowFocused:w.isFocused(),contentsFocused:w.webContents.isFocused(),visible:w.isVisible(),minimized:w.isMinimized(),focusable:w.isFocusable(),appHidden:e.app.isHidden(),documentFocused:await w.webContents.executeJavaScript('document.hasFocus()')};})()`);
  }

  /** 전용 창의 Graph iframe 한 개에서 실제 행·HEAD 배지·브랜치 chip만 읽어 최신 UI를 확인한다. */
  async graphRows(): Promise<Array<{ hash: string; refs: string[]; branches: string[]; head: boolean }>> {
    const query = "(function(){var root=document.getElementById('graph-content');if(!root)return null;return Array.from(root.querySelectorAll('.row[data-hash]:not([data-reflog-virtual])'),r=>({hash:r.dataset.hash,refs:(r.dataset.refs||'').split('\\t').filter(Boolean),branches:Array.from(r.querySelectorAll('[data-branch-name]'),b=>b.dataset.branchName),head:!!r.querySelector('.ref.head')}));})()";
    return this.evaluate(`(async function(){${this.ownedWindow()}var results=[];for(var f of w.webContents.mainFrame.framesInSubtree){try{var rows=await f.executeJavaScript(${JSON.stringify(query)});if(rows)results.push(rows);}catch{}}if(results.length!==1)throw Error('expected one isolated Graph renderer');return results[0];})()`);
  }

  /** 전용 창 전체를 PNG로 캡처한다. OS 화면이나 다른 앱/사용자 창은 캡처하지 않는다. */
  async screenshot(): Promise<Buffer> {
    assert.ok(this.windowId);
    const encoded = await this.evaluate(`(async function(){var e=require('electron');if(e.app.getPath('userData')!==${JSON.stringify(this.profile)})throw Error('profile changed');var w=e.BrowserWindow.fromId(${this.windowId});if(!w||!w.getTitle().includes('workspace'))throw Error('test window changed');return(await w.webContents.capturePage()).toPNG().toString('base64');})()`);
    return Buffer.from(encoded, "base64");
  }

  /** 전용 창에 열린 파일 선택기의 제목·선택 상태만 읽는다. 다른 창이나 profile에는 접근하지 않는다. */
  async quickPickState(): Promise<{ visible: boolean; title: string; selected: string }> {
    return this.evaluate(`(async function(){${this.ownedWindow()}return w.webContents.executeJavaScript("(function(){var q=document.querySelector('.quick-input-widget');return{visible:!!q&&q.getBoundingClientRect().height>0,title:q?.querySelector('.quick-input-title')?.textContent||'',selected:q?.querySelector('.monaco-list-row.focused')?.textContent||''};})()");})()`);
  }

  /** 검증한 전용 파일 선택기의 input에만 검색어를 입력한다. OS 키보드나 clipboard는 사용하지 않는다. */
  async filterQuickPick(query: string, title: string): Promise<void> {
    const state = await this.quickPickState(); assert.ok(state.visible && state.title.includes(title), "Unexpected isolated Quick Pick");
    await this.evaluate(`(async function(){${this.ownedWindow()}await w.webContents.executeJavaScript("(function(){var input=document.querySelector('.quick-input-widget input');if(!input)throw Error('test picker input missing');input.focus();})()");await w.webContents.insertText(${JSON.stringify(query)});return true;})()`);
  }

  /** 원하는 파일이 실제 선택된 전용 picker에만 Enter를 전달한다. 사용자 다른 창으로 키를 보내지 않는다. */
  async acceptQuickPick(expectedFile: string): Promise<void> {
    const state = await this.quickPickState(); assert.ok(state.visible && state.selected.includes(expectedFile), "Unexpected isolated file selection");
    await this.evaluate(`(function(){${this.ownedWindow()}w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});return true;})()`);
  }

  /** 모든 UI 검사/입력 직전에 같은 전용 profile과 workspace 창인지 다시 확인하는 평가 본문을 만든다. */
  private ownedWindow(): string {
    assert.ok(this.windowId);
    return `var e=require('electron');if(e.app.getPath('userData')!==${JSON.stringify(this.profile)})throw Error('profile changed');var w=e.BrowserWindow.fromId(${this.windowId});if(!w||!w.getTitle().includes('workspace'))throw Error('test window changed');`;
  }

  /** 독립 요청 ID와 제한 시간을 사용하고 main inspector의 평가 오류를 테스트 실패로 보존한다. */
  private evaluate(expression: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Isolated test window request timed out")); }, 10000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      const wrapped = `(function(require){return (${expression});})(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))`;
      this.socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: wrapped, returnByValue: true, awaitPromise: true } }));
    });
  }

  /** 테스트가 소유한 socket/timer만 정리하며 제품 debugger나 다른 프로세스에는 신호를 보내지 않는다. */
  close(): void {
    for (const item of this.pending.values()) item.reject(new Error("Isolated test window closed"));
    this.pending.clear(); this.socket?.close();
  }
}
