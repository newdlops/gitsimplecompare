import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nativeConflictOverlayRendererScript } from "../src/providers/nativeConflictOverlayPatch";
import {
  applyConflictBlockChoice,
  scanConflictMarkers,
} from "../src/utils/conflictMarkerModel";

describe("conflict marker model", () => {
  it("parses a complete block and applies each native CodeLens choice", () => {
    const raw = [
      "before",
      "<<<<<<< HEAD",
      "current",
      "=======",
      "incoming",
      ">>>>>>> topic",
      "after",
      "",
    ].join("\n");
    const scan = scanConflictMarkers(raw);

    assert.equal(scan.blocks.length, 1);
    assert.deepEqual(scan.current, [2]);
    assert.deepEqual(scan.incoming, [4]);
    assert.deepEqual(scan.base, []);
    assert.deepEqual(
      scan.markers.map((marker) => marker.kind),
      ["current-start", "incoming-start", "block-end"]
    );
    const id = scan.blocks[0].id;
    assert.equal(
      applyConflictBlockChoice(raw, id, "current"),
      "before\ncurrent\nafter\n"
    );
    assert.equal(
      applyConflictBlockChoice(raw, id, "incoming"),
      "before\nincoming\nafter\n"
    );
    assert.equal(
      applyConflictBlockChoice(raw, id, "both"),
      "before\ncurrent\nincoming\nafter\n"
    );
  });

  it("excludes the diff3 Base section and preserves CRLF bytes", () => {
    const raw = [
      "<<<<<<< ours",
      "current",
      "||||||| base",
      "ancestor",
      "=======",
      "incoming",
      ">>>>>>> theirs",
      "",
    ].join("\r\n");
    const scan = scanConflictMarkers(raw);

    assert.equal(scan.blocks[0].baseLine, 2);
    assert.deepEqual(scan.current, [1]);
    assert.deepEqual(scan.base, [3]);
    assert.deepEqual(scan.incoming, [5]);
    assert.equal(
      applyConflictBlockChoice(raw, scan.blocks[0].id, "both"),
      "current\r\nincoming\r\n"
    );
  });

  it("handles multiple blocks without changing surrounding text", () => {
    const raw = [
      "top",
      "<<<<<<< a",
      "a1",
      "=======",
      "b1",
      ">>>>>>> b",
      "middle",
      "<<<<<<< a",
      "a2",
      "=======",
      "b2",
      ">>>>>>> b",
      "bottom",
    ].join("\n");
    const scan = scanConflictMarkers(raw);

    assert.equal(scan.blocks.length, 2);
    const first = applyConflictBlockChoice(raw, scan.blocks[0].id, "incoming");
    assert.ok(first?.includes("b1\nmiddle\n<<<<<<< a"));
    const rescanned = scanConflictMarkers(first!);
    assert.equal(rescanned.blocks.length, 1);
    assert.equal(
      applyConflictBlockChoice(first!, rescanned.blocks[0].id, "current"),
      "top\nb1\nmiddle\na2\nbottom"
    );
  });

  it("rejects incomplete, nested, duplicate, and out-of-order marker streams", () => {
    const malformed = [
      "<<<<<<< a\na\n=======\n=======\nb\n>>>>>>> b",
      "<<<<<<< a\na\n||||||| base\n||||||| duplicate\n=======\nb\n>>>>>>> b",
      "<<<<<<< a\na\n<<<<<<< nested\nb\n=======\nc\n>>>>>>> b",
      "<<<<<<< a\na\n=======\nb",
      "=======\norphan\n>>>>>>> orphan",
    ];

    for (const raw of malformed) {
      const scan = scanConflictMarkers(raw);
      assert.equal(scan.blocks.length, 0, raw);
      assert.deepEqual(scan.markers, [], raw);
      assert.equal(applyConflictBlockChoice(raw, "0:5", "both"), undefined);
    }
  });

  it("rejects a stale block id after lines move", () => {
    const raw = "<<<<<<< a\na\n=======\nb\n>>>>>>> b\n";
    const id = scanConflictMarkers(raw).blocks[0].id;
    assert.equal(
      applyConflictBlockChoice("prefix\n" + raw, id, "current"),
      undefined
    );
  });
});

describe("native conflict renderer patch", () => {
  it("emits syntactically valid renderer JavaScript", () => {
    const script = nativeConflictOverlayRendererScript();
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /aria-busy/);
    assert.match(script, /data-gsc-paint-key/);
    assert.match(script, /overscroll-behavior:contain/);
  });
});
