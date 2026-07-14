import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCommitPlanPrompt,
  CommitPlanContext,
  CommitPlanResponseError,
  eligibleCommitPlanFiles,
  eligibleCommitPlanPaths,
  findCommitPlanPathTransitionConflict,
  normalizeCommitPlan,
  parseCommitPlanResponse,
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

/**
 * 결과의 fallback 그룹을 명시적으로 찾아 이후 assertion의 undefined 분기를 줄인다.
 * @param result 파서 또는 정규화 함수의 반환값
 * @returns fallback 플래그가 있는 유일한 그룹
 */
function fallbackOf(
  result: ReturnType<typeof parseCommitPlanResponse>
) {
  return result.groups.find((group) => group.fallback);
}

test("프롬프트가 schema와 사용자 입력을 명확한 독립 구획으로 직렬화한다", () => {
  const context = planContext();
  const before = structuredClone(context);
  const prompt = buildCommitPlanPrompt(context, {
    responseLanguage: "Korean",
    commonInstructions: "Use repository terminology.",
    commitIntent: "Keep the rename separate from documentation.",
    extraPrompt: "Prefer at most three commits.",
  });

  assert.match(prompt, /Return strict JSON only/);
  assert.match(prompt, /\{"commits":\[\{"message":/);
  assert.match(prompt, /Write commit messages and reasons in Korean/);
  assert.match(
    prompt,
    /BEGIN_PROJECT_COMMON_INSTRUCTIONS\nUse repository terminology\.\nEND_PROJECT_COMMON_INSTRUCTIONS/
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

  assert.match(prompt, /Write commit messages and reasons in English/);
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

test("정상 JSON의 그룹 순서, 메시지, 이유와 경로를 보존한다", () => {
  const result = parseCommitPlanResponse(
    planContext(),
    JSON.stringify({
      commits: [
        {
          message: "feat: add alpha behavior",
          paths: ["src/alpha.ts", "src/beta.ts"],
          reason: "Runtime changes belong together.",
        },
        {
          message: "docs: add usage guide",
          paths: ["docs/guide.md"],
        },
      ],
    })
  );

  assert.deepEqual(result, {
    groups: [
      {
        message: "feat: add alpha behavior",
        paths: ["src/alpha.ts", "src/beta.ts"],
        reason: "Runtime changes belong together.",
      },
      {
        message: "docs: add usage guide",
        paths: ["docs/guide.md"],
        reason: undefined,
      },
    ],
    warnings: [],
  });
});

test("json과 text markdown fence 및 주변 설명에서 JSON 본문을 추출한다", () => {
  const jsonFenced = parseCommitPlanResponse(
    planContext(),
    [
      "```json",
      '{"commits":[{"message":"chore: collect changes","paths":["src/alpha.ts","src/beta.ts","docs/guide.md"]}]}',
      "```",
    ].join("\n")
  );
  assert.equal(jsonFenced.groups.length, 1);
  assert.equal(jsonFenced.warnings.length, 0);

  const textFenced = parseCommitPlanResponse(
    planContext({ files: [BASE_FILES[0]] }),
    "Here is the plan:\n```text\n" +
      '{"commits":[{"message":"fix: update alpha","paths":["src/alpha.ts"]}]}\n' +
      "```\nPlease review."
  );
  assert.equal(textFenced.groups[0]?.message, "fix: update alpha");
});

test("알 수 없는 경로와 비문자열 경로를 버리고 누락 파일을 fallback으로 보정한다", () => {
  const result = parseCommitPlanResponse(
    planContext(),
    JSON.stringify({
      commits: [
        {
          message: "feat: update alpha",
          paths: ["src/alpha.ts", "src/unknown.ts", 42],
        },
      ],
    })
  );

  assert.deepEqual(result.groups[0]?.paths, ["src/alpha.ts"]);
  assert.deepEqual(fallbackOf(result)?.paths, [
    "src/beta.ts",
    "docs/guide.md",
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown path")));
  assert.ok(
    result.warnings.some((warning) => warning.includes("non-string path"))
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("2 unassigned file"))
  );
});

test("그룹 내부와 그룹 사이 중복 경로는 첫 번째 할당만 유지한다", () => {
  const result = parseCommitPlanResponse(
    planContext(),
    JSON.stringify({
      commits: [
        {
          message: "feat: first owner",
          paths: ["src/alpha.ts", "src/alpha.ts"],
        },
        {
          message: "refactor: second owner",
          paths: ["src/alpha.ts", "src/beta.ts"],
        },
        {
          message: "fix: duplicate-only group",
          paths: ["src/beta.ts"],
        },
      ],
    })
  );

  assert.deepEqual(result.groups[0]?.paths, ["src/alpha.ts"]);
  assert.deepEqual(result.groups[1]?.paths, ["src/beta.ts"]);
  assert.deepEqual(fallbackOf(result)?.paths, ["docs/guide.md"]);
  assert.equal(
    result.groups.some((group) => group.message === "fix: duplicate-only group"),
    false
  );
  assert.ok(
    result.warnings.filter((warning) => warning.includes("assigned more than once"))
      .length >= 3
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("no eligible paths"))
  );
});

test("누락 경로는 입력 순서대로 편집 가능한 fallback 그룹에 들어간다", () => {
  const result = parseCommitPlanResponse(
    planContext(),
    '{"commits":[{"message":"docs: write guide","paths":["docs/guide.md"]}]}'
  );
  const fallback = fallbackOf(result);

  assert.equal(fallback?.message, "Review remaining changes");
  assert.deepEqual(fallback?.paths, ["src/alpha.ts", "src/beta.ts"]);
  assert.equal(fallback?.fallback, true);
  assert.match(fallback?.reason ?? "", /Review and edit this commit/);
});

test("빈 commits 배열은 모든 변경을 하나의 fallback 그룹으로 만든다", () => {
  const result = parseCommitPlanResponse(planContext(), '{"commits":[]}');

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.fallback, true);
  assert.deepEqual(result.groups[0]?.paths, [
    "src/alpha.ts",
    "src/beta.ts",
    "docs/guide.md",
  ]);
  assert.equal(result.warnings.length, 1);
});

test("객체가 아닌 항목, 빈 메시지와 잘못된 paths를 무시한 뒤 fallback한다", () => {
  const result = normalizeCommitPlan(planContext(), [
    null,
    "not-an-object",
    { message: "", paths: ["src/alpha.ts"] },
    { message: "fix: missing paths" },
    { message: "fix: wrong paths", paths: "src/alpha.ts" },
    { message: "fix: empty paths", paths: [] },
  ]);

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.fallback, true);
  assert.ok(result.warnings.some((warning) => warning.includes("not a JSON object")));
  assert.ok(result.warnings.some((warning) => warning.includes("message is empty")));
  assert.ok(result.warnings.some((warning) => warning.includes("not an array")));
  assert.ok(result.warnings.some((warning) => warning.includes("no eligible paths")));
});

test("메시지와 reason 공백을 제거하되 실제 경로 문자열은 정규화하지 않는다", () => {
  const exactPath = " odd file name.ts ";
  const context = planContext({
    files: [
      {
        path: exactPath,
        status: "M",
        staged: true,
        unstaged: false,
      },
    ],
  });
  const result = parseCommitPlanResponse(
    context,
    JSON.stringify({
      commits: [
        {
          message: "  fix: preserve exact path  ",
          paths: ["odd file name.ts"],
          reason: "  exact git paths matter  ",
        },
      ],
    })
  );

  assert.equal(result.groups[0]?.fallback, true);
  assert.deepEqual(result.groups[0]?.paths, [exactPath]);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown path")));

  const exact = parseCommitPlanResponse(
    context,
    JSON.stringify({
      commits: [
        {
          message: "  fix: preserve exact path  ",
          paths: [exactPath],
          reason: "  exact git paths matter  ",
        },
      ],
    })
  );
  assert.equal(exact.groups[0]?.message, "fix: preserve exact path");
  assert.equal(exact.groups[0]?.reason, "exact git paths matter");
});

test("rename의 oldPath는 allowlist가 아니며 현재 path만 허용한다", () => {
  const context = planContext({ files: [BASE_FILES[1]] });
  const oldPathResult = parseCommitPlanResponse(
    context,
    '{"commits":[{"message":"refactor: rename beta","paths":["src/legacy-beta.ts"]}]}'
  );
  assert.equal(oldPathResult.groups[0]?.fallback, true);
  assert.deepEqual(oldPathResult.groups[0]?.paths, ["src/beta.ts"]);

  const currentPathResult = parseCommitPlanResponse(
    context,
    '{"commits":[{"message":"refactor: rename beta","paths":["src/beta.ts"]}]}'
  );
  assert.equal(currentPathResult.groups[0]?.fallback, undefined);
  assert.equal(currentPathResult.warnings.length, 0);
});

test("context에 중복 파일 레코드가 있어도 allowlist와 fallback에는 한 번만 남긴다", () => {
  const duplicate = { ...BASE_FILES[0], unstaged: true };
  const context = planContext({ files: [BASE_FILES[0], duplicate, BASE_FILES[2]] });

  assert.deepEqual(eligibleCommitPlanPaths(context), [
    "src/alpha.ts",
    "docs/guide.md",
  ]);
  const result = parseCommitPlanResponse(context, '{"commits":[]}');
  assert.deepEqual(result.groups[0]?.paths, [
    "src/alpha.ts",
    "docs/guide.md",
  ]);
});

test("scope 밖 경로를 AI가 반환하면 unknown으로 버리고 scope 안 파일만 fallback한다", () => {
  const context = planContext({
    scope: "staged",
    files: BASE_FILES.filter((file) => file.staged),
  });
  const result = parseCommitPlanResponse(
    context,
    '{"commits":[{"message":"docs: update guide","paths":["docs/guide.md"]}]}'
  );

  assert.deepEqual(result.groups[0]?.paths, ["src/alpha.ts", "src/beta.ts"]);
  assert.equal(result.groups[0]?.fallback, true);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown path")));
});

test("scope 수집 결과가 비었으면 빈 결과를 유지하고 잘못된 AI 경로만 경고한다", () => {
  const context = planContext({
    scope: "staged",
    files: [],
  });
  const result = parseCommitPlanResponse(
    context,
    '{"commits":[{"message":"docs: update guide","paths":["docs/guide.md"]}]}'
  );

  assert.deepEqual(result.groups, []);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown path")));
  assert.ok(result.warnings.some((warning) => warning.includes("no eligible paths")));
  assert.equal(result.warnings.some((warning) => warning.includes("fallback")), false);
});

test("손상 JSON, 잘못된 최상위 타입과 commits 타입을 명시적 오류로 거부한다", () => {
  const context = planContext();
  const invalidResponses = [
    "",
    "not json",
    '{"commits":[}',
    "[]",
    '{"groups":[]}',
    '{"commits":{}}',
  ];

  for (const raw of invalidResponses) {
    assert.throws(
      () => parseCommitPlanResponse(context, raw),
      CommitPlanResponseError
    );
  }
});

test("JSON 문자열 안의 중괄호와 markdown 문자를 손상시키지 않는다", () => {
  const context = planContext({ files: [BASE_FILES[0]] });
  const raw = JSON.stringify({
    commits: [
      {
        message: "fix: handle {config} values",
        paths: ["src/alpha.ts"],
        reason: "Keep `markdown` and braces { intact }.",
      },
    ],
  });
  const result = parseCommitPlanResponse(context, raw);

  assert.equal(result.groups[0]?.message, "fix: handle {config} values");
  assert.equal(
    result.groups[0]?.reason,
    "Keep `markdown` and braces { intact }."
  );
});
