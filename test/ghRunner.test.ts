// review 전용 gh 실행 경계를 실제 CLI 없이 검증한다.
import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, GhJsonError, type GhExecute } from "../src/git/ghRunner";

test("DefaultGhRunner는 service가 조립한 args와 operation을 실행 함수에 전달한다", async () => {
  const calls: Array<{ args: readonly string[]; cwd: string; operation: string }> = [];
  const execute: GhExecute = async (args, cwd, options) => {
    calls.push({ args, cwd, operation: options.operation });
    return "{\"ok\":true}";
  };
  const runner = new DefaultGhRunner(execute);

  const output = await runner.run(["api", "graphql"], "/fixture/repo", {
    operation: "review.viewer",
  });

  assert.equal(output, "{\"ok\":true}");
  assert.deepEqual(calls, [
    { args: ["api", "graphql"], cwd: "/fixture/repo", operation: "review.viewer" },
  ]);
});

test("DefaultGhRunner는 JSON body를 제네릭 결과로 파싱한다", async () => {
  const runner = new DefaultGhRunner(async () => "{\"data\":{\"viewer\":\"fixture\"}}");

  const result = await runner.runJson<{ data: { viewer: string } }>(["api", "graphql"], "/fixture/repo", {
    operation: "review.viewer",
  });

  assert.equal(result.data.viewer, "fixture");
});

test("DefaultGhRunner는 손상된 JSON에 raw stdout을 노출하지 않는다", async () => {
  const runner = new DefaultGhRunner(async () => "not-json: ghp_secret");

  await assert.rejects(
    runner.runJson(["api", "graphql"], "/fixture/repo", { operation: "review.viewer" }),
    (error: unknown) => error instanceof GhJsonError && error.operation === "review.viewer"
  );
});
