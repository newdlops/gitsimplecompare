import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { nativeBlameOverlayRendererScript } from "../src/providers/nativeBlameOverlayPatch";
import type { BlockBlameGutterSnapshot } from "../src/ui/blockBlameGutter";

/** renderer가 사용하는 DOM·event 계약만 재현하며 라벨 identity와 생성 개수를 관찰한다. */
class Element {
  constructor(readonly tagName = "div") {}
  readonly nodeType = 1;
  readonly children: Element[] = [];
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  parent?: Element;
  className = "";
  id = "";
  tabIndex = -1;
  clientWidth = 1000;
  clientHeight = 800;
  top = 0;
  hovered = false;
  hidden = false;
  disabled = false;
  ownerDocument?: Element;
  activeElement?: Element | null;
  private text = "";

  /** 테스트 class selector를 실제 className에 매칭한다. */
  readonly classList = { contains: (name: string) => this.className.split(" ").includes(name) };

  /** DOM 부모가 없는 제거된 label은 hover 대상에서 제외한다. */
  get isConnected(): boolean { return !!this.parent || this.className === "document"; }
  /** 실제 textContent 쓰기처럼 자식 node를 제거해 파괴적인 repaint를 탐지한다. */
  set textContent(value: string) { this.text = value; for (const child of [...this.children]) child.remove(); }
  /** label 또는 tooltip의 안전한 plain text 내용을 읽는다. */
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  /** 실제 호버의 공동 작성자 갱신이 기존 child를 해제하는 DOM 계약이다. */
  get firstChild(): Element | undefined { return this.children[0]; }
  /** 제거된 자식은 parent 관계와 함께 해제한다. */
  removeChild(child: Element): void { child.remove(); }
  /** keyboard로 진입한 실제 activeElement와 focus event를 함께 재현한다. */
  focus(): void { if (this.ownerDocument) this.ownerDocument.activeElement = this; this.dispatch("focus"); }
  /** layer에 새 label을 붙일 때 부모 관계도 함께 설정한다. */
  appendChild(child: Element): Element { child.remove(); this.children.push(child); child.parent = this; return child; }
  /** cleanup과 viewport 교체에서 node를 실제로 떼어낸다. */
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
  /** renderer의 data/ARIA 속성 쓰기를 저장한다. */
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  /** renderer가 라인 번호와 tooltip을 읽을 때 저장한 속성을 반환한다. */
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  /** hover 해제 시 aria-describedby도 함께 제거되는지 관찰한다. */
  removeAttribute(key: string): void { this.attributes.delete(key); }
  /** pointer/focus/Escape listener를 실제 node 수명에 연결한다. */
  addEventListener(name: string, callback: (event: any) => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
  }
  /** hover cleanup에서 문서 key listener를 제거한다. */
  removeEventListener(name: string, callback: (event: any) => void): void { this.listeners.get(name)?.delete(callback); }
  /** 자동 테스트가 사용자 hover·focus·Escape와 같은 등록 listener를 실행한다. */
  dispatch(name: string, event: any = {}): void {
    if (name === "pointerenter") this.hovered = true;
    if (name === "pointerleave") this.hovered = false;
    if (name === "focus" && this.ownerDocument) this.ownerDocument.activeElement = this;
    if (name === "blur" && this.ownerDocument) this.ownerDocument.activeElement = event.relatedTarget;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  /** 관련 tooltip으로 이동한 경우 pointerleave가 닫지 않아야 함을 확인한다. */
  contains(node: Element | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  /** renderer에서 쓰는 class·쉼표 selector만 처리한다. */
  matches(selector: string): boolean {
    if (selector === ":hover") return this.hovered;
    return selector.split(",").some(part => {
      if (part.includes(":not([hidden])") && this.hidden || part.includes(":not(:disabled)") && this.disabled) return false;
      const simple = part.trim().replace(/:not\([^)]*\)/g, "");
      return simple.startsWith(".") ? this.classList.contains(simple.slice(1)) : this.tagName === simple;
    });
  }
  /** workbench theme root와 own overlay의 부모를 찾는다. */
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  /** DOM 트리에서 단순 selector에 해당하는 모든 node를 반환한다. */
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  /** margin/layer/line-number 조회와 글꼴 측정의 descendant selector를 처리한다. */
  querySelector(selector: string): Element | null {
    if (selector.includes(" ")) {
      const [parent, child] = selector.split(" ");
      return this.querySelector(parent)?.querySelector(child) ?? null;
    }
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** 화면 배치용 측정값을 반환하고 style.top을 따라 스크롤 재배치를 반영한다. */
  getBoundingClientRect() {
    const width = this.classList.contains("gsc-native-blame-hover") ? 300 : 160;
    const height = this.classList.contains("gsc-native-blame-hover") ? 90 : 20;
    const top = this.top + (parseFloat(this.style.top) || 0), left = parseFloat(this.style.left) || 0;
    return { width, height, top, left, right: left + width, bottom: top + height };
  }
}

/** 실제 renderer script를 별도 VM에 설치하고 가짜 Monaco의 표시 이벤트만 제공한다. */
function fixture(lineCount = 10) {
  const document = new Element(); document.className = "document";
  const head = document.appendChild(new Element()), body = document.appendChild(new Element());
  const dom = body.appendChild(new Element()); dom.className = "monaco-editor";
  const host = dom.appendChild(new Element()); host.className = "overflow-guard";
  const margin = host.appendChild(new Element()); margin.className = "margin-view-overlays";
  const rows = Array.from({ length: 3 }, (_, index) => {
    const row = margin.appendChild(new Element()); row.top = 60 + index * 20;
    const number = row.appendChild(new Element()); number.className = "line-numbers";
    number.setAttribute("data-line-number", String(index + 1));
    return row;
  });
  let uri = "file:///repo/code.ts", scans = 0, created = 0;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const events = new Map<string, () => void>(), options: any[] = [];
  let id = 0;
  const editor: any = {
    getModel: () => ({ uri: { toString: () => uri } }),
    getDomNode: () => dom,
    getRawOptions: () => ({ lineDecorationsWidth: 10 }),
    getLayoutInfo: () => ({ contentLeft: 310 }),
    updateOptions: (value: unknown) => { options.push(value); },
  };
  for (const name of ["onDidScrollChange", "onDidLayoutChange", "onDidChangeModel", "onDidDispose"]) {
    editor[name] = (callback: () => void) => { events.set(name, callback); return { dispose: () => events.delete(name) }; };
  }
  const requests: any[] = [], windowEvents = new Element();
  const window: any = { __gscNativeBlameEditor: editor, innerWidth: 1440, innerHeight: 900,
    gscNativeDiffOverlayToggle: (payload: string) => requests.push(JSON.parse(payload)),
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    getComputedStyle: () => ({ fontFamily: "monospace", fontSize: "13px" }) };
  Object.assign(document, { head, body, createElement: (tag: string) => { created++; const element = new Element(tag); element.ownerDocument = document; return element; },
    getElementById: (value: string) => document.querySelectorAll(".never").find(element => element.id === value)
      ?? [...head.children, ...body.children].find(element => element.id === value) });
  const context = vm.createContext({ window, document, navigator: { language: "en" },
    requestAnimationFrame: (callback: () => void) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (value: number) => frames.delete(value),
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; },
    clearTimeout: (value: number) => timers.delete(value),
  });
  vm.runInContext(nativeBlameOverlayRendererScript(), context);
  const hash = "a".repeat(40);
  const lines = new Proxy(Array.from({ length: lineCount }, (_, index) => ({ line: index + 1, commit: hash, label: `Author ${index} · 2026-10-07`,
    tooltip: `Line ${index + 1}\nAuthor <author@example.test>\n${"a".repeat(40)} · 2026-10-07\nPlain <script>alert(1)</script> message` })), {
    get(target, key, receiver) { if (key === "forEach") scans++; return Reflect.get(target, key, receiver); },
  });
  const snapshot: BlockBlameGutterSnapshot = { uri, revision: 1, columnWidthCh: 23, lines, repoRoot: "/repo", locale: "en",
    commits: { [hash]: { hash, authorName: "Author", authorEmail: "author@example.test", authorDateIso: "2026-10-07T09:00:00+09:00",
      message: "Plain <script>alert(1)</script> message" } } };
  /** requestAnimationFrame만 완료시켜 각 스크롤 프레임의 node 재사용을 검사한다. */
  const flushFrames = () => { for (const [key, callback] of [...frames]) { frames.delete(key); callback(); } };
  /** Monaco의 이벤트를 발생시킨 뒤 예약한 프레임을 처리한다. */
  const emit = (name: string) => { events.get(name)?.(); flushFrames(); };
  /** CodeLens layout 안정화용 후속 paint를 실행한다. */
  const followUp = () => { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } flushFrames(); };
  return { window, document, dom, rows, events, options, snapshot, requests, overlay: window.__gscNativeBlameOverlay,
    labels: () => dom.querySelectorAll(".gsc-native-blame-row"), hover: () => body.querySelector(".gsc-native-blame-hover"),
    scans: () => scans, created: () => created, flushFrames, emit, followUp, setUri: (value: string) => { uri = value; } };
}

