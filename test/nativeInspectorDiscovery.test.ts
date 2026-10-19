import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as http from "node:http";
import { WebSocketServer } from "ws";
import { findInspectorWebSocketUrlForPid } from "../src/providers/nativeDiffOverlayInspector";

/** 사용자 inspector와 무관한 임의 localhost 포트에서 PID 응답만 제공한다. */
async function inspector(t: TestContext, pid: number) {
  let requests = 0;
  const server = http.createServer((_req, response) => {
    requests++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify([{ webSocketDebuggerUrl: url }]));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw)); assert.equal(request.params.expression, "process.pid");
    socket.send(JSON.stringify({ id: request.id, result: { result: { value: pid } } }));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, url = `ws://127.0.0.1:${port}/isolated-inspector`;
  t.after(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { port, url, requests: () => requests };
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
