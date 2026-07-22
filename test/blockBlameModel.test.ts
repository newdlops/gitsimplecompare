import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupLineSeparatedDeclarations,
  isUncommittedBlameCommit,
  normalizeBlockBlameRequest,
  selectBlockBlameLines,
  shouldShowBlockCodeVision,
  summarizeBlockBlame,
  type SourceBlock,
} from "../src/git/blockBlameModel";
import type { GitBlameLine } from "../src/git/blameService";

/** 테스트에서 반복하는 40자리 커밋 해시를 한 문자로 만든다. */
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const UNCOMMITTED = "0".repeat(40);

/**
 * 테스트가 관심 있는 필드만 덮어쓰면서 완전한 GitBlameLine 을 만든다.
 * @param line 1-based 파일 라인
 * @param overrides 작성자/커밋/내용 등 시나리오별 값
 * @returns 집계 함수에 바로 전달할 blame 라인
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
    authorTime: 100,
    authorTz: "+0900",
    summary: "initial implementation",
    filename: "src/example.ts",
    content: `line ${line}`,
    ...overrides,
  };
}

/**
 * 테스트에 필요한 최소 SourceBlock 을 기본 함수 범위로 만든다.
 * @param overrides 범위/이름/종류를 바꿀 선택 값
 * @returns 집계 가능한 소스 블록
 */
function sourceBlock(overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: "function:2:6:example",
    name: "example",
    kind: "function",
    startLine: 2,
    endLine: 6,
    declarationLine: 2,
    ...overrides,
  };
}

describe("block blame contributor summary", () => {
  it("집계 범위의 비어 있지 않은 라인만 세고 이메일이 같은 이름 변경을 한 작업자로 묶는다", () => {
    const summary = summarizeBlockBlame(sourceBlock(), [
      blameLine(1, { authorName: "Outside" }),
      blameLine(2, { authorName: "Alice", authorTime: 100 }),
      blameLine(3, {
        commit: COMMIT_B,
        authorName: "Bob",
        authorMail: "bob@example.com",
        authorTime: 400,
        content: "   ",
      }),
      blameLine(4, {
        authorName: "Alicia",
        authorMail: "ALICE@example.com",
        authorTime: 300,
      }),
      blameLine(5, {
        commit: COMMIT_B,
        authorName: "Bob",
        authorMail: "bob@example.com",
        authorTime: 250,
      }),
      blameLine(6, { authorName: "Alice", authorTime: 200 }),
      blameLine(7, { authorName: "Outside" }),
    ]);

    assert.deepEqual(
      summary.lines.map((line) => line.line),
      [2, 3, 4, 5, 6]
    );
    assert.equal(summary.countedLineCount, 4);
    assert.equal(summary.contributors.length, 2);
    assert.deepEqual(summary.primaryContributor, {
      key: "mail:alice@example.com",
      name: "Alicia",
      mail: "ALICE@example.com",
      lineCount: 3,
      percentage: 75,
      commitCount: 1,
      latestAuthorTime: 300,
      firstLine: 2,
      uncommitted: false,
    });
    assert.equal(summary.contributors[1]?.name, "Bob");
    assert.equal(summary.contributors[1]?.percentage, 25);
    assert.equal(summary.commitCount, 2);
    assert.equal(summary.latestAuthorTime, 300);
  });

  it("라인 수가 같으면 author-time 이 더 최근인 작업자를 주요 작업자로 고른다", () => {
    const summary = summarizeBlockBlame(
      sourceBlock({ startLine: 1, endLine: 4, declarationLine: 1 }),
      [
        blameLine(1, { authorName: "Alice", authorTime: 100 }),
        blameLine(2, { authorName: "Alice", authorTime: 110 }),
        blameLine(3, {
          commit: COMMIT_B,
          authorName: "Bob",
          authorMail: "bob@example.com",
          authorTime: 200,
        }),
        blameLine(4, {
          commit: COMMIT_B,
          authorName: "Bob",
          authorMail: "bob@example.com",
          authorTime: 210,
        }),
      ]
    );

    assert.equal(summary.primaryContributor?.name, "Bob");
    assert.equal(summary.primaryContributor?.lineCount, 2);
    assert.equal(summary.primaryContributor?.percentage, 50);
    assert.equal(summary.contributors[1]?.name, "Alice");
    assert.equal(summary.commitCount, 2);
    assert.equal(summary.latestAuthorTime, 210);
  });

  it("블록 전체가 공백이면 상세 라인을 버리지 않고 공백 라인도 분모로 사용한다", () => {
    const summary = summarizeBlockBlame(
      sourceBlock({ startLine: 10, endLine: 12, declarationLine: 10 }),
      [
        blameLine(10, {
          commit: UNCOMMITTED,
          authorName: "Not Committed Yet",
          authorMail: "",
          authorTime: undefined,
          content: "",
        }),
        blameLine(11, {
          commit: UNCOMMITTED,
          authorName: "Not Committed Yet",
          authorMail: "",
          authorTime: undefined,
          content: "\t",
        }),
        blameLine(12, {
          commit: COMMIT_B,
          authorName: "Bob",
          authorMail: "bob@example.com",
          authorTime: 500,
          content: "  ",
        }),
      ]
    );

    assert.equal(summary.countedLineCount, 3);
    assert.equal(summary.primaryContributor?.key, "uncommitted");
    assert.equal(summary.primaryContributor?.lineCount, 2);
    assert.equal(summary.primaryContributor?.percentage, 67);
    assert.equal(summary.primaryContributor?.uncommitted, true);
  });

  it("같은 작성자의 여러 커밋 수를 중복 없이 계산한다", () => {
    const summary = summarizeBlockBlame(
      sourceBlock({ startLine: 1, endLine: 3, declarationLine: 1 }),
      [
        blameLine(1, { commit: COMMIT_A }),
        blameLine(2, { commit: COMMIT_A }),
        blameLine(3, { commit: COMMIT_C }),
      ]
    );

    assert.equal(summary.primaryContributor?.commitCount, 2);
    assert.equal(summary.primaryContributor?.lineCount, 3);
    assert.equal(summary.primaryContributor?.percentage, 100);
  });

  it("이메일이 없으면 trim 및 대소문자를 무시한 작성자 이름으로 묶는다", () => {
    const summary = summarizeBlockBlame(
      sourceBlock({ startLine: 1, endLine: 2, declarationLine: 1 }),
      [
        blameLine(1, { authorName: "  Casey  ", authorMail: "" }),
        blameLine(2, {
          commit: COMMIT_B,
          authorName: "casey",
          authorMail: "",
          authorTime: 200,
        }),
      ]
    );

    assert.equal(summary.contributors.length, 1);
    assert.equal(summary.primaryContributor?.key, "name:casey");
    assert.equal(summary.primaryContributor?.name, "casey");
    assert.equal(summary.primaryContributor?.commitCount, 2);
  });

  it("blame 결과가 비어 있으면 주요 작업자 없이 안전한 빈 요약을 반환한다", () => {
    const summary = summarizeBlockBlame(sourceBlock(), []);

    assert.deepEqual(summary.lines, []);
    assert.deepEqual(summary.contributors, []);
    assert.equal(summary.primaryContributor, undefined);
    assert.equal(summary.countedLineCount, 0);
    assert.equal(summary.commitCount, 0);
    assert.equal(summary.latestAuthorTime, undefined);
  });
});