test("pointer hover shows structured commit identity safely and Escape dismisses its pending consumer", () => {
  const f = fixture(); f.overlay.render(f.snapshot); f.flushFrames();
  const label = f.labels()[0];
  assert.equal(label.tabIndex, 0);
  label.dispatch("pointerenter");
  const hover = f.hover()!;
  assert.equal(hover.getAttribute("role"), "dialog");
  assert.ok((hover.querySelector("button") as any).title.includes("a".repeat(40)));
  assert.ok(hover.textContent.includes("<script>alert(1)</script>"));
  assert.equal(hover.querySelectorAll("script").length, 0, "Git metadata must never become executable markup");
  assert.equal(f.requests[0].action, "load");
  assert.equal(label.getAttribute("aria-describedby"), "gsc-native-blame-hover");
  f.document.dispatch("keydown", { key: "Escape" });
  assert.equal(f.hover(), null);
  assert.equal(label.getAttribute("aria-describedby"), null);
  assert.equal(f.document.listeners.get("keydown")?.size, 0);
  assert.equal(f.requests.at(-1).action, "dismiss");
  f.overlay.render(null);
});

test("follow-up paints preserve label identity and its open hover without rescanning a large file", () => {
  const f = fixture(50_000); f.overlay.render(f.snapshot); f.flushFrames();
  const label = f.labels()[0]; label.dispatch("pointerenter");
  const hover = f.hover(), created = f.created();
  f.followUp(); f.followUp();
  assert.equal(f.scans(), 1, "each snapshot should be indexed only once");
  assert.equal(f.labels()[0], label);
  assert.equal(f.hover(), hover);
  assert.equal(f.created(), created, "unchanged visible lines should allocate no DOM nodes");
  assert.equal(f.labels().length, 3, "offscreen file lines should never allocate labels");
  f.overlay.render(null);
});

