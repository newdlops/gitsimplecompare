import assert from "node:assert/strict";
import test from "node:test";
import {
  createGraphRefreshErrorNotice,
  graphErrorSummary,
  publishInvalidGraphRefs,
} from "../src/webview/graphHealth";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import * as vscodeMock from "./helpers/vscodeMock";

test("damaged Graph refs are disclosed without mutating them and include OUTPUT diagnostics", () => {
  vscodeMock.__resetOutputLines();
  const messages: ToWebviewMessage[] = [];
  publishInvalidGraphRefs("/repo", [{
    name: "broken-local",
    fullRef: "refs/heads/broken-local",
    hash: "missing-object",
    kind: "local",
  }], (message) => messages.push(message));

  assert.equal(messages[0]?.type, "graphHealth");
  assert.equal(messages[0]?.type === "graphHealth" && messages[0].notice?.level, "warning");
  assert.equal(messages[0]?.type === "graphHealth" && messages[0].notice?.items?.[0]?.label, "broken-local");
  assert.ok(vscodeMock.__outputLines.some((line) =>
    line.includes("graph invalid local refs skipped") && line.includes("refs/heads/broken-local")
  ));
});

test("Graph refresh errors preserve a short fatal reason and distinguish existing content", () => {
  const error = new Error("wrapper failed\nfatal: bad object branch-tip\nextra detail");
  assert.equal(graphErrorSummary(error), "bad object branch-tip");
  assert.match(graphErrorSummary(new Error("x".repeat(300))), /…$/);
  assert.equal(graphErrorSummary(new Error("x".repeat(300))).length, 240);

  const initial = createGraphRefreshErrorNotice(error, false);
  assert.equal(initial.title, "Git graph could not be loaded.");
  assert.match(initial.detail, /repair the repository state/);
  assert.match(initial.detail, /bad object branch-tip/);

  const refresh = createGraphRefreshErrorNotice(error, true);
  assert.equal(refresh.title, "Git graph refresh failed.");
  assert.match(refresh.detail, /Existing commits remain visible/);
});
