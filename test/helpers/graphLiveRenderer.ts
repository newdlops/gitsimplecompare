// 실제 Git/GraphPanel의 게시를 production HTML·JS와 연결하는 headless 검증 transport다.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";
import type { Commit } from "../../src/graph/graphTypes";
import type { FromWebviewMessage, GraphRenderPerformance, ToWebviewMessage } from "../../src/webview/graphProtocol";
import { expectedRenderedRefs, type NativeRemoteTag } from "./graphNativeExpectation";

type Paint = Extract<FromWebviewMessage, { type: "graphRendered" }>;
/** Chromium이 제공한 PID별 누적 CPU초다. 서로 다른 생애의 PID를 임의로 합치지 않는다. */
export interface BrowserCpuProcess { id:number; type:string; cpuTime:number }

/** OS 창을 만들지 않고 renderer의 실제 메시지 처리·두 frame ACK·DOM 최신 상태를 확인한다. */
export class GraphLiveRenderer {
  private queue = Promise.resolve();
  private readonly paints: Paint[] = [];
  private readonly buffered: ToWebviewMessage[] = [];
  private readonly errors: string[] = [];
  private mounted = false;
  private cpuSession?: CDPSession;
  private readonly observeAllMessages = process.env.GSC_BENCH_FULL_FRAME === "1";
  private messageSequence = 0;
  private messageFrame = { sequence: 0, paintedAt: 0 };
  private inbound?: (message: FromWebviewMessage) => Promise<void> | void;
  private startupStartedAt = 0;
  private startupReadyAt = 0;
  private navigationMs = 0;

  /** @param browser headless 전용 Chromium @param page 현재 fixture의 production Graph 문서 */
  private constructor(private readonly browser: Browser, private readonly page: Page) {}

