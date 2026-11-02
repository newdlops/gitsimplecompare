import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { findInspectorWebSocketUrlForPid, clearInspectorPortHints } from "../src/providers/nativeDiffOverlayInspector";

/** 사용자 프로세스에 접근하지 않고 실제 localhost HTTP/WS만 제공하는 소유 fixture다. */
async function target(t: TestContext, pid?: number, beforeList?: () => Promise<void>, onProbe?: () => Promise<void>) {
  let requests = 0, probes = 0;
  const server = http.createServer(async (_request, response) => {
    requests++; await beforeList?.(); if (response.destroyed) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(pid === undefined ? [] : [{ webSocketDebuggerUrl: url }]));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", socket => socket.on("message", async raw => {
    const request = JSON.parse(String(raw)); assert.equal(request.params.expression, "process.pid"); probes++;
    await onProbe?.();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { result: { value: pid } } }));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, url = `ws://127.0.0.1:${port}/owned-probe`;
  t.after(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve())); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { port, url, requests: () => requests, probes: () => probes };
}

/** PID 요청을 실제로 보낸 client의 close를 관찰하며 소켓 동작은 대체하지 않는다. */
function observePidClients() {
  const original = WebSocket.prototype.send, clients = new Set<WebSocket>(), closed = new Set<WebSocket>();
  let active = 0, maximum = 0;
  WebSocket.prototype.send = function(this: WebSocket, ...args: any[]) {
    if (String(args[0]).includes('"method":"Runtime.evaluate"') && !clients.has(this)) {
      clients.add(this); maximum = Math.max(maximum, ++active);
      this.once("close", () => { closed.add(this); active--; });
    }
    return (original as any).apply(this, args);
  };
  return { clients, closed, maximum: () => maximum, restore: () => { WebSocket.prototype.send = original; } };
}

test("cold discovery verifies a ready target before an unrelated HTTP response and closes that owned request", { timeout: 5000 }, async t => {
  let release!: () => void, began!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const slowStarted = new Promise<void>(resolve => { began = resolve; });
  const first = await target(t), expected = await target(t, 456789, () => slowStarted);
  const slow = await target(t, undefined, async () => { began(); await delayed; });
  const rawHttp = require("node:http") as typeof http, original = rawHttp.get;
  let slowClosed = false;
  (rawHttp as any).get = (...args: any[]) => {
    const request: http.ClientRequest = (original as any)(...args);
    if (String(args[0]) === `http://127.0.0.1:${slow.port}/json/list`) request.once("socket", socket => socket.once("close", () => { slowClosed = true; }));
    return request;
  };
  const controller = new AbortController(), profile = "pipeline-cold";
  t.after(() => clearInspectorPortHints(profile));
  const pending = findInspectorWebSocketUrlForPid(456789, controller.signal, [first.port, expected.port, slow.port], profile);
  try {
    const early = await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    release(); assert.equal(await pending, expected.url); assert.equal(early, true); assert.equal(slowClosed, true);
    assert.equal(expected.probes(), 1); assert.equal(slow.requests(), 1);
  } finally { release(); controller.abort(); await pending; rawHttp.get = original; }
});

test("successful discovery returns only after its PID WebSocket has actually closed", async t => {
  const expected = await target(t, 456789), observed = observePidClients();
  try {
    assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, [expected.port], "pipeline-close"), expected.url);
    assert.equal(observed.clients.size, 1); assert.equal(observed.closed.size, 1);
    assert([...observed.clients].every(client => client.readyState === WebSocket.CLOSED));
  } finally { observed.restore(); clearInspectorPortHints("pipeline-close"); }
});

test("parallel HTTP completions retain one PID probe at a time and reject fast wrong owners", async t => {
  const first = await target(t), wrong = await target(t, 123, undefined, () => new Promise(resolve => setTimeout(resolve, 10)));
  const alsoWrong = await target(t, 234), expected = await target(t, 456789), observed = observePidClients();
  try {
    assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, [first.port, wrong.port, alsoWrong.port, expected.port], "pipeline-limit"), expected.url);
    assert.equal(observed.maximum(), 1); assert.equal(observed.closed.size, observed.clients.size);
  } finally { observed.restore(); clearInspectorPortHints("pipeline-limit"); }
});

test("parent cancellation joins an active PID socket and all owned HTTP probes", { timeout: 5000 }, async t => {
  let ready!: () => void, release!: () => void;
  const probing = new Promise<void>(resolve => { ready = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const first = await target(t), stalled = await target(t, 123, undefined, async () => { ready(); await blocked; });
  const other = await target(t, undefined, () => blocked), controller = new AbortController(), observed = observePidClients();
  const pending = findInspectorWebSocketUrlForPid(456789, controller.signal, [first.port, stalled.port, other.port], "pipeline-cancel");
  try {
    await probing; controller.abort(); assert.equal(await pending, undefined);
    assert.equal(observed.clients.size, 1); assert.equal(observed.closed.size, 1);
  } finally { release(); controller.abort(); await pending; observed.restore(); clearInspectorPortHints("pipeline-cancel"); }
});
