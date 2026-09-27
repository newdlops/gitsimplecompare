import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitError, runGit } from "../src/git/gitExec";
import { GitService } from "../src/git/gitService";
import {
  BULK_CHECKIN_MIN_FILES,
  LINE_STATS_MAX_FILES,
  PATHSPEC_STDIN_MIN_CHARS,
  PATHSPEC_STDIN_MIN_PATHS,
  blobDiffSizeLimitArgs,
  bulkCheckinConfigArgs,
  shouldComputeLineStats,
  shouldPassPathspecsViaStdin,
} from "../src/git/largeChangeSet";
import { argvChunks, isUnsupportedPathspecFileError } from "../src/git/pathspecExec";
import { attachStatusStats, hasLineStatsWork } from "../src/git/statusStats";
import type { StatusGroups } from "../src/git/gitService";
import { vscodeGitStatusMayBeTruncated } from "../src/providers/vscodeGitStatusModel";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

const IS_WINDOWS = process.platform === "win32";
const BULK_FILES = BULK_CHECKIN_MIN_FILES + 100;

/**
 * 대량 변경 테스트용 격리 저장소를 만들고 기준 커밋을 남긴다.
 * @returns 테스트 종료 시 삭제할 임시 디렉터리와 저장소 루트
 */
async function createRepo(): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(path.join(tmpdir(), "gsc-large-change-"));
  const root = path.join(temp, "base");
  await mkdir(root);
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "Large Change Test"], root);
  await runGit(["config", "user.email", "large-change@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  await runGit(["config", "gc.auto", "0"], root);
  await put(root, ".gitignore", "ignored.log\n");
  await put(root, "src/keep.txt", "keep\n");
  await put(root, "src/modify.txt", "before\n");
  await put(root, "src/delete.txt", "delete me\n");
  await put(root, "exec.sh", "#!/bin/sh\necho hi\n");
  await runGit(["add", "-A"], root);
  await runGit(["commit", "--quiet", "-m", "base"], root);
  return { temp, root };
}

/**
 * 기준 커밋 위에 수정·삭제·모드 변경·미추적·ignored·특수 이름·대량 파일 변경을 만든다.
 * @param root 변경을 만들 저장소 루트
 * @returns 대량으로 추가한 파일들의 저장소 상대 경로
 */
async function makeWorkingChanges(root: string): Promise<string[]> {
  await put(root, "src/modify.txt", "after\n");
  await rm(path.join(root, "src/delete.txt"));
  await put(root, "empty.txt", "");
  await put(root, "binary.bin", Buffer.from([0, 1, 2, 0, 255, 10]));
  await put(root, "ignored.log", "ignored\n");
  if (!IS_WINDOWS) {
    await chmod(path.join(root, "exec.sh"), 0o755);
    await symlink("src/keep.txt", path.join(root, "link"));
    await put(root, "weird/star*.txt", "literal star\n");
    await put(root, "weird/starX.txt", "must stay unstaged when selecting star*\n");
    await put(root, ":(icase)Literal.txt", "literal magic\n");
  }
  const bulk: string[] = [];
  for (let index = 0; index < BULK_FILES; index++) {
    const file = `bulk/dir${index % 10}/file${String(index).padStart(5, "0")}.txt`;
    await put(root, file, `bulk ${index}\n`);
    bulk.push(file);
  }
  return bulk;
}

/**
 * 저장소 상대 경로에 파일을 기록한다.
 * @param root 저장소 루트
 * @param file 저장소 상대 경로
 * @param content 기록할 문자열 또는 바이트
 */
async function put(root: string, file: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/**
 * 저장소 디렉터리(.git 포함)를 그대로 복제해 같은 작업 상태의 독립 사본을 만든다.
 * @param source 원본 저장소 루트
 * @param target 새 사본 경로
 */
async function copyRepo(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
}

/** `git count-objects -v` 에서 pack 개수와 loose object 개수를 읽는다. */
async function objectCounts(root: string): Promise<{ packs: number; loose: number }> {
  const out = await runGit(["count-objects", "-v"], root);
  const read = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(out)?.[1] ?? NaN);
  return { packs: read("packs"), loose: read("count") };
}

/** 현재 index 를 tree 로 기록해 두 저장소의 stage 결과가 바이트 단위로 같은지 비교할 OID 를 얻는다. */
async function indexTree(root: string): Promise<string> {
  return (await runGit(["write-tree"], root)).trim();
}

test("대량 변경 정책은 bulk-checkin·stdin pathspec·라인 통계 기준을 경계값에서 정확히 나눈다", () => {
  assert.deepEqual(bulkCheckinConfigArgs(undefined), []);
  assert.deepEqual(bulkCheckinConfigArgs(BULK_CHECKIN_MIN_FILES - 1), []);
  assert.deepEqual(bulkCheckinConfigArgs(BULK_CHECKIN_MIN_FILES), ["-c", "core.bigFileThreshold=1"]);

  const short = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`);
  assert.equal(shouldPassPathspecsViaStdin(short(PATHSPEC_STDIN_MIN_PATHS - 1)), false);
  assert.equal(shouldPassPathspecsViaStdin(short(PATHSPEC_STDIN_MIN_PATHS)), true);
  assert.equal(shouldPassPathspecsViaStdin(["x".repeat(PATHSPEC_STDIN_MIN_CHARS)]), true);

  assert.equal(shouldComputeLineStats(LINE_STATS_MAX_FILES), true);
  assert.equal(shouldComputeLineStats(LINE_STATS_MAX_FILES + 1), false);
});

test("구버전 git fallback 은 argv 조각을 개수·길이 상한 안으로 나누고 unknown option 만 인식한다", () => {
  const paths = Array.from({ length: 250 }, (_, index) => `p${index}`);
  assert.deepEqual(argvChunks(paths).map((chunk) => chunk.length), [100, 100, 50]);
  assert.deepEqual(argvChunks(paths).flat(), paths);
  const long = Array.from({ length: 5 }, (_, index) => `${index}`.repeat(3000));
  assert.ok(argvChunks(long).every((chunk) => chunk.join(" ").length <= 8 * 1024 || chunk.length === 1));

  const hookFailure = new GitError(
    "git add --pathspec-from-file=- --pathspec-file-nul 실패: exit 1",
    "fatal: unable to write new index file"
  );
  assert.equal(isUnsupportedPathspecFileError(hookFailure), false);
  const oldGit = new GitError("git add 실패", "error: unknown option `pathspec-from-file=-'\nusage: git add");
  assert.equal(isUnsupportedPathspecFileError(oldGit), true);
});

test("bulk-checkin stageAll 은 일반 git add -A 와 같은 tree 를 만들고 pack 하나로 기록한다", async () => {
  const { temp, root } = await createRepo();
  try {
    await makeWorkingChanges(root);
    const normal = path.join(temp, "normal");
    const bulk = path.join(temp, "bulk");
    await copyRepo(root, normal);
    await copyRepo(root, bulk);

    await runGit(["add", "-A"], normal);
    await new GitService(bulk).stageAll({ expectedFileCount: BULK_FILES });

    assert.equal(await indexTree(bulk), await indexTree(normal));
    assert.equal(
      await runGit(["ls-files", "--stage"], bulk),
      await runGit(["ls-files", "--stage"], normal)
    );
    const normalObjects = await objectCounts(normal);
    const bulkObjects = await objectCounts(bulk);
    assert.equal(normalObjects.packs, 0);
    assert.ok(bulkObjects.packs >= 1, "bulk-checkin 은 blob 을 pack 에 기록해야 한다");
    assert.ok(bulkObjects.loose < normalObjects.loose, "bulk-checkin 은 loose object 를 거의 만들지 않아야 한다");
    await runGit(["fsck", "--strict", "--no-progress"], bulk);

    // 작은 stageAll 은 pack 을 만들지 않는 기존 loose object 경로를 유지한다.
    const small = path.join(temp, "small");
    await copyRepo(root, small);
    await new GitService(small).stageAll({ expectedFileCount: 3 });
    assert.equal((await objectCounts(small)).packs, 0);
    assert.equal(await indexTree(small), await indexTree(normal));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("대량 경로 stage/unstage/discard 는 stdin pathspec 으로 literal 이름을 정확히 처리한다", async () => {
  const { temp, root } = await createRepo();
  try {
    const bulkFiles = await makeWorkingChanges(root);
    const selected = [
      ...bulkFiles,
      "src/modify.txt",
      "src/delete.txt",
      ...(IS_WINDOWS ? [] : ["weird/star*.txt", ":(icase)Literal.txt"]),
    ];
    assert.ok(shouldPassPathspecsViaStdin(selected));
    const normal = path.join(temp, "normal");
    const viaService = path.join(temp, "service");
    await copyRepo(root, normal);
    await copyRepo(root, viaService);

    await runGit(["--literal-pathspecs", "add", "--", ...selected], normal);
    const service = new GitService(viaService);
    await service.stage(selected);

    assert.equal(await indexTree(viaService), await indexTree(normal));
    const staged = (await runGit(["diff", "--cached", "--name-only", "-z"], viaService)).split("\0");
    if (!IS_WINDOWS) {
      assert.ok(staged.includes("weird/star*.txt"));
      assert.ok(staged.includes(":(icase)Literal.txt"));
      assert.ok(!staged.includes("weird/starX.txt"), "star* 는 glob 이 아니라 literal 경로여야 한다");
    }
    assert.ok((await objectCounts(viaService)).packs >= 1);

    await service.unstage(selected);
    await runGit(["diff", "--cached", "--quiet"], viaService);

    // 추적 파일 수백 개를 수정한 뒤 discard 도 stdin pathspec 으로 한 번에 되돌린다.
    await runGit(["add", "--", ...bulkFiles.slice(0, 300)], viaService);
    await runGit(["commit", "--quiet", "-m", "track bulk"], viaService);
    for (const file of bulkFiles.slice(0, 300)) {
      await put(viaService, file, "dirty\n");
    }
    await service.discard(bulkFiles.slice(0, 300));
    assert.equal(await runGit(["diff", "--name-only", "--", "bulk"], viaService), "");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("commit --quiet 은 성공 요약만 생략하고 커밋할 것이 없을 때의 진단 출력은 보존한다", async () => {
  const { temp, root } = await createRepo();
  try {
    const service = new GitService(root);
    await put(root, "src/modify.txt", "committed\n");
    await service.stageAll();
    await service.commit("feat: quiet commit\n\nbody line");
    assert.equal((await runGit(["log", "-1", "--format=%s%n%b"], root)).trim(), "feat: quiet commit\nbody line");

    await assert.rejects(service.commit("nothing"), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.match(`${error.stdout}\n${error.stderr}`, /nothing to commit/);
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("라인 통계는 상한을 넘는 bucket 의 numstat 을 실행하지 않고 +/- 를 비운다", async () => {
  const large = Array.from({ length: LINE_STATS_MAX_FILES + 1 }, (_, index) => ({
    status: "M" as const,
    path: `big/${index}.ts`,
    additions: 9,
    deletions: 9,
  }));
  const groups: StatusGroups = {
    staged: [{ status: "M", path: "small.ts" }],
    unstaged: large,
  };
  const commands: string[][] = [];
  const result = await attachStatusStats("/unused", groups, async (args) => {
    commands.push(args);
    return "3\t1\tsmall.ts\0";
  });

  assert.deepEqual(commands, [[...blobDiffSizeLimitArgs(), "diff", "--cached", "--numstat", "-z", "-M"]]);
  assert.deepEqual(result.staged, [{ status: "M", path: "small.ts", additions: 3, deletions: 1 }]);
  assert.equal(result.unstaged.length, large.length);
  assert.ok(result.unstaged.every((item) => item.additions === undefined && item.deletions === undefined));

  assert.equal(hasLineStatsWork(groups), true);
  assert.equal(hasLineStatsWork({ staged: [], unstaged: large }), false);
  assert.equal(hasLineStatsWork({ staged: [], unstaged: [] }), false);
});

test("VS Code Git statusLimit 잘림 판정은 합계가 한도 이상일 때만 CLI 폴백을 요구한다", () => {
  const change = { uri: { fsPath: "/repo/a" }, status: 5 };
  const state = (count: number) => ({
    indexChanges: Array.from({ length: Math.floor(count / 2) }, () => change),
    workingTreeChanges: Array.from({ length: count - Math.floor(count / 2) }, () => change),
    untrackedChanges: [],
    mergeChanges: [],
  });
  assert.equal(vscodeGitStatusMayBeTruncated(state(9), 10), false);
  assert.equal(vscodeGitStatusMayBeTruncated(state(10), 10), true);
  assert.equal(vscodeGitStatusMayBeTruncated(state(50), 0), false);
  assert.equal(vscodeGitStatusMayBeTruncated(state(50), Number.NaN), false);
});