  /** 설치된 Playwright를 workspace에서만 읽고 headless 실행을 강제한다. headed opt-in은 제공하지 않는다. */
  static async create(): Promise<GraphLiveRenderer> {
    const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
    const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");
    const browser = await chromium.launch({ headless: true,
      ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      return new GraphLiveRenderer(browser, page);
    } catch (error) { await browser.close(); throw error; }
  }

  /** 빈 동일-origin shell만 준비해 CPU 계측의 renderer PID를 고정한다. Graph 자산은 아직 읽지 않는다. */
  async prepareStartup(): Promise<void> {
    await this.page.route("https://gsc.fixture/__startup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Startup fixture</title>" }));
    await this.page.goto("https://gsc.fixture/__startup");
  }

  /** production HTML의 nonce/CSP를 유지하고 fixture origin의 로컬 media 파일만 제공한다. 외부 통신은 차단한다. */
  async mount(html: string): Promise<void> {
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce, "Production Graph CSP nonce is missing");
    const bridge = `<script nonce="${nonce}">(()=>{let acquired=false;window.acquireVsCodeApi=()=>{if(acquired)throw new Error("VS Code API acquired more than once");acquired=true;return{postMessage:message=>window.__gscLivePost(message),getState:()=>undefined,setState:()=>{}};};})();</script>`;
    const theme = `html,body{color-scheme:dark;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#454545;--vscode-focusBorder:#007fd4;--vscode-icon-foreground:#c5c5c5;--vscode-toolbar-hoverBackground:#3a3d41;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff}`;
    const document = html.replace("<head>", `<head>${bridge}`).replace("</head>", `<link rel="stylesheet" href="https://gsc.fixture/media/__fixture-theme.css"></head>`);
    this.page.on("pageerror", error => this.errors.push(error.message));
    this.page.on("console", message => { if (message.type() === "error") this.errors.push(message.text()); });
    await this.page.exposeFunction("__gscLivePost", (message: FromWebviewMessage) => {
      if (message.type === "ready" && !this.startupReadyAt) this.startupReadyAt = Date.now();
      if (message.type === "graphRendered") this.paints.push(message);
      if (message.type === "resyncGraph") this.errors.push("Renderer requested transport resync");
      return this.inbound?.(message);
    });
    if (this.observeAllMessages) {
      await this.page.exposeFunction("__gscAllMessageFrame", (value: { sequence: number; paintedAt: number }) => {
        if (value.sequence > this.messageFrame.sequence) this.messageFrame = value;
      });
      await this.page.addInitScript(() => {
        const fixtureWindow: any = window;
        let latest = 0, observed = 0, frames = 0, scheduled = false;
        /** 새 메시지가 끼어들면 frame 수를 다시 세어 마지막 변경보다 이른 ACK를 보내지 않는다. */
        function frame() {
          if (observed !== latest) { observed = latest; frames = 1; } else frames++;
          if (frames < 2) requestAnimationFrame(frame);
          else { scheduled = false; void fixtureWindow.__gscAllMessageFrame({ sequence: latest, paintedAt: Date.now() }); }
        }
        /** payload를 바꾸지 않고 실제 dispatch 직전의 순번만 관찰한다. */
        fixtureWindow.__gscObserveMessageFrame = (sequence: number) => {
          latest = sequence;
          if (!scheduled) { scheduled = true; requestAnimationFrame(frame); }
        };
      });
    }
    await this.page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://gsc.fixture") { this.errors.push(`External request: ${url.origin}`); await route.abort(); return; }
      if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: document }); return; }
      if (url.pathname === "/media/__fixture-theme.css") { await route.fulfill({ contentType: "text/css", body: theme }); return; }
      const relative = decodeURIComponent(url.pathname).slice(1), file = path.resolve(process.cwd(), relative);
      assert.ok(file.startsWith(path.join(process.cwd(), "media") + path.sep), "Fixture request escaped media directory");
      const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "font/ttf";
      await route.fulfill({ contentType, body: await readFile(file) });
    });
    const throttle = Number(process.env.GSC_BENCH_RENDERER_CPU_THROTTLE || 1);
    assert.ok(Number.isFinite(throttle) && throttle >= 1 && throttle <= 20);
    const throttleBeforeLoad = process.env.GSC_BENCH_THROTTLE_BEFORE_LOAD === "1";
    if (throttleBeforeLoad) await this.page.addInitScript(() => {
      const w: any = window; w.__gscStartupTasks = [];
      new PerformanceObserver(list => w.__gscStartupTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))))
        .observe({ entryTypes: ["longtask"] });
    });
    if (!throttleBeforeLoad) { this.startupStartedAt = Date.now(); await this.page.goto("https://gsc.fixture/"); }
    if (throttle > 1) {
      this.cpuSession = await this.page.context().newCDPSession(this.page);
      await this.cpuSession.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    if (throttleBeforeLoad) { this.startupStartedAt = Date.now(); await this.page.goto("https://gsc.fixture/"); }
    this.navigationMs = Date.now() - this.startupStartedAt;
    this.mounted = true;
    for (const message of this.buffered.splice(0)) this.post(message);
  }

  /** 실제 자산 로드부터 Graph ready/첫 frame까지 기록한다. 사후 Native oracle와 화면 촬영 전에 호출한다. */
  async startupMetrics() {
    await this.queue;
    const page = await this.page.evaluate(() => {
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const scripts = entries.filter(entry => new URL(entry.name).pathname.endsWith(".js"));
      return { scriptRequests: scripts.length, scriptDecodedBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        resourceRequests: entries.length, longTasks: (window as any).__gscStartupTasks || [] };
    });
    return { ...page, navigationMs: this.navigationMs, readyMs: this.startupReadyAt - this.startupStartedAt,
      firstGraphFrameMs: this.paints[0] ? this.paints[0].paintedAt - this.startupStartedAt : null,
      latestGraphFrameMs: this.paints.length ? this.paints[this.paints.length - 1].paintedAt - this.startupStartedAt : null };
  }

  /** 기존 renderer가 실제로 보낸 메시지만 VS Code transport 대역에 연결한다. */
  onMessage(listener: (message: FromWebviewMessage) => Promise<void> | void): void { this.inbound = listener; }

  /** backend에 직접 메시지를 주입하지 않고 렌더된 컨트롤의 일반 click을 실행한다. */
  async clickControl(selector: string, button: "left" | "right" = "left"): Promise<void> {
    await this.queue;
    await this.page.locator(selector).click({ button });
  }

  /** 실제 우클릭 메뉴의 접근성 항목을 눌러 commit 명령도 backend 주입 없이 검증한다. */
  async clickMenuItem(name: string): Promise<void> {
    await this.queue;
    await this.page.getByRole("menuitem", { name, exact: true }).click();
  }

  /** Native 비교 전에 실제 목록이 요청한 크기로 표시됐는지 읽는다. DOM 생성이나 측정용 예열은 하지 않는다. */
  async countElements(selector: string): Promise<number> {
    await this.queue;
    return this.page.locator(selector).count();
  }

  /** 접근성 이름으로 실제 버튼을 눌러 rebase 계획처럼 동적으로 만들어지는 컨트롤도 검사한다. */
  async clickNamedControl(name: string): Promise<void> {
    await this.queue;
    await this.page.getByRole("button", { name, exact: true }).click();
  }

  /** opt-in 자원 계측에서만 browser process별 누적 counter를 읽고 CDP 연결을 즉시 해제한다. */
  async readCpuProcesses():Promise<BrowserCpuProcess[]>{
    const session=await this.browser.newBrowserCDPSession();
    try{const result=await session.send("SystemInfo.getProcessInfo");return result.processInfo as BrowserCpuProcess[];}
    finally{await session.detach();}
  }

  /**
   * opt-in 진단에서만 실제 페이지의 JS CPU profile을 수집한다. 외부 포트나 OS 창은 열지 않는다.
   * @param name 소유 fixture의 작업 이름 @returns idempotent 종료 함수. 요청하지 않았으면 undefined
   */
  async startCpuProfile(name: string): Promise<{ stop(): Promise<void> } | undefined> {
    const directory = process.env.GSC_BENCH_RENDERER_PROFILE_DIR;
    if (!directory) return undefined;
    const session = await this.page.context().newCDPSession(this.page);
    try {
      await session.send("Profiler.enable");
      await session.send("Profiler.setSamplingInterval", { interval: 1000 });
      await session.send("Profiler.start");
    } catch (error) { await session.detach(); throw error; }
    let stopping: Promise<void> | undefined;
    /** 실제 작업·최종 frame 뒤 샘플을 저장하며 실패해도 CDP 연결을 해제한다. */
    const stop = async (): Promise<void> => {
      try {
        const { profile } = await session.send("Profiler.stop");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${name.replace(/[^a-z0-9-]/gi, "-")}.cpuprofile`), JSON.stringify(profile));
      } finally { await session.detach(); }
    };
    return { stop: () => stopping ??= stop() };
  }

  /** 계측 종료 전에 마지막 게시 ACK와 두 frame을 기다린다. 사후 Native oracle은 실행하지 않는다. */
  async waitForPendingFrame(latest?:GraphRenderPerformance):Promise<void>{
    await this.queue;
    const matches=()=>!latest||this.paints.some(paint=>paint.performance.traceId===latest.traceId&&paint.performance.kind===latest.kind&&paint.performance.sentAt===latest.sentAt);
    const deadline=Date.now()+5000;while(!matches()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(matches(),"Resource phase ended before its final Graph frame");
    await this.waitForAllMessageFrame();
    await this.page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    assert.deepEqual(this.errors,[]);
  }

  /** GraphPanel이 게시한 원본 메시지를 순서대로 실제 renderer에 전달하며 실패를 마지막 검증까지 보존한다. */
  post(message: ToWebviewMessage): void {
    const payload = structuredClone(message);
    if (!this.mounted) { this.buffered.push(payload); return; }
    const sequence = ++this.messageSequence;
    this.queue = this.queue.then(async () => {
      assert.ok(this.mounted, "Live renderer must be mounted before Graph loading");
      if (this.observeAllMessages) await this.page.evaluate(({data,sequence}) => {
        (window as any).__gscObserveMessageFrame(sequence);
        window.dispatchEvent(new MessageEvent("message", {data}));
      }, {data:payload,sequence});
      else await this.page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), payload);
    });
    // 호출자는 postMessage를 await하지 않으므로 unhandled rejection을 막고 verify에서 원래 오류를 전파한다.
    void this.queue.catch(() => undefined);
  }

  /** Graph ACK와 별도로 tag·PR 배지·메뉴·busy를 포함한 마지막 전달 메시지의 두 frame을 기다린다. */
  private async waitForAllMessageFrame(): Promise<void> {
    if (!this.observeAllMessages) return;
    await this.queue;
    const deadline = Date.now() + 5000;
    while (this.messageFrame.sequence < this.messageSequence && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(this.messageFrame.sequence, this.messageSequence, "Last host message did not reach two renderer frames");
  }

  /** 실제 ACK 이후 HEAD·ref·local-only를 host snapshot과 대조하고 최종 metadata 게시의 frame도 따로 기다린다. */
  async verify(commits: readonly Commit[], head: string, operationEndedAt: number, graphAlreadyCurrent: boolean,
    latest?: GraphRenderPerformance, currentBranch?: string, remoteTags: readonly NativeRemoteTag[] = []) {
    await this.queue;
    /** 같은 refresh라도 첫 이력과 늦은 색상 게시를 혼동하지 않게 최종 게시의 정확한 metadata를 확인한다. */
    const finalPaint = () => latest && this.paints.find(paint => paint.performance.traceId === latest.traceId &&
      paint.performance.kind === latest.kind && paint.performance.sentAt === latest.sentAt);
    const deadline = Date.now() + 5000;
    while (((!graphAlreadyCurrent && !this.paints.some(paint => paint.performance.sentAt >= operationEndedAt)) ||
      (latest && !finalPaint())) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const paint = this.paints.find(item => item.performance.sentAt >= operationEndedAt);
    assert.ok(paint || graphAlreadyCurrent, "Latest Git mutation never crossed the real renderer frame boundary");
    const latestPaint = finalPaint();
    assert.ok(!latest || latestPaint, "Final local-only/metadata publication never crossed the renderer frame boundary: " +
      JSON.stringify({ expected: latest, received: this.paints.map(paint => paint.performance) }));
    // tagStatus는 graphRendered와 별도 게시다. 전달 queue와 두 frame을 지난 최종 장식도 검사한다.
    await this.queue;
    await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await this.waitForAllMessageFrame();
    const rows = await this.page.locator("#graph-content > .row[data-hash]").evaluateAll(elements => elements
      .filter(element => /^[a-f0-9]{40,64}$/.test((element as HTMLElement).dataset.hash || ""))
      .map(element => ({ hash: (element as HTMLElement).dataset.hash!, refs: ((element as HTMLElement).dataset.refs || "").split("\t").filter(Boolean),
        localOnly: ((element as HTMLElement).dataset.localOnlyBranches || "").split("\t").filter(Boolean),
        head: !!element.querySelector(".ref.head"), branches: Array.from(element.querySelectorAll<HTMLElement>("[data-branch-name]"), chip => chip.dataset.branchName) })));
    assert.equal(rows.length, commits.length, "Every loaded real Git commit must reach the DOM");
    const expected = expectedRenderedRefs(commits, remoteTags);
    const expectedLocalOnly = new Map(commits.map(commit => [commit.hash, [...commit.localOnlyBranches ?? []].sort()]));
    for (const row of rows) {
      assert.deepEqual([...new Set(row.refs)].sort(), expected.get(row.hash), `Stale refs on ${row.hash}`);
      assert.deepEqual([...row.localOnly].sort(), expectedLocalOnly.get(row.hash), `Stale local-only markers on ${row.hash}`);
    }
    const headCommit = commits.find(commit => commit.hash === head);
    assert.deepEqual(rows.filter(row => row.head).map(row => row.hash), headCommit ? [head] : [], "Rendered HEAD badge differs from the native loaded page");
    if (currentBranch) assert.deepEqual(await this.page.locator("#graph-content > .row .current-local[data-branch-name]")
      .evaluateAll(chips => chips.map(chip => (chip as HTMLElement).dataset.branchName)), headCommit ? [currentBranch] : [],
      "Rendered current-branch chip differs from the Native checkout");
    const positionedRows = await this.page.locator("#graph-content > .row[data-hash]").evaluateAll(elements => elements
      .map(element => getComputedStyle(element).top));
    assert.ok(positionedRows.every(top => top !== "auto"), "Production CSP blocked Graph row positions");
    const current = headCommit?.refs.find(ref => ref !== "HEAD" && !ref.startsWith("tag:") && !ref.includes("/"));
    if (current) assert.ok(rows.find(row => row.hash === head)?.branches.includes(current), "Current branch chip is missing");
    assert.deepEqual(this.errors, [], "Live renderer reported errors");
    return { mode: "headless-production-html", renderedRows: rows.length, exactRefs: true, exactRemoteTags: true, exactHeadBadge: true, exactLocalOnly: true, headInLoadedPage: !!headCommit,
      ...(this.observeAllMessages ? { allMessageFrameMs: Math.max(0, this.messageFrame.paintedAt - operationEndedAt),
        allMessageFrameScope: "last delivered host message plus two renderer frames; includes nonvisual messages; distinct from Graph model ACK",
        allMessageSequence: this.messageFrame.sequence } : {}),
      mutationToFrameMs: paint ? Math.max(0, paint.paintedAt - operationEndedAt) : null,
      latestMutationToFrameMs: latestPaint ? Math.max(0, latestPaint.paintedAt - operationEndedAt) : null,
      renderMs: paint ? paint.renderedAt - paint.receivedAt : null, frameMs: paint ? paint.paintedAt - paint.renderedAt : null,
      latestRenderMs: latestPaint ? latestPaint.renderedAt - latestPaint.receivedAt : null,
      latestFrameMs: latestPaint ? latestPaint.paintedAt - latestPaint.renderedAt : null };
  }

  /** 마지막 실제 Graph를 세 viewport에서 촬영하고 commit 선택도 renderer의 정상 click 경로로 확인한다. */
  async capture(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
      await this.page.setViewportSize({ width, height });
      await this.page.keyboard.press("Escape");
      await this.page.locator("#graph-content > .row .commit-hash").first().click();
      assert.equal(await this.page.locator("#graph-content > .row.selected").count(), 1);
      await this.page.keyboard.press("Escape");
      await this.page.locator("#graph").evaluate(element => { element.scrollLeft = 0; });
      // drawer 닫힘 transition의 중간 위치가 QA 이미지에 남지 않게 유한 animation을 완료한 상태로 촬영한다.
      await this.page.screenshot({ path: path.join(directory, `live-graph-${width}.png`), animations: "disabled" });
    }
    assert.deepEqual(this.errors, []);
  }

  /** Chromium과 page를 함께 닫아 테스트가 사용한 background 프로세스를 남기지 않는다. */
  async dispose(): Promise<void> { await this.queue.catch(() => undefined); await this.browser.close(); }
}
