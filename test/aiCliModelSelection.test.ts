import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiCliModelArguments,
  aiCliProviderOrder,
  buildAiCliProviderCommand,
  type AiCliProviderCommandConfig,
} from "../src/ai/cliCommand";
import {
  isKnownUnsupportedAiReasoningEffort,
  selectAiCliModel,
  selectAiCliReasoningEffort,
  type AiCliConcreteProvider,
  type AiCliModelPurpose,
  type AiCliModelSelection,
  type AiCliModelSettings,
  type AiCliReasoningEffortSettings,
} from "../src/ai/cliModelSelection";

const BASE_SETTINGS: AiCliModelSettings = {
  claudeModel: "claude-general",
  claudeCommitPlanModel: "claude-plan",
  codexModel: "codex-general",
  codexCommitPlanModel: "codex-plan",
};

/** 실제 provider argv 테스트에서 공통으로 사용하는 command/model 설정. */
const COMMAND_CONFIG: AiCliProviderCommandConfig = {
  ...BASE_SETTINGS,
  claudeCommand: "claude-custom",
  claudeEffort: "high",
  claudeCommitPlanEffort: "medium",
  claudeSystemPrompt: "system guidance",
  codexCommand: "codex-custom",
  codexReasoningEffort: "xhigh",
  codexCommitPlanReasoningEffort: "high",
  codexProfile: "work",
};

/** 전용값, 일반값, CLI 기본값 사이의 추론 강도 우선순위를 검증할 공통 설정. */
const REASONING_SETTINGS: AiCliReasoningEffortSettings = {
  claudeEffort: "high",
  claudeCommitPlanEffort: "medium",
  codexReasoningEffort: "xhigh",
  codexCommitPlanReasoningEffort: "low",
};

interface SelectionCase {
  name: string;
  provider: AiCliConcreteProvider;
  purpose: AiCliModelPurpose;
  settings?: Partial<AiCliModelSettings>;
  expected: AiCliModelSelection;
}

const SELECTION_CASES: SelectionCase[] = [
  {
    name: "Claude 일반 요청은 일반 모델을 사용한다",
    provider: "claude",
    purpose: "general",
    expected: { model: "claude-general", source: "general" },
  },
  {
    name: "Codex 일반 요청은 일반 모델을 사용한다",
    provider: "codex",
    purpose: "general",
    expected: { model: "codex-general", source: "general" },
  },
  {
    name: "Claude 커밋 플랜은 전용 모델을 우선한다",
    provider: "claude",
    purpose: "commitPlan",
    expected: { model: "claude-plan", source: "commitPlan" },
  },
  {
    name: "Codex 커밋 플랜은 전용 모델을 우선한다",
    provider: "codex",
    purpose: "commitPlan",
    expected: { model: "codex-plan", source: "commitPlan" },
  },
  {
    name: "커밋 플랜 전용 모델이 비면 Claude 일반 모델을 상속한다",
    provider: "claude",
    purpose: "commitPlan",
    settings: { claudeCommitPlanModel: "" },
    expected: { model: "claude-general", source: "general" },
  },
  {
    name: "커밋 플랜 전용 모델이 공백이면 Codex 일반 모델을 상속한다",
    provider: "codex",
    purpose: "commitPlan",
    settings: { codexCommitPlanModel: " \t\n " },
    expected: { model: "codex-general", source: "general" },
  },
  {
    name: "Claude 모델 계층이 모두 비면 CLI 기본값을 사용한다",
    provider: "claude",
    purpose: "commitPlan",
    settings: { claudeModel: "", claudeCommitPlanModel: "" },
    expected: { model: "", source: "cliDefault" },
  },
  {
    name: "Codex 일반 모델이 공백이면 전용 값과 무관하게 CLI 기본값을 사용한다",
    provider: "codex",
    purpose: "general",
    settings: { codexModel: "   " },
    expected: { model: "", source: "cliDefault" },
  },
  {
    name: "선택된 모델명의 앞뒤 공백을 제거한다",
    provider: "claude",
    purpose: "commitPlan",
    settings: { claudeCommitPlanModel: "  claude-trimmed  " },
    expected: { model: "claude-trimmed", source: "commitPlan" },
  },
  {
    name: "선택한 provider와 다른 provider 설정은 사용하지 않는다",
    provider: "codex",
    purpose: "commitPlan",
    settings: {
      codexModel: "",
      codexCommitPlanModel: "",
      claudeModel: "claude-only",
      claudeCommitPlanModel: "claude-plan-only",
    },
    expected: { model: "", source: "cliDefault" },
  },
];

