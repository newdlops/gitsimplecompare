import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommitFailureItem,
  CommitFailureReport,
} from "../src/git/commitHookFailure";
import {
  CommitPlanExecutionFailure,
  CommitPlanExecutionProgress,
  presentCommitPlanExecutionFailure,
  presentCommitPlanExecutionProgress,
} from "../src/webview/commitPlanExecutionPresentation";

/**
 * 각 테스트가 필요한 필드만 덮어쓰도록 완전한 commit 실패 보고서를 만든다.
 * @param overrides 테스트 목적에 맞게 바꿀 보고서 필드
 * @returns 서로 공유되는 배열이 없는 새 실패 보고서
 */
function failureReport(
  overrides: Partial<CommitFailureReport> = {}
): CommitFailureReport {
  const items = overrides.items ?? [
    {
      id: "failure-1",
      message: "Unexpected console statement.",
      path: "src/example.ts",
      line: 12,
      column: 4,
      severity: "error" as const,
    },
  ];
  return {
    likelyHook: true,
    hookName: "pre-commit",
    checkName: "eslint",
    summary: "ESLint validation failed.",
    outputLines: 10,
    truncated: false,
    occurredAt: "2026-07-14T00:00:00.000Z",
    operation: "commit",
    origin: "commit",
    ...overrides,
    items: items.map((item) => ({ ...item })),
  };
}

/**
 * 항목 상한 테스트에서 메시지만 다른 표준 실패 진단을 생성한다.
 * @param index 항목 순서와 id·메시지에 포함할 0부터 시작하는 번호
 * @returns 경로와 위치가 있는 오류 심각도 진단
 */
function failureItem(index: number): CommitFailureItem {
  return {
    id: `private-id-${index}`,
    message: `failure message ${index}`,
    path: `src/file-${index}.ts`,
    line: index + 1,
    column: 1,
    severity: "error",
  };
}

/**
 * 표시 모델이 Git 실행 내부 필드를 실수로 포함하지 않았는지 타입과 런타임 모두에서 검사한다.
 * @param presentation 웹뷰로 보내기 직전의 표시 모델
 * @returns assertion 성공 시 반환값 없음
 */
function assertNoPrivateExecutionFields(
  presentation: CommitPlanExecutionFailure
): void {
  const record = presentation as unknown as Record<string, unknown>;
  assert.equal("outputLines" in record, false);
  assert.equal("occurredAt" in record, false);
  assert.equal("operation" in record, false);
  assert.equal("stdout" in record, false);
  assert.equal("stderr" in record, false);
  for (const item of presentation.items) {
    assert.equal("id" in item, false);
  }
}

test("웹뷰에 필요한 표시 필드만 복사하고 원본 보고서를 변경하지 않는다", () => {
  const report = failureReport({
    likelyHook: false,
    hookName: "  commit-msg  ",
    checkName: "  commitlint  ",
    summary: "  Commit message validation failed.  ",
    items: [
      {
        id: "private-diagnostic-id",
        message: "  subject may not be empty  ",
        path: "  COMMIT_EDITMSG  ",
        line: 1,
        column: 2,
        severity: "warning",
      },
    ],
  });
  const before = structuredClone(report);

  const presentation = presentCommitPlanExecutionFailure(report);

  assert.deepEqual(presentation, {
    likelyHook: false,
    hookName: "commit-msg",
    checkName: "commitlint",
    summary: "Commit message validation failed.",
    items: [
      {
        message: "subject may not be empty",
        path: "COMMIT_EDITMSG",
        line: 1,
        column: 2,
        severity: "warning",
      },
    ],
    truncated: false,
  });
  assert.deepEqual(report, before);
  assertNoPrivateExecutionFields(presentation);
});

test("요약·항목·경로·hook과 check 이름을 각 필드 상한 안으로 자른다", () => {
  const report = failureReport({
    hookName: `  ${"h".repeat(140)}  `,
    checkName: `  ${"c".repeat(160)}  `,
    summary: `  ${"s".repeat(1_200)}  `,
    items: [
      {
        id: "failure-long",
        message: `  ${"m".repeat(2_500)}  `,
        path: `  ${"p".repeat(4_500)}  `,
        severity: "info",
      },
    ],
  });

  const presentation = presentCommitPlanExecutionFailure(report);

  assert.equal(presentation.hookName?.length, 128);
  assert.equal(presentation.checkName?.length, 128);
  assert.equal(presentation.summary.length, 1_000);
  assert.equal(presentation.items[0]?.message.length, 2_000);
  assert.equal(presentation.items[0]?.path?.length, 4_096);
  assert.equal(presentation.hookName?.endsWith("…"), true);
  assert.equal(presentation.checkName?.endsWith("…"), true);
  assert.equal(presentation.summary.endsWith("…"), true);
  assert.equal(presentation.items[0]?.message.endsWith("…"), true);
  assert.equal(presentation.items[0]?.path?.endsWith("…"), true);
  assert.equal(presentation.items[0]?.severity, "info");
  assert.equal(presentation.truncated, true);
});

