import assert from "node:assert/strict";
import test from "node:test";
import { composePullRequestReviewSuggestionBody, parsePullRequestReviewSuggestions } from "../src/git/pullRequestReviewSuggestion";

test("review suggestion은 일반 설명 뒤에 GitHub fence를 붙이고 code whitespace를 보존한다", () => {
  assert.equal(
    composePullRequestReviewSuggestionBody("Prefer this.", "  return next;\r\n"),
    "Prefer this.\n\n```suggestion\n  return next;\n\n```"
  );
  assert.equal(composePullRequestReviewSuggestionBody("", "value = 1;"), "```suggestion\nvalue = 1;\n```");
  assert.equal(composePullRequestReviewSuggestionBody("Keep this.", "  \n"), "Keep this.");
});

test("review suggestion parser는 여러 fenced block을 순서대로 읽고 일반 code/미완결 fence는 무시한다", () => {
  const parsed = parsePullRequestReviewSuggestions([
    "Before", "```ts", "const ordinary = true;", "```", "```suggestion", "const one = 1;", "```", "~~~~suggestion optional", "", "~~~~", "```suggestion", "unfinished",
  ].join("\r\n"));

  assert.deepEqual(parsed, [
    { replacement: "const one = 1;", lineCount: 1, isApplicable: true },
    { replacement: "", lineCount: 0, isApplicable: true },
  ]);
});

test("review suggestion parser는 100줄을 초과하면 local apply 후보로 표시하지 않는다", () => {
  const parsed = parsePullRequestReviewSuggestions(`\`\`\`suggestion\n${Array.from({ length: 101 }, (_, index) => `line ${index}`).join("\n")}\n\`\`\``);

  assert.deepEqual(parsed[0], { replacement: Array.from({ length: 101 }, (_, index) => `line ${index}`).join("\n"), lineCount: 101, isApplicable: false, reason: "tooManyLines" });
});
