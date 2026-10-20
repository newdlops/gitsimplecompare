// 실제 Git/GraphPanel의 게시를 production HTML·JS와 연결하는 headless 검증 transport다.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { Commit } from "../../src/graph/graphTypes";
import type { FromWebviewMessage, GraphRenderPerformance, ToWebviewMessage } from "../../src/webview/graphProtocol";

type Paint = Extract<FromWebviewMessage, { type: "graphRendered" }>;

/** OS 창을 만들지 않고 renderer의 실제 메시지 처리·두 frame ACK·DOM 최신 상태를 확인한다. */
export class GraphLiveRenderer {
  private queue = Promise.resolve();
  private readonly paints: Paint[] = [];
  private readonly buffered: ToWebviewMessage[] = [];
  private readonly errors: string[] = [];
  private mounted = false;

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

  /** production HTML의 nonce/CSP를 유지하고 fixture origin의 로컬 media 파일만 제공한다. 외부 통신은 차단한다. */
  async mount(html: string): Promise<void> {
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce, "Production Graph CSP nonce is missing");
    const bridge = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:message=>window.__gscLivePost(message),getState:()=>undefined,setState:()=>{}});</script>`;
    const theme = `html,body{color-scheme:dark;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#454545;--vscode-focusBorder:#007fd4;--vscode-icon-foreground:#c5c5c5;--vscode-toolbar-hoverBackground:#3a3d41;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff}`;
    const document = html.replace("<head>", `<head>${bridge}`).replace("</head>", `<link rel="stylesheet" href="https://gsc.fixture/media/__fixture-theme.css"></head>`);
    this.page.on("pageerror", error => this.errors.push(error.message));
    this.page.on("console", message => { if (message.type() === "error") this.errors.push(message.text()); });
    await this.page.exposeFunction("__gscLivePost", (message: FromWebviewMessage) => {
      if (message.type === "graphRendered") this.paints.push(message);
      if (message.type === "resyncGraph") this.errors.push("Renderer requested transport resync");
    });
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
    await this.page.goto("https://gsc.fixture/");
    this.mounted = true;
    for (const message of this.buffered.splice(0)) this.post(message);
  }

  /** GraphPanel이 게시한 원본 메시지를 순서대로 실제 renderer에 전달하며 실패를 마지막 검증까지 보존한다. */
  post(message: ToWebviewMessage): void {
    const payload = structuredClone(message);
    if (!this.mounted) { this.buffered.push(payload); return; }
    this.queue = this.queue.then(async () => {
      assert.ok(this.mounted, "Live renderer must be mounted before Graph loading");
      await this.page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), payload);
    });
    // 호출자는 postMessage를 await하지 않으므로 unhandled rejection을 막고 verify에서 원래 오류를 전파한다.
    void this.queue.catch(() => undefined);
  }

  /** 실제 ACK 이후 HEAD·ref·local-only를 host snapshot과 대조하고 최종 metadata 게시의 frame도 따로 기다린다. */
  async verify(commits: readonly Commit[], head: string, operationEndedAt: number, graphAlreadyCurrent: boolean,
    latest?: GraphRenderPerformance, currentBranch?: string) {
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
    const rows = await this.page.locator("#graph-content > .row[data-hash]").evaluateAll(elements => elements
      .filter(element => /^[a-f0-9]{40,64}$/.test((element as HTMLElement).dataset.hash || ""))
      .map(element => ({ hash: (element as HTMLElement).dataset.hash!, refs: ((element as HTMLElement).dataset.refs || "").split("\t").filter(Boolean),
        localOnly: ((element as HTMLElement).dataset.localOnlyBranches || "").split("\t").filter(Boolean),
        head: !!element.querySelector(".ref.head"), branches: Array.from(element.querySelectorAll<HTMLElement>("[data-branch-name]"), chip => chip.dataset.branchName) })));
    assert.equal(rows.length, commits.length, "Every loaded real Git commit must reach the DOM");
    const expected = new Map(commits.map(commit => [commit.hash, [...new Set(commit.refs)].sort()]));
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
    return { mode: "headless-production-html", renderedRows: rows.length, exactRefs: true, exactHeadBadge: true, exactLocalOnly: true, headInLoadedPage: !!headCommit,
      mutationToFrameMs: paint ? Math.max(0, paint.paintedAt - operationEndedAt) : null,
      latestMutationToFrameMs: latestPaint ? Math.max(0, latestPaint.paintedAt - operationEndedAt) : null,
      renderMs: paint ? paint.renderedAt - paint.receivedAt : null, frameMs: paint ? paint.paintedAt - paint.renderedAt : null };
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
      await this.page.screenshot({ path: path.join(directory, `live-graph-${width}.png`) });
    }
    assert.deepEqual(this.errors, []);
  }

  /** Chromium과 page를 함께 닫아 테스트가 사용한 background 프로세스를 남기지 않는다. */
  async dispose(): Promise<void> { await this.queue.catch(() => undefined); await this.browser.close(); }
}