describe("block blame line selection", () => {
  it("inclusive 블록 범위만 고르고 입력이 섞여 있어도 라인 순으로 정렬한다", () => {
    const selected = selectBlockBlameLines(
      { startLine: 3, endLine: 5 },
      [blameLine(5), blameLine(2), blameLine(4), blameLine(6), blameLine(3)]
    );

    assert.deepEqual(
      selected.map((line) => line.line),
      [3, 4, 5]
    );
  });

  it("끝 범위가 시작보다 작으면 시작 한 라인으로 방어적으로 보정한다", () => {
    const selected = selectBlockBlameLines(
      { startLine: 4, endLine: 2 },
      [blameLine(2), blameLine(4), blameLine(5)]
    );

    assert.deepEqual(
      selected.map((line) => line.line),
      [4]
    );
  });
});

describe("block blame Code Vision granularity", () => {
  it("최상위 함수와 구조 블록은 짧아도 독립 Code Vision으로 유지한다", () => {
    assert.equal(
      shouldShowBlockCodeVision(
        sourceBlock({ startLine: 1, endLine: 1 }),
        0
      ),
      true
    );
    assert.equal(
      shouldShowBlockCodeVision(
        sourceBlock({ kind: "interface", startLine: 1, endLine: 1 }),
        2
      ),
      true
    );
  });

  it("부모 안의 아주 작은 메서드는 부모 blame 단위에 포함한다", () => {
    assert.equal(
      shouldShowBlockCodeVision(
        sourceBlock({ kind: "method", startLine: 10, endLine: 14 }),
        1
      ),
      false
    );
    assert.equal(
      shouldShowBlockCodeVision(
        sourceBlock({ kind: "method", startLine: 10, endLine: 15 }),
        1
      ),
      true
    );
  });
});

