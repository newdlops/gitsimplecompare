import assert from "node:assert/strict";
import test from "node:test";
import { scanConflictDocument } from "../src/utils/conflictDocumentScan";

/** 같은 version을 보는 split editor와 CodeLens는 공유하고 편집/다른 문서는 분리한다. */
test("native conflict scans are shared only for the same document version", () => {
  let reads = 0, text = "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> side\n";
  const document = { version: 1, getText: () => { reads++; return text; } };
  const first = scanConflictDocument(document);
  assert.equal(scanConflictDocument(document), first);
  assert.equal(reads, 1); assert.equal(first.blocks.length, 1);
  text = "prefix\n" + text; document.version++;
  const edited = scanConflictDocument(document);
  assert.notEqual(edited, first); assert.equal(edited.blocks[0].startLine, 1);
  assert.equal(reads, 2);
  const other = { ...document };
  assert.notEqual(scanConflictDocument(other), edited);
  text = "resolved\n"; document.version++;
  assert.equal(scanConflictDocument(document).blocks.length, 0);
});
