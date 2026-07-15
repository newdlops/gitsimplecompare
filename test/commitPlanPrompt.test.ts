// AI 커밋 플랜 프롬프트와 실행 전 경계 규칙을 검증한다.
// 응답 파싱/보정 테스트와 분리해 프롬프트 계약의 변경 원인을 한곳에서 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCommitPlanPrompt,
  CommitPlanContext,
  eligibleCommitPlanFiles,
  eligibleCommitPlanPaths,
  findCommitPlanPathTransitionConflict,
} from "../src/ai/commitPlanModel";
import {
  commitPlanContextPaths,
  normalizeCommitPlanResult,
  parseCommitPlanFromWebview,
  validateCommitPlanForExecution,
} from "../src/webview/commitPlanProtocol";

/** 테스트 전반에서 재사용하는 staged/unstaged/rename 변경 파일 목록. */
const BASE_FILES: CommitPlanContext["files"] = [
  {
    path: "src/alpha.ts",
    status: "M",
    additions: 12,
    deletions: 3,
    staged: true,
    unstaged: false,
  },
  {
    path: "src/beta.ts",
    oldPath: "src/legacy-beta.ts",
    status: "R",
    additions: 4,
    deletions: 1,
    staged: true,
    unstaged: true,
  },
  {
    path: "docs/guide.md",
    status: "A",
    additions: 20,
    deletions: 0,
    staged: false,
    unstaged: true,
  },
];

/**
 * 각 테스트가 독립된 변경 컨텍스트를 쓰도록 기본 fixture를 복제한다.
 * @param overrides 테스트 목적에 따라 바꿀 최상위 필드
 * @returns 새 파일 객체 배열을 가진 커밋 플랜 컨텍스트
 */
function planContext(
  overrides: Partial<CommitPlanContext> = {}
): CommitPlanContext {
  return {
    repoRoot: "/workspace/repo",
    branch: "feature/commit-plan",
    head: "1234567890abcdef",
    scope: "all",
    files: BASE_FILES.map((file) => ({ ...file })),
    snapshot: "M  src/alpha.ts\nRM src/beta.ts\n?? docs/guide.md",
    diff: "diff --git a/src/alpha.ts b/src/alpha.ts\n+const alpha = true;",
    ...overrides,
  };
}

