import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import { WebSocketServer } from "ws";
import { NativeOverlayConnection } from "../src/providers/nativeOverlayConnection";
import * as vscode from "vscode";
import { NativeInspectorPortHints } from "../src/providers/nativeInspectorPortHints";
import { findInspectorWebSocketUrlForPid, clearInspectorPortHints } from "../src/providers/nativeDiffOverlayInspector";

/** 사용자 inspector와 무관한 임의 localhost 포트에서 PID 응답만 제공한다. */
async function inspector(t: TestContext, pid: number) {
  let requests = 0, probes = 0, currentPid = pid, closed = false;
  const server = http.createServer((_req, response) => {
    requests++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify([{ webSocketDebuggerUrl: url }]));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", socket => socket.on("message", raw => {
    probes++; const request = JSON.parse(String(raw)); assert.equal(request.params.expression, "process.pid");
    socket.send(JSON.stringify({ id: request.id, result: { result: { value: currentPid } } }));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, url = `ws://127.0.0.1:${port}/isolated-inspector`;
  const close = async () => {
    if (closed) return; closed = true;
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  t.after(close);
  return { port, url, requests: () => requests, probes: () => probes, setPid: (value: number) => { currentPid = value; }, close };
}

test("a ready preferred inspector is found without the old fixed timer or probing other ports", { timeout: 5000 }, async t => {
  const first = await inspector(t, 456789), other = await inspector(t, 123);
  const nativeTimeout = setTimeout;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(); t.after(() => controller.abort());
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([findInspectorWebSocketUrlForPid(456789, controller.signal, [first.port, other.port]),
      new Promise<never>((_resolve, reject) => { timer = nativeTimeout(() => reject(new Error("A ready inspector waited for a timer.")), 2000); })]);
    assert.equal(result, first.url); assert.equal(first.requests(), 1); assert.equal(other.requests(), 0);
  } finally { clearTimeout(timer!); controller.abort(); t.mock.timers.reset(); }
});

test("the preferred port must prove the expected PID before a later isolated target is used", async t => {
  const wrong = await inspector(t, 123), expected = await inspector(t, 456789);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, [wrong.port, expected.port]), expected.url);
  assert.equal(wrong.requests(), 1); assert.equal(expected.requests(), 1);
});

test("a cancelled inspector lookup opens no port and sends no signal", async t => {
  const server = await inspector(t, 456789), controller = new AbortController(); controller.abort();
  assert.equal(await findInspectorWebSocketUrlForPid(456789, controller.signal, [server.port]), undefined);
  assert.equal(server.requests(), 0);
});


test("a non-default reconnect probes only its successful port and rechecks the real PID", async t => {
  const preferred = await inspector(t, 123), target = await inspector(t, 456789);
  const ports = [preferred.port, target.port], profile = "hint-warm";
  t.after(() => clearInspectorPortHints(profile));
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile), target.url);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile), target.url);
  assert.equal(preferred.requests(), 1); assert.equal(target.requests(), 2); assert.equal(target.probes(), 2);
});

test("a preferred-port hint never duplicates the default probe within a discovery round", async t => {
  const target = await inspector(t, 456789), other = await inspector(t, 123), profile = "hint-default";
  t.after(() => clearInspectorPortHints(profile));
  for (let repeat = 0; repeat < 2; repeat++) assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, [target.port, other.port], profile), target.url);
  assert.equal(target.requests(), 2); assert.equal(other.requests(), 0);
});

test("a hint proving a different PID is discarded before returning to the preferred port", async t => {
  const preferred = await inspector(t, 123), target = await inspector(t, 456789), ports = [preferred.port, target.port], profile = "hint-pid";
  t.after(() => clearInspectorPortHints(profile));
  await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile);
  target.setPid(123); preferred.setPid(456789);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile), preferred.url);
  assert.equal(target.probes(), 2); assert.equal(preferred.requests(), 2);
});

test("closed hinted ports fall back while different profiles and changed port sets never reuse the shortcut", async t => {
  const preferred = await inspector(t, 123), target = await inspector(t, 456789), replacement = await inspector(t, 456789);
  const ports = [preferred.port, target.port];
  t.after(() => { for (const profile of ["hint-one", "hint-two"]) clearInspectorPortHints(profile); });
  await findInspectorWebSocketUrlForPid(456789, undefined, ports, "hint-one");
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, "hint-two"), target.url);
  assert.equal(preferred.requests(), 2);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, [preferred.port, replacement.port, target.port], "hint-one"), replacement.url);
  await target.close(); preferred.setPid(456789);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, "hint-one"), preferred.url);
});

test("pre-abort drops a prior hint and connection shutdown clears only its profile lifetime", async t => {
  const preferred = await inspector(t, 123), target = await inspector(t, 456789), ports = [preferred.port, target.port], profile = "/tmp/gsc-discovery-profile";
  t.after(() => { clearInspectorPortHints(profile); clearInspectorPortHints(profile + "-other"); });
  await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile);
  const controller = new AbortController(); controller.abort();
  assert.equal(await findInspectorWebSocketUrlForPid(456789, controller.signal, ports, profile), undefined);
  preferred.setPid(456789);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile), preferred.url);
  preferred.setPid(123); clearInspectorPortHints(profile);
  await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile);
  await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile + "-other");
  const connection = new NativeOverlayConnection(vscode.Uri.file(profile), () => {});
  connection.beginShutdown(); preferred.setPid(456789);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile), preferred.url);
  assert.equal(await findInspectorWebSocketUrlForPid(456789, undefined, ports, profile + "-other"), target.url);
});

test("port hints retain at most sixteen LRU records and key PID/profile/configured-port sets independently", () => {
  const hints = new NativeInspectorPortHints(), ports = [9229, 9230];
  for (let pid = 1; pid <= 16; pid++) hints.remember(pid, "profile", ports, 9230);
  assert.equal(hints.get(1, "profile", [...ports].reverse()), 9230);
  hints.remember(17, "profile", ports, 9230);
  assert.equal(hints.get(2, "profile", ports), undefined); assert.equal(hints.get(1, "profile", ports), 9230);
  assert.equal(hints.get(1, "other", ports), undefined); assert.equal(hints.get(1, "profile", [9229]), undefined);
  hints.remember(1, "other", ports, 9229); hints.clear("profile");
  assert.equal(hints.get(1, "profile", ports), undefined); assert.equal(hints.get(1, "other", ports), 9229);
});
