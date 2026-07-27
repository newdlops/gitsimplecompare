import assert from "node:assert/strict";
import test from "node:test";
import {
  createSidebarModeState,
  readSidebarModeState,
  SIDEBAR_MODE_STATE_VERSION,
} from "../src/ui/sidebarModeState";

test("sidebar mode state keeps a valid versioned Reviews selection", () => {
  assert.deepEqual(readSidebarModeState({ version: 1, mode: "reviews" }), {
    mode: "reviews",
    needsMigration: false,
  });
});

test("sidebar mode state falls back to Changes for missing or malformed values", () => {
  for (const value of [undefined, null, "reviews", { version: 0, mode: "reviews" }, { version: 1, mode: "other" }]) {
    assert.deepEqual(readSidebarModeState(value), {
      mode: "changes",
      needsMigration: true,
    });
  }
});

test("sidebar mode state writes the current versioned record", () => {
  assert.deepEqual(createSidebarModeState("changes"), {
    version: SIDEBAR_MODE_STATE_VERSION,
    mode: "changes",
  });
});