test("프롬프트가 schema와 사용자 입력을 명확한 독립 구획으로 직렬화한다", () => {
  const context = planContext();
  const before = structuredClone(context);
  const prompt = buildCommitPlanPrompt(context, {
    responseLanguage: "Korean",
    commonInstructions: "Use repository terminology.",
    commitInstructions: "Explain user-visible behavior in the body.",
    commitIntent: "Keep the rename separate from documentation.",
    extraPrompt: "Prefer at most three commits.",
  });

  assert.match(prompt, /Return strict JSON only/);
  assert.match(
    prompt,
    /\{"commits":\[\{"paths":\[[^\]]+\],"subject":"[^"]+","body":"[^"]+","reason":"[^"]+"\}\]\}/
  );
  assert.equal(prompt.includes('{"commits":[{"message"'), false);
  assert.match(prompt, /Write commit messages in Korean/);
  assert.match(prompt, /Write reasons in Korean/);
  assert.match(
    prompt,
    /Add a short body only when it clarifies non-obvious behavior/
  );
  assert.match(
    prompt,
    /treat each group as an independent standalone commit-message task/
  );
  assert.match(
    prompt,
    /finish its complete message before writing its reason/
  );
  assert.match(prompt, /Do not divide a fixed detail budget across commits/);
  assert.match(prompt, /Later commits must receive the same message quality/);
  assert.match(prompt, /paths, reason, and the other commits are hidden/);
  assert.match(prompt, /Do not optimize for a short overall response/);
  assert.match(
    prompt,
    /For every non-trivial group, write a body with 2-4 concise/
  );
  assert.match(prompt, /Omit the body only when that group's subject/);
  assert.match(prompt, /Put the one-line first line in subject/);
  assert.match(prompt, /Encode line breaks inside body as \\n in JSON/);
  assert.match(
    prompt,
    /BEGIN_PROJECT_COMMON_INSTRUCTIONS\nUse repository terminology\.\nEND_PROJECT_COMMON_INSTRUCTIONS/
  );
  assert.match(
    prompt,
    /BEGIN_COMMIT_MESSAGE_INSTRUCTIONS\nExplain user-visible behavior in the body\.\nEND_COMMIT_MESSAGE_INSTRUCTIONS/
  );
  assert.match(
    prompt,
    /BEGIN_COMMIT_INTENT\nKeep the rename separate from documentation\.\nEND_COMMIT_INTENT/
  );
  assert.match(
    prompt,
    /BEGIN_USER_EXTRA_PROMPT\nPrefer at most three commits\.\nEND_USER_EXTRA_PROMPT/
  );
  assert.ok(
    prompt.indexOf("BEGIN_COMMIT_INTENT") <
      prompt.indexOf("BEGIN_USER_EXTRA_PROMPT")
  );
  assert.match(prompt, /Branch: feature\/commit-plan/);
  assert.match(prompt, /HEAD: 1234567890abcdef/);
  assert.match(prompt, /BEGIN_CHANGE_SNAPSHOT/);
  assert.match(prompt, /BEGIN_DIFF/);
  assert.ok(prompt.indexOf("END_DIFF") < prompt.indexOf("FINAL_QUALITY_CHECK"));
  assert.match(
    prompt,
    /Revise any generic subject, any non-trivial commit without a useful body/
  );
  assert.deepEqual(context, before);
});

test("프롬프트 파일 allowlist가 rename, stage 상태와 numstat을 보존한다", () => {
  const prompt = buildCommitPlanPrompt(planContext(), {
    responseLanguage: "English",
  });

  assert.match(
    prompt,
    /path="src\/alpha\.ts" status=M state=staged \+12\/-3/
  );
  assert.match(
    prompt,
    /path="src\/beta\.ts" status=R state=staged,unstaged oldPath="src\/legacy-beta\.ts" \+4\/-1/
  );
  assert.match(
    prompt,
    /path="docs\/guide\.md" status=A state=unstaged \+20\/-0/
  );
  assert.match(prompt, /Use only exact current paths listed in CHANGED_FILES/);
});

test("빈 사용자 입력도 별도 구획으로 남고 응답 언어는 English로 보정된다", () => {
  const prompt = buildCommitPlanPrompt(planContext(), {
    responseLanguage: "   ",
    commonInstructions: "",
    commitIntent: "\n",
  });

  assert.match(prompt, /Write commit messages in English/);
  assert.match(prompt, /Write reasons in English/);
  assert.match(
    prompt,
    /BEGIN_PROJECT_COMMON_INSTRUCTIONS\n\(not provided\)\nEND_PROJECT_COMMON_INSTRUCTIONS/
  );
  assert.match(
    prompt,
    /BEGIN_COMMIT_INTENT\n\(not provided\)\nEND_COMMIT_INTENT/
  );
  assert.match(
    prompt,
    /BEGIN_COMMIT_MESSAGE_INSTRUCTIONS\n\(not provided\)\nEND_COMMIT_MESSAGE_INSTRUCTIONS/
  );
  assert.match(
    prompt,
    /BEGIN_USER_EXTRA_PROMPT\n\(not provided\)\nEND_USER_EXTRA_PROMPT/
  );
});

test("staged scope 수집 결과만 프롬프트와 allowlist에 포함한다", () => {
  const context = planContext({
    scope: "staged",
    files: BASE_FILES.filter((file) => file.staged),
  });
  const prompt = buildCommitPlanPrompt(context, {
    responseLanguage: "English",
  });

  assert.deepEqual(eligibleCommitPlanPaths(context), [
    "src/alpha.ts",
    "src/beta.ts",
  ]);
  assert.equal(prompt.includes('path="docs/guide.md"'), false);
  assert.equal(prompt.includes('path="src/alpha.ts"'), true);
});

test("all scope는 staged와 unstaged 파일을 원래 순서대로 포함한다", () => {
  const context = planContext();
  assert.deepEqual(
    eligibleCommitPlanFiles(context).map((file) => file.path),
    ["src/alpha.ts", "src/beta.ts", "docs/guide.md"]
  );
});

test("diff에서 확정한 파일은 표시용 stage 플래그가 false여도 allowlist에 유지한다", () => {
  const context = planContext({
    files: [{
      path: "raced-context.txt",
      status: "M",
      staged: false,
      unstaged: false,
    }],
  });

  assert.deepEqual(eligibleCommitPlanPaths(context), ["raced-context.txt"]);
  assert.match(
    buildCommitPlanPrompt(context, { responseLanguage: "English" }),
    /path="raced-context\.txt" status=M state=unknown/
  );
});

test("file/directory 전환 경로는 같은 그룹에 있어야 하고 sibling rename은 허용한다", () => {
  const transitionFiles: CommitPlanContext["files"] = [
    { path: "shape", status: "D", staged: false, unstaged: true },
    { path: "shape/child.txt", status: "A", staged: false, unstaged: true },
    { path: "other.txt", status: "M", staged: false, unstaged: true },
  ];
  const splitGroups = [
    { message: "feat: add child", paths: ["shape/child.txt"] },
    { message: "refactor: remove file", paths: ["shape", "other.txt"] },
  ];
  assert.deepEqual(
    findCommitPlanPathTransitionConflict(transitionFiles, splitGroups),
    { ancestorPath: "shape", descendantPath: "shape/child.txt" }
  );
  const validation = validateCommitPlanForExecution(
    { groups: splitGroups, warnings: [] },
    planContext({ files: transitionFiles })
  );
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.pathTransition, {
    ancestorPath: "shape",
    descendantPath: "shape/child.txt",
  });

  const renameAndSibling: CommitPlanContext["files"] = [
    {
      path: "shape/child.txt",
      oldPath: "shape",
      status: "R",
      staged: false,
      unstaged: true,
    },
    { path: "shape/other.txt", status: "A", staged: false, unstaged: true },
  ];
  assert.equal(
    findCommitPlanPathTransitionConflict(renameAndSibling, [
      { message: "refactor: move shape", paths: ["shape/child.txt"] },
      { message: "feat: add sibling", paths: ["shape/other.txt"] },
    ]),
    undefined
  );
});

test("protocol 경계가 Git 파일명에 포함된 앞뒤 공백을 그대로 보존한다", () => {
  const spacedPath = " leading and trailing.txt ";
  const context = planContext({
    files: [
      {
        path: spacedPath,
        status: "A",
        staged: false,
        unstaged: true,
      },
    ],
  });

  assert.deepEqual(commitPlanContextPaths(context), [spacedPath]);
  assert.deepEqual(
    parseCommitPlanFromWebview({ type: "openFile", path: spacedPath }),
    { type: "openFile", path: spacedPath }
  );
  assert.deepEqual(
    normalizeCommitPlanResult({
      groups: [{ message: "test: preserve path", paths: [spacedPath] }],
    }).groups[0]?.paths,
    [spacedPath]
  );

  const whitespaceOnly = planContext({
    files: [
      {
        path: " ",
        status: "A",
        staged: true,
        unstaged: false,
      },
    ],
  });
  assert.deepEqual(commitPlanContextPaths(whitespaceOnly), [" "]);
});
