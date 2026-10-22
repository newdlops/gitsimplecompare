import assert from "node:assert/strict";
import test from "node:test";
import { readGraphLocalBranchSnapshot } from "../src/git/graphLocalBranches";

const FS = "\x1f", head = "a".repeat(40), broken = "b".repeat(40);
const primary = new Error("missing object for broken-local");
const raw = [["refs/heads/main", "main", head, "*", "", ""],
  ["refs/heads/broken-local", "broken-local", broken, "", "", ""]].map(row => row.join(FS)).join("\n");
const rich = ["*", "main", head, "", "", "2026-10-22T00:00:00Z", "Current subject"].join(FS);
const stages = ["primary", "raw", "validation", "metadata"] as const;
type Stage = typeof stages[number];

/**
 * 각 Native 경계에 실패·늦은 취소를 넣되 파일/프로세스를 만들지 않는 조회 실행기다.
 * @param stage 실패 또는 취소가 일어날 경계 @param failure 원문 보존 여부를 검증할 오류
 * @param controller 반환 직전에 취소할 선택적 조회 수명 @returns 실행한 순서와 실제 서비스 호출 함수
 */
function boundary(stage: Stage, failure?: Error, controller?: AbortController) {
  const calls: Stage[] = [];
  const read = async (current: Stage, value: string) => {
    calls.push(current);
    if (current === stage) {
      if (failure) throw failure;
      controller?.abort();
    }
    return value;
  };
  const runner = async (args: string[]) => {
    if (args[0] === "show") return read("metadata", `${head}${FS}2026-10-22T00:00:00Z${FS}Current subject\n`);
    if (args.includes("--sort=-committerdate")) {
      const value = await read("primary", rich);
      if (stage !== "primary") throw primary;
      return value;
    }
    return read("raw", raw);
  };
  const inputRunner = async () => read("validation", `${head} commit\n${broken}^{commit} missing\n`);
  return { calls, run: () => readGraphLocalBranchSnapshot("/owned-fixture", runner, inputRunner, controller?.signal) };
}

for (const stage of stages) {
  for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "GIT_READ_STOPPING", "ABORT_ERR", "AbortError"]) {
    test(`${stage} branch ${code} propagates the stopping error without starting a later read`, async () => {
      const failure = code === "AbortError" ? Object.assign(new Error(code), { name: "AbortError" }) : Object.assign(new Error(code), { code });
      const f = boundary(stage, failure);
      await assert.rejects(f.run(), error => error === failure);
      assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(stage) + 1));
    });
  }
  test(`cancellation after the ${stage} branch response rejects without publishing a partial snapshot`, async () => {
    const controller = new AbortController(), f = boundary(stage, undefined, controller);
    await assert.rejects(f.run(), { name: "AbortError" });
    assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(stage) + 1));
  });
}

test("ordinary metadata failure still isolates the broken ref and returns the healthy branch", async () => {
  const f = boundary("metadata", new Error("ordinary metadata error"));
  const result = await f.run();
  assert.equal(result.branches.length, 1); assert.equal(result.branches[0].hash, head);
  assert.equal(result.branches[0].current, true); assert.equal(result.branches[0].subject, "");
  assert.deepEqual(result.invalidRefs.map(ref => ref.name), ["broken-local"]);
});