for (const selectionCase of SELECTION_CASES) {
  test(selectionCase.name, () => {
    const settings = { ...BASE_SETTINGS, ...selectionCase.settings };
    assert.deepEqual(
      selectAiCliModel(
        settings,
        selectionCase.provider,
        selectionCase.purpose
      ),
      selectionCase.expected
    );
  });
}

test("모델 선택은 호출자가 전달한 설정 객체를 수정하지 않는다", () => {
  const settings: AiCliModelSettings = {
    claudeModel: "  claude-general  ",
    claudeCommitPlanModel: "  ",
    codexModel: "  codex-general  ",
    codexCommitPlanModel: "  codex-plan  ",
  };
  const before = { ...settings };

  assert.deepEqual(selectAiCliModel(settings, "claude", "commitPlan"), {
    model: "claude-general",
    source: "general",
  });
  assert.deepEqual(settings, before);
});

test("선택된 모델은 하나의 argv 값으로 --model 뒤에 전달된다", () => {
  assert.deepEqual(
    aiCliModelArguments({ model: "model with spaces", source: "commitPlan" }),
    ["--model", "model with spaces"]
  );
});

test("CLI 기본 모델은 --model 인자를 만들지 않는다", () => {
  assert.deepEqual(
    aiCliModelArguments({ model: "", source: "cliDefault" }),
    []
  );
});

test("metadata 지원 목록에 없는 추론 강도만 비호환으로 확정한다", () => {
  assert.equal(
    isKnownUnsupportedAiReasoningEffort("xhigh", ["low", "medium", "high"]),
    true
  );
  assert.equal(
    isKnownUnsupportedAiReasoningEffort(" high ", ["low", "high"]),
    false
  );
  assert.equal(isKnownUnsupportedAiReasoningEffort("xhigh", []), false);
  assert.equal(isKnownUnsupportedAiReasoningEffort("", ["high"]), false);
});

test("커밋 플랜 전용 추론 강도가 provider 일반 설정보다 우선한다", () => {
  assert.deepEqual(
    selectAiCliReasoningEffort(REASONING_SETTINGS, "claude", "commitPlan"),
    { effort: "medium", source: "commitPlan" }
  );
  assert.deepEqual(
    selectAiCliReasoningEffort(REASONING_SETTINGS, "codex", "commitPlan"),
    { effort: "low", source: "commitPlan" }
  );
});

test("커밋 플랜 전용 추론 강도가 비면 provider 일반 설정을 상속한다", () => {
  assert.deepEqual(
    selectAiCliReasoningEffort(
      { ...REASONING_SETTINGS, claudeCommitPlanEffort: "  " },
      "claude",
      "commitPlan"
    ),
    { effort: "high", source: "general" }
  );
});

test("일반 요청은 커밋 플랜 전용 추론 강도를 무시한다", () => {
  assert.deepEqual(
    selectAiCliReasoningEffort(REASONING_SETTINGS, "codex", "general"),
    { effort: "xhigh", source: "general" }
  );
});

test("전용 및 일반 추론 강도가 모두 비면 CLI 기본값을 사용한다", () => {
  assert.deepEqual(
    selectAiCliReasoningEffort(
      {
        ...REASONING_SETTINGS,
        claudeEffort: "",
        claudeCommitPlanEffort: "",
      },
      "claude",
      "commitPlan"
    ),
    { effort: "", source: "cliDefault" }
  );
});

