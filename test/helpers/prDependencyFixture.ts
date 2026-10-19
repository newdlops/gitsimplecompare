import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { git, safetyFixture } from "./gitSafetyFixture";
import { safetyPullRequest } from "./prOperationSafetyFixture";

/** A가 파일을 추가하고 B가 그 파일을 수정하는 독립 저장소를 만든다. 대상 main에는 둘 다 없다. */
export async function prDependencyFixture(t: TestContext) {
  const setup = await safetyFixture(t, "pr-prerequisite");
  const { root, head: base } = setup;
  await git(root, "switch", "-qc", "prerequisite");
  await writeFile(join(root, "기능\tfile.ts"), "export const feature = 'first';\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "prerequisite feature");
  const parent = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "기능\tfile.ts"), "export const feature = 'second';\n");
  await git(root, "commit", "-qam", "dependent feature");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main");
  const prerequisite = { ...safetyPullRequest(parent), number: 41, title: "선행 기능을 추가하는 긴 제목 · prerequisite feature",
    url: "https://example.invalid/owner/repo/pull/41", headRefName: "prerequisite", commitHashesComplete: true };
  const pr = { ...safetyPullRequest(head), url: "https://example.invalid/owner/repo/pull/42", baseRefName: "prerequisite", commitHashesComplete: true };
  return { ...setup, base, parent, prerequisite, pr };
}
