import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  normalizeReportedPath,
  parseCommitFailureOutput,
} from "../src/git/commitHookFailure";
import {
  parseHooksPathConfig,
  resolveConfiguredPath,
} from "../src/git/commitHookPaths";

const ROOT = path.resolve(path.parse(process.cwd()).root, "workspace", "repo");

test("ESLint, TypeScript, Ruff 위치를 클릭 가능한 상대 경로로 파싱한다", () => {
  const eslint = parseCommitFailureOutput(
    `${path.join(ROOT, "src", "foo.ts")}\n  4:2  error  Unexpected console  no-console\n✖ 1 problem`,
    ROOT
  );
  assert.deepEqual(
    eslint.items.find((item) => item.path === "src/foo.ts"),
    {
      id: "failure-1",
      message: "error Unexpected console no-console",
      path: "src/foo.ts",
      line: 4,
      column: 2,
      severity: "error",
    }
  );

  const compilers = parseCommitFailureOutput(
    "src/a.ts(3,9): error TS2322: bad type\nsrc/a.py:5:7: F401 unused import",
    ROOT
  );
  assert.deepEqual(
    compilers.items.filter((item) => item.path).map((item) => [
      item.path,
      item.line,
      item.column,
    ]),
    [
      ["src/a.ts", 3, 9],
      ["src/a.py", 5, 7],
    ]
  );

  const unusualPaths = parseCommitFailureOutput(
    "src/한글 파일.ts:7:3: error 잘못된 값\nDockerfile:12:1: error invalid instruction",
    ROOT
  );
  assert.deepEqual(
    unusualPaths.items.filter((item) => item.path).map((item) => item.path),
    ["src/한글 파일.ts", "Dockerfile"]
  );
});

test("파일 크기, YAML 위치, trailing whitespace와 Prettier 형식을 파싱한다", () => {
  const report = parseCommitFailureOutput(
    [
      "assets/big.bin (1200 KB) exceeds 500 KB.",
      'in "config.yml", line 2, column 4',
      "src/a.py:8: trailing whitespace",
      "[warn] src/format.ts",
    ].join("\n"),
    ROOT
  );
  const byPath = new Map(report.items.filter((item) => item.path).map((item) => [item.path, item]));
  assert.equal(byPath.get("assets/big.bin")?.message, "(1200 KB) exceeds 500 KB.");
  assert.equal(byPath.get("config.yml")?.line, 2);
  assert.equal(byPath.get("config.yml")?.column, 4);
  assert.equal(byPath.get("src/a.py")?.line, 8);
  assert.equal(byPath.get("src/format.ts")?.severity, "warning");
});

test("ANSI를 제거하고 hook/check 이름 및 retry operation을 보존한다", () => {
  const report = parseCommitFailureOutput(
    "\u001b[31m- hook id: eslint\u001b[0m\nhusky - pre-commit script failed\r\nsrc/a.ts:2:1: error bad",
    ROOT,
    { operation: "amendStaged", occurredAt: "2026-07-12T00:00:00.000Z" }
  );
  assert.equal(report.likelyHook, true);
  assert.equal(report.hookName, "pre-commit");
  assert.equal(report.checkName, "eslint");
  assert.equal(report.operation, "amendStaged");
  assert.equal(report.occurredAt, "2026-07-12T00:00:00.000Z");
});

test("저장소 밖 경로를 거부하고 빈 출력에도 기본 요약을 만든다", () => {
  assert.equal(normalizeReportedPath("../secret.ts", ROOT), undefined);
  assert.equal(
    normalizeReportedPath(path.resolve(ROOT, "..", "secret.ts"), ROOT),
    undefined
  );
  const outside = parseCommitFailureOutput(
    `${path.resolve(ROOT, "..", "secret.ts")}:1:2: error hidden`,
    ROOT
  );
  assert.equal(outside.items.some((item) => item.path), false);
  assert.equal(parseCommitFailureOutput("", ROOT).summary, "Commit failed.");
});

test("활성 hook만으로 일반 Git 실패를 hook 실패로 오인하지 않는다", () => {
  const report = parseCommitFailureOutput(
    "fatal: unable to read current working directory",
    ROOT,
    { activeHooks: ["post-commit"] }
  );
  assert.equal(report.likelyHook, false);
  const silentBlockingHook = parseCommitFailureOutput(
    "git commit 실패: Command failed: git commit -m test",
    ROOT,
    { activeHooks: ["pre-commit"] }
  );
  assert.equal(silentBlockingHook.likelyHook, true);
  assert.equal(silentBlockingHook.hookName, "pre-commit");
  const mergeOnly = parseCommitFailureOutput(
    "git commit 실패: Command failed: git commit -m test",
    ROOT,
    { activeHooks: ["pre-merge-commit"] }
  );
  assert.equal(mergeOnly.likelyHook, false);

  const explicitWins = parseCommitFailureOutput(
    "husky - commit-msg script failed\nempty commit message",
    ROOT
  );
  assert.equal(explicitWins.likelyHook, true);
});

test("100개 항목과 5000행 상한을 적용하고 중복 위치를 한 번만 남긴다", () => {
  const repeated = Array.from(
    { length: 5100 },
    (_, index) => `src/file${index}.ts:1:1: error failure ${index}`
  ).join("\n");
  const report = parseCommitFailureOutput(repeated, ROOT);
  assert.equal(report.items.length, 100);
  assert.equal(report.truncated, true);

  const generic = parseCommitFailureOutput(
    Array.from({ length: 30 }, (_, index) => `failure ${index}`).join("\n"),
    ROOT
  );
  assert.equal(generic.items.length, 20);
  assert.equal(generic.truncated, true);

  const duplicate = parseCommitFailureOutput(
    "src/a.ts:1:2: error same\nsrc/a.ts:1:2: error same",
    ROOT
  );
  assert.equal(duplicate.items.filter((item) => item.path === "src/a.ts").length, 1);
});

test("wrapper와 formatter 요약을 경로로 오인하지 않고 Stylelint 위치를 연결한다", () => {
  const wrappers = parseCommitFailureOutput(
    [
      `npm ERR! path ${path.join(ROOT, "package.json")}`,
      "  4:2 error package failure",
      "Code style issues found in 1 file. Forgot to run Prettier?",
      `at ${path.join(ROOT, "src", "stack.ts")}:7:3`,
    ].join("\n"),
    ROOT
  );
  assert.equal(wrappers.items.some((item) => item.path), false);

  const stylelint = parseCommitFailureOutput(
    `${path.join(ROOT, "styles", "a.css")}\n  7:3  ✖  Unexpected color`,
    ROOT
  );
  assert.equal(stylelint.items[0]?.path, "styles/a.css");
  assert.equal(stylelint.items[0]?.line, 7);
});

test("core.hooksPath 3필드/빈 값 출력과 상대·홈 경로를 해석한다", () => {
  assert.deepEqual(
    parseHooksPathConfig("local\tfile:.git/config\t.githooks\n"),
    { scope: "local", origin: "file:.git/config", value: ".githooks" }
  );
  assert.deepEqual(
    parseHooksPathConfig("local\tfile:.git/config\t\n"),
    { scope: "local", origin: "file:.git/config", value: "" }
  );
  assert.equal(resolveConfiguredPath(ROOT, ".githooks"), path.join(ROOT, ".githooks"));
  assert.equal(path.basename(resolveConfiguredPath(ROOT, "~/hooks")), "hooks");
});