test("auto provider 순서는 Claude와 Codex를 각각 한 번씩 시도한다", () => {
  assert.deepEqual(aiCliProviderOrder("auto"), ["claude", "codex"]);
  assert.deepEqual(aiCliProviderOrder("codex"), ["codex"]);
});

test("Claude 플랜 command는 전용 모델과 전용 effort를 함께 쓴다", () => {
  const command = buildAiCliProviderCommand(
    COMMAND_CONFIG,
    "claude",
    "/workspace/repo",
    "commitPlan"
  );

  assert.equal(command.command, "claude-custom");
  assert.equal(command.modelSource, "commitPlan");
  assert.equal(command.reasoningEffort, "medium");
  assert.equal(command.reasoningEffortSource, "commitPlan");
  assert.deepEqual(command.args.slice(6, 8), ["--model", "claude-plan"]);
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--effort"), -2),
    ["--effort", "medium"]
  );
  assert.deepEqual(command.args.slice(-2), [
    "--append-system-prompt",
    "system guidance",
  ]);
});

test("Claude 플랜 전용 값이 비면 일반 모델과 effort를 함께 상속한다", () => {
  const command = buildAiCliProviderCommand(
    {
      ...COMMAND_CONFIG,
      claudeCommitPlanModel: "",
      claudeCommitPlanEffort: "",
    },
    "claude",
    "/workspace/repo",
    "commitPlan"
  );

  assert.equal(command.modelSource, "general");
  assert.equal(command.reasoningEffort, "high");
  assert.equal(command.reasoningEffortSource, "general");
  assert.ok(command.args.includes("claude-general"));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--effort"), -2),
    ["--effort", "high"]
  );
});

test("전용 및 일반 effort가 모두 비면 provider CLI 인자를 생략한다", () => {
  const config = {
    ...COMMAND_CONFIG,
    claudeEffort: "",
    claudeCommitPlanEffort: "",
    codexReasoningEffort: "",
    codexCommitPlanReasoningEffort: "",
  };
  const claude = buildAiCliProviderCommand(
    config,
    "claude",
    "/workspace/repo",
    "commitPlan"
  );
  const codex = buildAiCliProviderCommand(
    config,
    "codex",
    "/workspace/repo",
    "commitPlan"
  );

  assert.equal(claude.reasoningEffortSource, "cliDefault");
  assert.equal(claude.args.includes("--effort"), false);
  assert.equal(codex.reasoningEffortSource, "cliDefault");
  assert.equal(
    codex.args.some((argument) => argument.startsWith("model_reasoning_effort=")),
    false
  );
});

test("Codex 플랜 command는 Codex 전용 모델과 profile을 독립적으로 사용한다", () => {
  const command = buildAiCliProviderCommand(
    COMMAND_CONFIG,
    "codex",
    "/workspace/repo",
    "commitPlan"
  );

  assert.equal(command.command, "codex-custom");
  assert.equal(command.model, "codex-plan");
  assert.equal(command.reasoningEffort, "high");
  assert.equal(command.reasoningEffortSource, "commitPlan");
  assert.deepEqual(command.args, [
    "exec",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    "/workspace/repo",
    "-c",
    'model_reasoning_effort="high"',
    "--model",
    "codex-plan",
    "--profile",
    "work",
    "-",
  ]);
});

test("일반 Codex command는 기존 모델과 reasoning 설정을 바꾸지 않는다", () => {
  const command = buildAiCliProviderCommand(
    COMMAND_CONFIG,
    "codex",
    "/workspace/repo",
    "general"
  );

  assert.equal(command.modelSource, "general");
  assert.equal(command.reasoningEffort, "xhigh");
  assert.equal(command.reasoningEffortSource, "general");
  assert.ok(command.args.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--model"), -3),
    ["--model", "codex-general"]
  );
});
