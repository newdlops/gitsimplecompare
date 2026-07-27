import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestManagementBulkService } from "../src/git/pullRequestManagementBulkService";

const metadata = { assignees: [], labels: [], requestedReviewers: [], isDraft: false };

test("bulk preview는 no-op·read 실패를 skip으로 분리하고 중복 target을 제거한다", async () => {
  const service = new PullRequestManagementBulkService({
    readMetadata: async (target) => {
      if (target.number === 3) throw new Error("no permission");
      return target.number === 2 ? { ...metadata, labels: ["ready"] } : metadata;
    },
    apply: async () => { throw new Error("not called"); },
  });
  const targets = [target(1), target(1), target(2), target(3)];

  const preview = await service.preview(targets, { kind: "addLabels", names: ["ready"] });

  assert.equal(preview.items.length, 3);
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.skippedCount, 2);
  assert.equal(preview.items[2]?.error, "no permission");
});

test("bulk preview는 대형 선택에서도 metadata read를 세 항목 이하로 제한한다", async () => {
  let running = 0;
  let maximum = 0;
  const service = new PullRequestManagementBulkService({
    readMetadata: async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return metadata;
    },
    apply: async () => { throw new Error("not called"); },
  });

  const preview = await service.preview([target(1), target(2), target(3), target(4), target(5)], { kind: "addLabels", names: ["ready"] });

  assert.equal(maximum, 3);
  assert.equal(preview.eligibleCount, 5);
});

test("bulk execute는 세 항목 이하 동시성으로 계속 진행하고 실패를 독립 결과로 남긴다", async () => {
  let running = 0;
  let maximum = 0;
  const service = new PullRequestManagementBulkService({
    readMetadata: async () => metadata,
    apply: async (target) => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (target.number === 4) throw new Error("write failed");
      return { target, mutation: { kind: "addLabels", names: ["ready"] } as const, metadata: { ...metadata, labels: ["ready"] }, mismatches: [], verified: true };
    },
  });
  const preview = await service.preview([target(1), target(2), target(3), target(4), target(5)], { kind: "addLabels", names: ["ready"] });

  const summary = await service.execute(preview);

  assert.equal(maximum, 3);
  assert.equal(summary.appliedCount, 4);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.partiallyVerifiedCount, 0);
  assert.equal(summary.items.find((item) => item.target.number === 4)?.message, "write failed");
});

test("bulk execute는 write 뒤 부분 검증 불일치를 성공 수와 분리해 집계한다", async () => {
  const service = new PullRequestManagementBulkService({
    readMetadata: async () => metadata,
    apply: async (target) => ({
      target,
      mutation: { kind: "addLabels", names: ["ready"] } as const,
      metadata: { ...metadata, labels: target.number === 2 ? [] : ["ready"] },
      mismatches: target.number === 2 ? ["ready"] : [],
      verified: target.number !== 2,
    }),
  });

  const preview = await service.preview([target(1), target(2)], { kind: "addLabels", names: ["ready"] });
  const summary = await service.execute(preview);

  assert.equal(summary.appliedCount, 2);
  assert.equal(summary.partiallyVerifiedCount, 1);
  assert.deepEqual(summary.items.find((item) => item.target.number === 2)?.result?.mismatches, ["ready"]);
});

test("bulk execute는 취소 뒤 새 write를 예약하지 않고 아직 시작하지 않은 target을 취소 결과로 남긴다", async () => {
  const started: number[] = [];
  const service = new PullRequestManagementBulkService({
    readMetadata: async () => metadata,
    apply: async (target, _mutation, signal) => {
      started.push(target.number);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    },
  });
  const preview = await service.preview([target(1), target(2), target(3), target(4), target(5)], { kind: "addLabels", names: ["ready"] });
  const controller = new AbortController();
  const executing = service.execute(preview, controller.signal);

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const summary = await executing;

  assert.equal(started.length, 3);
  assert.equal(summary.appliedCount, 0);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.cancelledCount, 5);
  assert.equal(summary.items.filter((item) => item.status === "cancelled").length, 5);
});

/** repository와 PR 번호가 다른 안정된 bulk target fixture를 만든다. */
function target(number: number) {
  return { key: `acme/demo#${number}`, repository: "acme/demo", number };
}
