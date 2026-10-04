import assert from "node:assert/strict";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseNameStatusZ, parseNumstat, parsePorcelainSummaryZ, parseRawNumstatZ } from "../src/git/diffParse";
import { runGit } from "../src/git/gitExec";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { GitService } from "../src/git/gitService";
import { GitLogService, ONGOING_COMMIT_HASH, STAGED_COMMIT_HASH } from "../src/git/gitLogService";
import type { FileChange } from "../src/git/gitTypes";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** raw 상태 레코드를 만들어 경로와 상태 점수의 경계를 독립적으로 검증한다. */
function rawRecord(status: string, ...paths: string[]): string {
  return `:100644 100644 abc1234 def5678 ${status}\0${paths.join("\0")}\0`;
}

test("raw+numstat은 경로의 공백·탭·줄바꿈·화살표와 콜론을 그대로 보존한다", () => {
  const paths = ["  한글\tline\n => file.txt ", ":100644 header-like.txt", "literal/{a => b}.txt"];
  const raw = paths.map(file => rawRecord("M", file)).join("")
    + paths.map(file => `3\t1\t${file}\0`).join("");
  assert.deepEqual(parseRawNumstatZ(raw), paths.map(file => ({
    status: "M", path: file, additions: 3, deletions: 1,
  })));
  assert.deepEqual([...parseNumstat(`3\t1\t${paths[0]}\0`).keys()], [paths[0]]);
});

test("이름변경·복사는 목적지 통계와 결합하고 바이너리는 기존 0/0 표시를 유지한다", () => {
  const raw = rawRecord("R098", "old.txt", " renamed.txt ")
    + rawRecord("C075", "source.txt", "copy\tfile.txt")
    + rawRecord("M", "binary.dat")
    + "2\t1\t\0old.txt\0 renamed.txt \0"
    + "4\t0\t\0source.txt\0copy\tfile.txt\0"
    + "-\t-\tbinary.dat\0";
  assert.deepEqual(parseRawNumstatZ(raw), [
    { status: "R", path: " renamed.txt ", oldPath: "old.txt", additions: 2, deletions: 1 },
    { status: "C", path: "copy\tfile.txt", oldPath: "source.txt", additions: 4, deletions: 0 },
    { status: "M", path: "binary.dat", additions: 0, deletions: 0 },
  ]);
});

test("SHA-256 길이의 raw OID, 재작성 점수와 통계 없는 상태도 파싱한다", () => {
  const raw = `:100644 100755 ${"a".repeat(64)} ${"b".repeat(64)} M100\0mode.txt\0`;
  assert.deepEqual(parseRawNumstatZ(raw), [
    { status: "M", path: "mode.txt", additions: undefined, deletions: undefined },
  ]);
  assert.deepEqual(parseRawNumstatZ(""), []);
  assert.throws(() => parseRawNumstatZ(":invalid\0path\0"), /raw diff header/);
  assert.throws(() => parseRawNumstatZ(rawRecord("R100", "old.txt")), /destination path/);
});

test("v2 요약은 최초 커밋·detached HEAD와 추가 헤더를 처리하고 이름변경 경로를 헤더로 읽지 않는다", () => {
  const head = "a".repeat(40);
  assert.deepEqual(parsePorcelainSummaryZ(`# branch.oid ${head}\0# branch.head (detached)\0# future ignored\0`),
    { head, hasChanges: false });
  assert.deepEqual(parsePorcelainSummaryZ("# branch.oid (initial)\0# branch.head main\0? new.txt\0"),
    { head: undefined, hasChanges: true });
  assert.deepEqual(parsePorcelainSummaryZ(`# branch.oid ${head}\0# branch.head main\0`
    + `2 R. N... 100644 100644 100644 ${head} ${head} R100 new.txt\0# branch.oid ${"b".repeat(40)}\0`),
  { head, hasChanges: true });
  assert.deepEqual(parsePorcelainSummaryZ(`# branch.oid ${"c".repeat(64)}\0# branch.head main\0`),
    { head: "c".repeat(64), hasChanges: false });
});

/** 기존 두 diff의 결과를 비교 기준으로 만들고 표시용 oldPath/통계 필드를 맞춘다. */
async function legacyDiff(root: string, args: string[]): Promise<FileChange[]> {
  const names = await runGit(["diff", "--name-status", "-z", "-M", ...args], root);
  const stats = parseNumstat(await runGit(["diff", "--numstat", "-z", "-M", ...args], root));
  return normalize(parseNameStatusZ(names).map(change => ({ ...change, ...stats.get(change.path) })));
}

/** 서비스별 선택 필드 차이를 제거하고 파일 순서·상태·증감 자체를 비교한다. */
function normalize(changes: FileChange[]): FileChange[] {
  return changes.map(change => ({
    status: change.status, path: change.path, oldPath: change.oldPath,
    additions: change.additions, deletions: change.deletions,
  }));
}

/** 실제 서비스 동작 중 diff 프로세스 수를 세어 실행 횟수 감소를 검증한다. */
async function countDiffs<T>(read: () => Promise<T>): Promise<{ result: T; count: number; commands: string[] }> {
  const commands: string[] = [];
  const release = setGitExecutionObserver(timing => { commands.push(timing.command); });
  try {
    const result = await read();
    return { result, count: commands.filter(command => command === "diff").length, commands };
  }
  finally { release(); }
}

