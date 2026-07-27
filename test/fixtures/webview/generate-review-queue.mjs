// 대형 queue fixture를 필요한 성능 slice에서만 생성하는 deterministic generator.
// - 수백 행의 실데이터 JSON을 저장소에 복사하지 않고 stable key·windowing 테스트 입력을 만든다.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const count = Number(process.argv[2] || 200);
const outputPath = process.argv[3] || path.join(process.cwd(), "test-results", "fixtures", "reviews.large.generated.json");

/** 요청한 수가 queue 성능 fixture로 안전한 양의 정수인지 검증한다. */
function validCount(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10_000;
}

/** stable identifier와 균일한 shape를 가진 synthetic PR 행 하나를 만든다. */
function pullRequest(index) {
  return {
    repository: "fixture-org/review-demo",
    number: index + 1,
    title: `Generated review queue item ${index + 1}`,
    url: `https://example.invalid/fixture-org/review-demo/pull/${index + 1}`,
    author: `fixture-author-${index % 7}`,
    updatedAt: "2026-07-27T09:00:00Z",
    isDraft: index % 11 === 0,
    reviewDecision: index % 5 === 0 ? "CHANGES_REQUESTED" : undefined,
    mergeStateStatus: index % 13 === 0 ? "BLOCKED" : "CLEAN",
    requestedReviewers: ["fixture-reviewer"],
    assignees: ["fixture-maintainer"],
    labels: index % 2 === 0 ? ["priority:high"] : ["ui"],
  };
}

/** CLI 입력을 검증하고 지정한 파일에 compact JSON fixture를 기록한다. */
async function main() {
  if (!validCount(count)) {
    throw new Error("Fixture count must be an integer from 1 through 10000.");
  }
  const fixture = {
    schemaVersion: 1,
    surface: "reviews",
    state: "large",
    locale: "en",
    viewport: { width: 1280, height: 900 },
    payload: {
      snapshot: {
        repository: "fixture-org/review-demo",
        viewer: "fixture-reviewer",
        personal: { requested: [], authored: [], assigned: [], mentioned: [], participated: [] },
        management: { open: Array.from({ length: count }, (_value, index) => pullRequest(index)) },
        refreshedAt: "2026-07-27T09:00:00Z",
      },
    },
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

void main();