test("hover stays visible when Monaco focuses its editor after a gutter click", () => {
  const f = fixture(); f.overlay.render(f.snapshot); f.flushFrames();
  const label = f.labels()[0]; label.dispatch("pointerenter"); label.dispatch("focus");
  const hover = f.hover();
  label.dispatch("blur");
  assert.equal(f.hover(), hover, "editor focus must not dismiss a still-hovered label");
  label.dispatch("pointerleave");
  f.followUp();
  assert.equal(f.hover(), null);
  f.overlay.render(null);
});

test("viewport scrolling replaces only offscreen labels and closes their tooltip", () => {
  const f = fixture(50_000); f.overlay.render(f.snapshot); f.flushFrames();
  const old = f.labels()[0]; old.dispatch("pointerenter");
  f.rows[0].querySelector(".line-numbers")!.setAttribute("data-line-number", "1000");
  f.emit("onDidScrollChange");
  assert.equal(old.isConnected, false);
  assert.equal(f.labels().length, 3);
  assert.equal(f.scans(), 1);
  assert.equal(f.hover(), null);
  assert.ok(f.labels().some(label => label.getAttribute("data-gsc-line") === "1000"));
  f.overlay.render(null);
});

test("keyboard focus shows hover within a narrow viewport and cleanup restores width and listeners", () => {
  const f = fixture(); f.window.innerWidth = 320; f.window.innerHeight = 200;
  f.overlay.render(f.snapshot); f.flushFrames();
  const label = f.labels()[0]; label.dispatch("focus");
  const hover = f.hover()!, box = hover.getBoundingClientRect();
  assert.ok(box.left >= 8 && box.right <= 312);
  assert.ok(box.top >= 8 && box.bottom <= 192);
  label.dispatch("blur"); f.followUp(); assert.equal(f.hover(), null);
  label.dispatch("focus");
  f.overlay.render(null);
  assert.equal(f.labels().length, 0);
  assert.equal(f.hover(), null);
  assert.equal(f.events.size, 0);
  assert.equal(f.options.at(-1).lineDecorationsWidth, 10);
});

test("refresh replaces hover contents and a changed editor model removes stale labels", () => {
  const f = fixture(); f.overlay.render(f.snapshot); f.flushFrames();
  const label = f.labels()[0]; label.dispatch("pointerenter");
  const hash = "b".repeat(40);
  const next = { ...f.snapshot, revision: 2, lines: [{ ...f.snapshot.lines[0], commit: hash, tooltip: "Another exact commit" }],
    commits: { [hash]: { ...f.snapshot.commits!["a".repeat(40)], hash, message: "Another exact commit" } } };
  f.overlay.render(next); f.flushFrames();
  assert.equal(f.hover(), null);
  assert.equal(f.labels().length, 1);
  assert.equal(f.labels()[0], label);
  label.dispatch("focus"); assert.ok(f.hover()!.textContent.includes("Another exact commit"));
  f.setUri("file:///repo/other.ts"); f.emit("onDidChangeModel");
  assert.equal(f.labels().length, 0);
  assert.equal(f.hover(), null);
  f.overlay.render(null);
});