test("21번째 항목을 생략하고 기존 truncated 상태도 보존한다", () => {
  const items = Array.from({ length: 21 }, (_, index) => failureItem(index));
  const presentation = presentCommitPlanExecutionFailure(
    failureReport({ items })
  );

  assert.equal(presentation.items.length, 20);
  assert.equal(presentation.items[0]?.message, "failure message 0");
  assert.equal(presentation.items[19]?.message, "failure message 19");
  assert.equal(
    presentation.items.some((item) => item.message === "failure message 20"),
    false
  );
  assert.equal(presentation.truncated, true);

  const sourceAlreadyTruncated = presentCommitPlanExecutionFailure(
    failureReport({ items: [failureItem(0)], truncated: true })
  );
  assert.equal(sourceAlreadyTruncated.truncated, true);
});

test("유효하지 않은 위치 숫자를 생략하고 허용하지 않은 severity를 error로 제한한다", () => {
  const invalidItems = [
    { line: Number.NaN, column: Number.POSITIVE_INFINITY },
    { line: 0, column: -2 },
    { line: 1.5, column: Number.MAX_SAFE_INTEGER + 1 },
  ].map((position, index) => ({
    ...failureItem(index),
    ...position,
    severity: "critical",
  }));
  const report = failureReport({
    items: invalidItems as unknown as CommitFailureItem[],
  });

  const presentation = presentCommitPlanExecutionFailure(report);

  assert.deepEqual(
    presentation.items.map((item) => ({
      line: item.line,
      column: item.column,
      severity: item.severity,
    })),
    [
      { line: undefined, column: undefined, severity: "error" },
      { line: undefined, column: undefined, severity: "error" },
      { line: undefined, column: undefined, severity: "error" },
    ]
  );
});

test("선택 문자열이 공백이거나 타입이 잘못되면 필드 자체를 생략한다", () => {
  const report = failureReport({
    hookName: "   ",
    checkName: undefined,
    items: [
      {
        id: "failure-empty-path",
        message: "  visible message  ",
        path: "   ",
        line: 3,
        severity: "error",
      },
    ],
  });
  (report as unknown as { checkName: unknown }).checkName = { secret: true };

  const presentation = presentCommitPlanExecutionFailure(report);

  assert.equal("hookName" in presentation, false);
  assert.equal("checkName" in presentation, false);
  assert.equal("path" in presentation.items[0]!, false);
  assert.equal(presentation.items[0]?.message, "visible message");
  assert.equal(presentation.items[0]?.line, 3);
  assert.equal("column" in presentation.items[0]!, false);
});

test("원문의 실행 메타데이터와 임의 raw stream 필드를 표시 결과에 포함하지 않는다", () => {
  const report = failureReport({
    outputLines: 777,
    occurredAt: "PRIVATE_OCCURRED_AT_SENTINEL",
    operation: "amendAll",
  }) as CommitFailureReport & { stdout: string; stderr: string };
  report.stdout = "PRIVATE_STDOUT_SENTINEL";
  report.stderr = "PRIVATE_STDERR_SENTINEL";

  const presentation = presentCommitPlanExecutionFailure(report);
  const serialized = JSON.stringify(presentation);

  assertNoPrivateExecutionFields(presentation);
  assert.equal(serialized.includes("PRIVATE_OCCURRED_AT_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_STDOUT_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_STDERR_SENTINEL"), false);
  assert.equal(serialized.includes("amendAll"), false);
  assert.equal(serialized.includes("private-diagnostic-id"), false);
});

test("잘린 접두사 끝의 high surrogate를 제거해 깨진 유니코드 문자를 만들지 않는다", () => {
  const prefix = "a".repeat(998);
  const presentation = presentCommitPlanExecutionFailure(
    failureReport({ summary: `${prefix}😀tail` })
  );

  assert.equal(presentation.summary.endsWith("\ud83d…"), false);
  assert.equal(presentation.summary.endsWith("…"), true);
  assert.ok(presentation.summary.length <= 1_000);
  assert.equal(presentation.truncated, true);
});

test("실행 진행 수치를 범위 안으로 제한하고 commit 외 단계의 step을 제거한다", () => {
  const malformed = presentCommitPlanExecutionProgress({
    phase: "future-phase",
    current: Number.POSITIVE_INFINITY,
    total: -3,
    step: "started",
    message: "  validating  ",
  } as unknown as CommitPlanExecutionProgress);
  assert.deepEqual(malformed, {
    phase: "validate",
    current: 0,
    total: 0,
    message: "validating",
  });

  const completed = presentCommitPlanExecutionProgress({
    phase: "complete",
    current: 2,
    total: 2,
    step: "completed",
  });
  assert.deepEqual(completed, {
    phase: "complete",
    current: 2,
    total: 2,
  });
});

test("commit 진행 메시지와 경로 목록을 웹뷰 상한에 맞게 잘라 전달한다", () => {
  const paths = Array.from(
    { length: 501 },
    (_, index) => index === 0 ? "p".repeat(4_500) : `src/file-${index}.ts`
  );
  const presentation = presentCommitPlanExecutionProgress({
    phase: "commit",
    current: 9,
    total: 2,
    step: "started",
    message: `  ${"m".repeat(8_500)}  `,
    paths,
  });

  assert.equal(presentation.phase, "commit");
  assert.equal(presentation.current, 2);
  assert.equal(presentation.total, 2);
  assert.equal(presentation.step, "started");
  assert.equal(presentation.message?.length, 8_000);
  assert.equal(presentation.message?.endsWith("…"), true);
  assert.equal(presentation.paths?.length, 500);
  assert.equal(presentation.paths?.[0]?.length, 4_096);
  assert.equal(presentation.paths?.[0]?.endsWith("…"), true);
  assert.equal(presentation.paths?.at(-1), "src/file-499.ts");
});