test("브랜치 비교와 루트/일반 커밋 상세는 기존 결과를 Git diff 한 번으로 반환한다", async t => {
  const { root, head: rootCommit } = await safetyFixture(t, "combined-diff");
  const log = new GitLogService(root);
  const initial = await countDiffs(() => log.getCommitDetail(rootCommit));
  assert.equal(initial.count, 1);
  assert.deepEqual(normalize(initial.result.files), [
    { status: "A", path: "tracked.txt", oldPath: undefined, additions: 1, deletions: 0 },
  ]);

  const special = "  한글\tline\n => file.txt ";
  const oldText = Array.from({ length: 80 }, (_, i) => `rename line ${i}\n`).join("");
  await writeFile(path.join(root, "old.txt"), oldText);
  await writeFile(path.join(root, "delete.txt"), "removed\n");
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, special), "before\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "comparison base");
  const base = await git(root, "rev-parse", "HEAD");
  await rename(path.join(root, "old.txt"), path.join(root, "new.txt"));
  await writeFile(path.join(root, "new.txt"), oldText + "added rename line\n");
  await rm(path.join(root, "delete.txt"));
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 3, 4]));
  await writeFile(path.join(root, special), "after\nextra\n");
  await writeFile(path.join(root, "added.txt"), "new\n");
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "comparison target");
  const target = await git(root, "rev-parse", "HEAD");
  const expected = await legacyDiff(root, [base, target]);
  assert.ok(expected.some(change => change.status === "R"));
  assert.equal(expected.find(change => change.path === special)?.additions, 2);
  const service = new GitService(root);
  for (const mode of ["twoDot", "threeDot"] as const) {
    const actual = await countDiffs(() => service.listChanges(base, target, mode));
    assert.equal(actual.count, 1);
    assert.deepEqual(normalize(actual.result), expected);
  }
  const detail = await countDiffs(() => log.getCommitDetail(target));
  assert.equal(detail.count, 1);
  assert.deepEqual(normalize(detail.result.files), expected);
});

test("작업트리/스테이징 가상 상세는 각각 diff 한 번으로 조회하고 미추적 파일을 보존한다", async t => {
  const { root, head } = await safetyFixture(t, "combined-virtual-diff");
  const log = new GitLogService(root);
  const clean = await countDiffs(() => log.getVirtualCommits());
  assert.deepEqual(clean.commands, ["rev-parse", "status"]);
  assert.deepEqual(clean.result, []);
  await writeFile(path.join(root, "tracked.txt"), "staged\n");
  await git(root, "add", "tracked.txt");
  await writeFile(path.join(root, "tracked.txt"), "working\nextra\n");
  await writeFile(path.join(root, "untracked.txt"), "untracked\n");
  const dirty = await countDiffs(() => log.getVirtualCommits());
  assert.deepEqual(dirty.commands, ["rev-parse", "status"]);
  assert.deepEqual(dirty.result.map(commit => [commit.hash, commit.parents]), [
    [ONGOING_COMMIT_HASH, [STAGED_COMMIT_HASH]], [STAGED_COMMIT_HASH, [head]],
  ]);
  const staged = await countDiffs(() => log.getCommitDetail(STAGED_COMMIT_HASH));
  assert.equal(staged.count, 1);
  assert.deepEqual(normalize(staged.result.files), await legacyDiff(root, ["--cached", "HEAD"]));
  const ongoing = await countDiffs(() => log.getCommitDetail(ONGOING_COMMIT_HASH));
  assert.equal(ongoing.count, 1);
  const tracked = ongoing.result.files.filter(file => file.path !== "untracked.txt");
  assert.deepEqual(normalize(tracked), await legacyDiff(root, ["HEAD"]));
  assert.deepEqual(ongoing.result.files.find(file => file.path === "untracked.txt"), {
    status: "A", path: "untracked.txt", additions: 1, deletions: 0,
  });
  await git(root, "checkout", "--detach", head);
  const detached = await countDiffs(() => log.getVirtualCommits());
  assert.deepEqual(detached.commands, ["rev-parse", "status"]);
  assert.deepEqual(detached.result[1].parents, [head]);
  await git(root, "checkout", "--orphan", "unborn");
  const unborn = await countDiffs(() => log.getVirtualCommits());
  assert.deepEqual(unborn.commands, ["rev-parse", "status"]);
  assert.deepEqual(unborn.result[1].parents, []);
});

test("충돌 중의 작업트리/인덱스 비교도 기존 상태와 통계가 같다", async t => {
  const { root } = await safetyFixture(t, "combined-conflict-diff");
  await git(root, "checkout", "-qb", "side");
  await writeFile(path.join(root, "tracked.txt"), "side\n");
  await git(root, "commit", "-qam", "side");
  await git(root, "checkout", "main");
  await writeFile(path.join(root, "tracked.txt"), "main\n");
  await git(root, "commit", "-qam", "main");
  const firstParent = await git(root, "rev-parse", "HEAD");
  await assert.rejects(git(root, "merge", "side"));
  const log = new GitLogService(root);
  for (const [hash, args] of [[STAGED_COMMIT_HASH, ["--cached", "HEAD"]], [ONGOING_COMMIT_HASH, ["HEAD"]]] as const) {
    const actual = await countDiffs(() => log.getCommitDetail(hash));
    assert.equal(actual.count, 1);
    assert.deepEqual(normalize(actual.result.files), await legacyDiff(root, [...args]));
  }
  await writeFile(path.join(root, "tracked.txt"), "resolved\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-qm", "resolved merge");
  const merge = await git(root, "rev-parse", "HEAD");
  const detail = await countDiffs(() => log.getCommitDetail(merge));
  assert.equal(detail.count, 1);
  assert.equal(detail.result.parents.length, 2);
  assert.deepEqual(normalize(detail.result.files), await legacyDiff(root, [firstParent, merge]));
});