describe("blank-line declaration grouping", () => {
  it("연속 전역 선언은 묶고 빈 라인이 나오면 첫 선언 위의 새 블록으로 나눈다", () => {
    const blocks = groupLineSeparatedDeclarations(
      [
        { name: "feature", startLine: 10, endLine: 10 },
        { name: "alpha", startLine: 1, endLine: 1 },
        { name: "beta", startLine: 2, endLine: 2 },
        { name: "User", startLine: 4, endLine: 4 },
        { name: "Admin", startLine: 5, endLine: 5 },
        { name: "config", startLine: 7, endLine: 9 },
      ],
      [
        "const alpha = 1;",
        "const beta = 2;",
        "",
        "type User = string;",
        "type Admin = User;",
        "   ",
        "const config = {",
        "",
        "};",
        "const feature = true;",
      ]
    );

    assert.deepEqual(blocks, [
      {
        id: "declarations:1:2",
        name: "alpha, beta",
        kind: "declarations",
        startLine: 1,
        endLine: 2,
        declarationLine: 1,
      },
      {
        id: "declarations:4:5",
        name: "User, Admin",
        kind: "declarations",
        startLine: 4,
        endLine: 5,
        declarationLine: 4,
      },
      {
        id: "declarations:7:10",
        name: "config, feature",
        kind: "declarations",
        startLine: 7,
        endLine: 10,
        declarationLine: 7,
      },
    ]);
  });

  it("같은 줄의 중복 심볼 이름은 한 번만 표시하고 긴 이름 목록은 개수로 줄인다", () => {
    const blocks = groupLineSeparatedDeclarations(
      [
        { name: "a", startLine: 1, endLine: 1 },
        { name: "a", startLine: 1, endLine: 1 },
        { name: "b", startLine: 1, endLine: 1 },
        { name: "c", startLine: 2, endLine: 2 },
        { name: "d", startLine: 2, endLine: 2 },
      ],
      ["const a = 1, b = 2;", "const c = 3, d = 4;"]
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.name, "a, b, c +1");
    assert.equal(blocks[0]?.declarationLine, 1);
  });

  it("빈 줄이 없어도 함수나 클래스가 사이에 있으면 선언 묶음을 겹치지 않게 나눈다", () => {
    const blocks = groupLineSeparatedDeclarations(
      [
        { name: "before", startLine: 1, endLine: 1 },
        { name: "after", startLine: 5, endLine: 5 },
      ],
      [
        "const before = 1;",
        "function run() {",
        "  return before;",
        "}",
        "const after = 2;",
      ],
      [2]
    );

    assert.deepEqual(
      blocks.map((block) => [block.startLine, block.endLine]),
      [[1, 1], [5, 5]]
    );
  });
});

describe("block blame command request", () => {
  it("직렬화 payload 의 문자열을 정리하고 알 수 없는 kind 를 일반 block 으로 보정한다", () => {
    const request = normalizeBlockBlameRequest({
      uri: "  file:///workspace/example.ts  ",
      symbolName: "  example  ",
      kind: "unexpected",
      startLine: 7,
      endLine: 19,
      documentVersion: 4,
    });

    assert.deepEqual(request, {
      uri: "file:///workspace/example.ts",
      symbolName: "example",
      kind: "block",
      startLine: 7,
      endLine: 19,
      documentVersion: 4,
    });
  });

  it("필수 문자열/정수/순서가 잘못된 command payload 를 거부한다", () => {
    const invalid = [
      undefined,
      null,
      [],
      {},
      { uri: "", symbolName: "x", startLine: 1, endLine: 1 },
      { uri: "file:///x", symbolName: "", startLine: 1, endLine: 1 },
      { uri: "file:///x", symbolName: "x", startLine: 0, endLine: 1 },
      { uri: "file:///x", symbolName: "x", startLine: 2, endLine: 1 },
      { uri: "file:///x", symbolName: "x", startLine: 1.5, endLine: 2 },
    ];

    for (const value of invalid) {
      assert.equal(normalizeBlockBlameRequest(value), undefined);
    }
  });

  it("선택적인 문서 버전이 잘못됐으면 요청은 유지하되 stale 검사를 생략한다", () => {
    const request = normalizeBlockBlameRequest({
      uri: "file:///workspace/example.ts",
      symbolName: "example",
      kind: "function",
      startLine: 1,
      endLine: 2,
      documentVersion: -1,
    });

    assert.equal(request?.kind, "function");
    assert.equal(request?.documentVersion, undefined);
  });
});

describe("uncommitted blame detection", () => {
  it("비어 있지 않은 0 해시만 미커밋 라인으로 판단한다", () => {
    assert.equal(isUncommittedBlameCommit(UNCOMMITTED), true);
    assert.equal(isUncommittedBlameCommit("0000"), true);
    assert.equal(isUncommittedBlameCommit(""), false);
    assert.equal(isUncommittedBlameCommit(COMMIT_A), false);
    assert.equal(isUncommittedBlameCommit("000a"), false);
  });
});
