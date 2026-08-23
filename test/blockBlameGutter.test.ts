import assert from "node:assert/strict";
import test from "node:test";
import type { GitBlameLine } from "../src/git/blameService";
import { BlockBlameGutter } from "../src/ui/blockBlameGutter";
import * as vscodeMock from "./helpers/vscodeMock";

const COMMIT_A = "a".repeat(40);

/**
 * snapshot 변환 테스트가 필요한 최소 TextDocument 속성을 만든다.
 * @param lineCount 문서의 전체 논리 라인 수
 * @param version stale snapshot을 구분할 문서 version
 * @returns URI, version, lineCount를 제공하는 테스트 문서
 */
function textDocument(lineCount: number, version = 7): any {
  return {
    lineCount,
    version,
    uri: {
      toString: () => "file:///repo/src/example.ts",
    },
  };
}

/**
 * 시나리오별 작성자나 commit만 덮어쓸 수 있는 완전한 GitBlameLine을 만든다.
 * @param line 1-based 파일 라인 번호
 * @param overrides 테스트가 바꿀 blame 필드
 * @returns 거터 모델에 전달할 blame 레코드
 */
function blameLine(
  line: number,
  overrides: Partial<GitBlameLine> = {}
): GitBlameLine {
  return {
    line,
    commit: COMMIT_A,
    authorName: "Alice",
    authorMail: "alice@example.com",
    authorTime: 1_700_000_000,
    authorTz: "+0900",
    summary: "change source",
    filename: "src/example.ts",
    content: `line ${line}`,
    ...overrides,
  };
}

test("block blame은 본문 decoration 없이 정렬된 거터 snapshot만 만든다", (t) => {
  const windowApi = vscodeMock.window as any;
  const originalCreateDecoration = windowApi.createTextEditorDecorationType;
  let decorationTypeCalls = 0;
  windowApi.createTextEditorDecorationType = () => {
    decorationTypeCalls++;
    return { dispose() {} };
  };
  t.after(() => {
    windowApi.createTextEditorDecorationType = originalCreateDecoration;
  });

  const gutter = new BlockBlameGutter();
  const result = gutter.apply(textDocument(3), [
    blameLine(3, {
      authorName: "Bob",
      authorMail: "bob@example.com",
    }),
    blameLine(1),
    blameLine(3, { authorName: "Duplicate" }),
    blameLine(4, { authorName: "Outside" }),
    blameLine(0, { authorName: "Outside" }),
  ]);
  const snapshot = gutter.snapshot();

  assert.equal(decorationTypeCalls, 0);
  assert.deepEqual(result, { lineCount: 2, authorCount: 2 });
  assert.equal(snapshot?.uri, "file:///repo/src/example.ts");
  assert.equal(snapshot?.revision, 7);
  assert.equal(snapshot?.columnWidthCh, 23);
  assert.deepEqual(
    snapshot?.lines.map((line) => line.line),
    [1, 3]
  );
  assert.match(snapshot?.lines[0].label ?? "", /^Alice · 2023-11-14$/);
  assert.match(snapshot?.lines[0].tooltip ?? "", /Line 1\nAlice <alice@example.com>/);

  gutter.clear();
  assert.equal(gutter.snapshot(), undefined);
});

test("미커밋 라인과 긴 작성자는 거터 폭 안에서 안전하게 표시된다", () => {
  const gutter = new BlockBlameGutter();
  const result = gutter.apply(textDocument(2, 11), [
    blameLine(1, {
      commit: "0".repeat(40),
      authorName: "Ignored working author",
      authorMail: "",
      authorTime: undefined,
      summary: "working change",
    }),
    blameLine(2, {
      authorName: "아주아주아주아주아주아주아주긴작성자",
      authorMail: "long@example.com",
    }),
  ]);
  const snapshot = gutter.snapshot();

  assert.deepEqual(result, { lineCount: 2, authorCount: 2 });
  assert.match(snapshot?.lines[0].label ?? "", /^Working tree · Unknown date$/);
  assert.match(snapshot?.lines[0].tooltip ?? "", /Working tree/);
  assert.match(snapshot?.lines[1].label ?? "", /… · 2023-11-14$/);
  assert.ok((snapshot?.columnWidthCh ?? 0) >= 23);
  assert.ok((snapshot?.columnWidthCh ?? 100) <= 34);
});

test("dispose 뒤에는 새 거터 snapshot을 만들지 않는다", () => {
  const gutter = new BlockBlameGutter();
  gutter.apply(textDocument(1), [blameLine(1)]);
  gutter.dispose();

  const result = gutter.apply(textDocument(1, 8), [blameLine(1)]);

  assert.deepEqual(result, { lineCount: 0, authorCount: 0 });
  assert.equal(gutter.snapshot(), undefined);
});
