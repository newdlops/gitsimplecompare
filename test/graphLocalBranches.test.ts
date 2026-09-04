import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { readGraphLocalBranchSnapshot } from "../src/git/graphLocalBranches";
import { GitLogService } from "../src/git/gitLogService";
import { resolveBranchFilter } from "../src/webview/graphBranchFilter";

const BROKEN_HASH = "1111111111111111111111111111111111111111";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 정상 커밋과 브랜치 두 개를 가진 격리 저장소를 만든다.
 * @returns 테스트 종료 시 재귀 삭제할 임시 저장소 경로
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-graph-ref-health-"));
  await runGit(["init", "--quiet", "-b", "main"], root);
  await runGit(["config", "user.name", "Graph Ref Test"], root);
  await runGit(["config", "user.email", "graph-ref@example.test"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  await writeFile(path.join(root, "tracked.txt"), "graph\n", "utf8");
  await runGit(["add", "--", "tracked.txt"], root);
  await runGit(["commit", "-m", "healthy graph commit"], root);
  await runGit(["branch", "healthy-feature"], root);
  return root;
}

/** Git이 만들 수 없는 missing-object branch ref를 fixture의 refs/heads 아래에 직접 기록한다. */
async function writeBrokenBranch(root: string): Promise<void> {
  const gitPath = (await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "refs/heads/broken-local"],
    root
  )).trim();
  await writeFile(gitPath, `${BROKEN_HASH}\n`, "utf8");
}

test("손상 로컬 ref를 격리하고 정상 브랜치 Graph를 계속 읽는다", async () => {
  const root = await createRepository();
  try {
    const healthy = await readGraphLocalBranchSnapshot(root);
    assert.deepEqual(healthy.invalidRefs, []);
    assert.deepEqual(healthy.branches.map((branch) => branch.name).sort(), ["healthy-feature", "main"]);

    await writeBrokenBranch(root);
    await assert.rejects(
      () => runGit([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short) %(committerdate:iso8601-strict)",
        "refs/heads",
      ], root),
      /missing object|bad ref|bad object/i
    );

    const snapshot = await readGraphLocalBranchSnapshot(root);
    assert.deepEqual(snapshot.invalidRefs, [{
      name: "broken-local",
      fullRef: "refs/heads/broken-local",
      hash: BROKEN_HASH,
      kind: "local",
    }]);
    assert.deepEqual(snapshot.branches.map((branch) => branch.name).sort(), ["healthy-feature", "main"]);
    assert.equal(snapshot.branches.find((branch) => branch.name === "main")?.current, true);
    assert.equal(snapshot.branches.every((branch) => branch.subject === "healthy graph commit"), true);

    const filter = resolveBranchFilter(
      { mode: "all", selected: [], compact: true },
      snapshot.branches.map((branch) => ({ name: branch.name, kind: "local" as const })),
      "ready",
      true
    );
    assert.deepEqual(filter.refs.sort(), ["healthy-feature", "main"]);
    assert.equal(filter.filtersRefs, true);
    const commits = await new GitLogService(root).getCommitPage(20, 0, filter.refs, false);
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, "healthy graph commit");
    assert.equal((await runGit(["rev-parse", "refs/heads/broken-local"], root)).trim(), BROKEN_HASH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rich 조회 실패에 손상 ref 증거가 없으면 원래 오류를 숨기지 않는다", async () => {
  let calls = 0;
  await assert.rejects(
    () => readGraphLocalBranchSnapshot(
      "/repo",
      async () => {
        calls++;
        if (calls === 1) throw new Error("branch permission denied");
        return ["refs/heads/main", "main", "abc", "*", "", ""].join("\x1f");
      },
      async () => "abc commit\n"
    ),
    /branch permission denied/
  );
  assert.equal(calls, 2);
});
