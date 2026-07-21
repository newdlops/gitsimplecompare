import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  EMPTY_TREE_REF,
  FileHistoryService,
  parseFileHistoryLog,
} from "../src/git/fileHistoryService";
import { fileHistoryResourceLocation } from "../src/utils/fileHistoryResource";

const execFileAsync = promisify(execFile);
const RECORD_MARKER = "\x1eGSC_FILE_HISTORY_COMMIT_V1\x1e";
const RECORD_BOUNDARY = `\0${RECORD_MARKER}\0`;
const TEST_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};

interface FixtureCommit {
  hash: string;
  shortHash?: string;
  parents?: string;
  author?: string;
  dateIso?: string;
  relativeDate?: string;
  title: string;
  message?: string;
}

/**
 * 테스트가 실제 HISTORY_LOG_FORMAT 과 같은 NUL 필드 레코드를 만들게 한다.
 * @param commit pretty-format 메타데이터 필드
 * @param payload raw 상태와 numstat 을 NUL 토큰 순서로 적은 배열
 * @returns parseFileHistoryLog 에 바로 전달할 한 커밋 원문
 */
function historyRecord(commit: FixtureCommit, payload: string[]): string {
  const fields = [
    commit.hash,
    commit.shortHash ?? commit.hash.slice(0, 7),
    commit.parents ?? "",
    commit.author ?? "History Author",
    commit.dateIso ?? "2026-07-13T12:00:00+09:00",
    commit.relativeDate ?? "2 minutes ago",
    commit.title,
    commit.message ?? `${commit.title}\n`,
  ];
  return `${RECORD_BOUNDARY}${fields.join("\0")}\0\0${payload.join("\0")}\0`;
}

/**
 * 테스트 저장소에서 Git 을 셸 없이 실행해 파일명 escaping 영향을 피한다.
 * @param repoRoot 명령을 실행할 저장소 루트
 * @param args git 하위 명령과 인자
 * @returns UTF-8 stdout 문자열
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: TEST_ENV,
  });
  return result.stdout;
}

/**
 * 전역 Git 설정과 분리된 최소 저장소를 만들고 테스트 작성자를 고정한다.
 * @returns 테스트가 커밋을 자유롭게 만들 수 있는 임시 저장소 경로
 */
async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "gsc-file-history-"));
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["config", "user.name", "History Test"]);
  await git(repoRoot, ["config", "user.email", "history@example.com"]);
  return repoRoot;
}

/**
 * 임시 저장소를 생성해 테스트 본문을 실행하고 실패 여부와 무관하게 정리한다.
 * @param run 생성된 저장소 루트를 받는 비동기 테스트 본문
 */
async function withRepo(
  run: (repoRoot: string) => Promise<void>
): Promise<void> {
  const repoRoot = await createRepo();
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

/**
 * 현재 index 내용을 제목과 선택적 본문으로 커밋한다.
 * @param repoRoot 테스트 저장소 루트
 * @param title 커밋 subject
 * @param body 선택적 커밋 본문
 */
async function commit(
  repoRoot: string,
  title: string,
  body?: string
): Promise<void> {
  const args = ["commit", "-q", "-m", title];
  if (body) {
    args.push("-m", body);
  }
  await git(repoRoot, args);
}

test("rename 토큰을 새 경로 통계와 결합하고 이전 경로로 log walk를 이어 간다", () => {
  const newest = historyRecord(
    {
      hash: "3333333333333333333333333333333333333333",
      parents: "2222222222222222222222222222222222222222",
      title: "modify renamed file",
    },
    [
      "\n:100644 100644 aaaaaaa bbbbbbb M",
      "src/renamed file.ts",
      "2\t1\tsrc/renamed file.ts",
    ]
  );
  const rename = historyRecord(
    {
      hash: "2222222222222222222222222222222222222222",
      parents: "1111111111111111111111111111111111111111",
      title: "rename file",
    },
    [
      "\n:100644 100644 ccccccc ddddddd R073",
      "src/original.ts",
      "src/renamed file.ts",
      "1\t0\t",
      "src/original.ts",
      "src/renamed file.ts",
    ]
  );
  const root = historyRecord(
    {
      hash: "1111111111111111111111111111111111111111",
      title: "root file",
    },
    [
      "\n:000000 100644 0000000 eeeeeee A",
      "src/original.ts",
      "3\t0\tsrc/original.ts",
    ]
  );

  const result = parseFileHistoryLog(
    `${newest}${rename}${root}`,
    "src/renamed file.ts"
  );

  assert.deepEqual(
    result.map((entry) => ({
      status: entry.status,
      path: entry.path,
      oldPath: entry.oldPath,
      additions: entry.additions,
      deletions: entry.deletions,
    })),
    [
      {
        status: "M",
        path: "src/renamed file.ts",
        oldPath: undefined,
        additions: 2,
        deletions: 1,
      },
      {
        status: "R",
        path: "src/renamed file.ts",
        oldPath: "src/original.ts",
        additions: 1,
        deletions: 0,
      },
      {
        status: "A",
        path: "src/original.ts",
        oldPath: undefined,
        additions: 3,
        deletions: 0,
      },
    ]
  );
  assert.equal(result[2]?.baseRef, EMPTY_TREE_REF);
});

test("NUL 메타데이터 필드는 메시지 제어 문자와 merge 첫 부모를 보존한다", () => {
  const message = "merge subject\n\nrecord \x1e and field \x1f stay intact\n";
  const raw = historyRecord(
    {
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortHash: "aaaaaaa",
      parents:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc",
      author: "테스트 작성자",
      dateIso: "2026-07-13T10:20:30+09:00",
      relativeDate: "3 hours ago",
      title: "merge subject",
      message,
    },
    [
      "\n:100644 100644 1234567 7654321 M",
      "src/merge.ts",
      "4\t2\tsrc/merge.ts",
    ]
  );

  const [entry] = parseFileHistoryLog(raw, "src/merge.ts");

  assert.equal(
    entry?.baseRef,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );
  assert.equal(entry?.shortHash, "aaaaaaa");
  assert.equal(entry?.author, "테스트 작성자");
  assert.equal(entry?.dateIso, "2026-07-13T10:20:30+09:00");
  assert.equal(entry?.relativeDate, "3 hours ago");
  assert.equal(entry?.message, message.trimEnd());
  assert.equal(entry?.additions, 4);
  assert.equal(entry?.deletions, 2);
});

test("binary numstat과 diff 없는 레코드의 기존 fallback 의미를 유지한다", () => {
  const binary = historyRecord(
    {
      hash: "dddddddddddddddddddddddddddddddddddddddd",
      parents: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      title: "binary update",
    },
    [
      "\n:100644 100644 1234567 7654321 M",
      "assets/image.bin",
      "-\t-\tassets/image.bin",
    ]
  );
  const noDiff = historyRecord(
    {
      hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      parents: "ffffffffffffffffffffffffffffffffffffffff",
      title: "metadata only",
    },
    []
  );
  const malformed = `${RECORD_BOUNDARY}too-few\0fields\0`;

  const result = parseFileHistoryLog(
    `${binary}${noDiff}${malformed}`,
    "\\assets\\image.bin"
  );

  assert.equal(result.length, 2);
  assert.deepEqual(
    {
      status: result[0]?.status,
      path: result[0]?.path,
      additions: result[0]?.additions,
      deletions: result[0]?.deletions,
    },
    { status: "M", path: "assets/image.bin", additions: 0, deletions: 0 }
  );
  assert.equal(result[1]?.status, "M");
  assert.equal(result[1]?.path, "assets/image.bin");
  assert.equal(result[1]?.additions, undefined);
});

test("레코드 표식이나 raw 헤더처럼 생긴 파일명도 문법상 경로 위치에서 보존한다", () => {
  const markerPath = RECORD_MARKER;
  const rawHeaderPath = ":100644 100644 1234567 7654321 M";
  const markerRecord = historyRecord(
    {
      hash: "1212121212121212121212121212121212121212",
      title: "marker path",
      message: RECORD_MARKER,
    },
    [
      "\n:000000 100644 0000000 1234567 A",
      markerPath,
      `1\t0\t${markerPath}`,
    ]
  );
  const headerRecord = historyRecord(
    {
      hash: "3434343434343434343434343434343434343434",
      title: "raw-looking path",
    },
    [
      "\n:000000 100644 0000000 7654321 A",
      rawHeaderPath,
      `2\t0\t${rawHeaderPath}`,
    ]
  );

  const markerHistory = parseFileHistoryLog(markerRecord, markerPath);
  const headerHistory = parseFileHistoryLog(headerRecord, rawHeaderPath);

  assert.equal(markerHistory.length, 1);
  assert.equal(markerHistory[0]?.path, markerPath);
  assert.equal(markerHistory[0]?.message, RECORD_MARKER);
  assert.equal(markerHistory[0]?.additions, 1);
  assert.equal(headerHistory.length, 1);
  assert.equal(headerHistory[0]?.path, rawHeaderPath);
  assert.equal(headerHistory[0]?.additions, 2);
});

test("삭제 diff의 ref URI에서 저장소와 파일 히스토리 경로를 복원한다", () => {
  const location = fileHistoryResourceLocation({
    scheme: "gitsimplecompare",
    fsPath: "/src/removed file.ts",
    path: "/src/removed file.ts",
    query: JSON.stringify({
      ref: "HEAD",
      repoRoot: "/workspace/example repo",
    }),
  });

  assert.deepEqual(location, {
    kind: "refDocument",
    repoRoot: "/workspace/example repo",
    relPath: "src/removed file.ts",
  });
});

test("파일 URI는 작업 파일로 유지하고 손상된 ref URI는 거부한다", () => {
  assert.deepEqual(
    fileHistoryResourceLocation({
      scheme: "file",
      fsPath: "/workspace/src/live.ts",
      path: "/workspace/src/live.ts",
      query: "",
    }),
    { kind: "workingFile", fsPath: "/workspace/src/live.ts" }
  );
  assert.equal(
    fileHistoryResourceLocation({
      scheme: "gitsimplecompare",
      fsPath: "/../outside.ts",
      path: "/../outside.ts",
      query: JSON.stringify({ ref: ":0", repoRoot: "/workspace" }),
    }),
    undefined
  );
  assert.equal(
    fileHistoryResourceLocation({
      scheme: "untitled",
      fsPath: "",
      path: "/scratch.ts",
      query: "",
    }),
    undefined
  );
});

test("실제 저장소에서 root, modify, rename, 본문 메타데이터를 한 번에 조회한다", async () => {
  await withRepo(async (repoRoot) => {
    const oldPath = "original file.txt";
    const newPath = "renamed file.txt";
    await writeFile(path.join(repoRoot, oldPath), "alpha\nbeta\n", "utf8");
    await git(repoRoot, ["add", oldPath]);
    await commit(repoRoot, "root file");

    await writeFile(
      path.join(repoRoot, oldPath),
      "alpha\nbeta\ngamma\n",
      "utf8"
    );
    await git(repoRoot, ["add", oldPath]);
    await commit(repoRoot, "modify original");

    await git(repoRoot, ["mv", oldPath, newPath]);
    await commit(repoRoot, "rename file");

    await writeFile(
      path.join(repoRoot, newPath),
      "alpha\nchanged\ngamma\n",
      "utf8"
    );
    await git(repoRoot, ["add", newPath]);
    await commit(repoRoot, "latest subject", "line one\nline two");

    const history = await new FileHistoryService(repoRoot).listFileHistory(
      newPath,
      20
    );

    assert.deepEqual(
      history.map((entry) => entry.title),
      ["latest subject", "rename file", "modify original", "root file"]
    );
    assert.deepEqual(
      history.map((entry) => entry.status),
      ["M", "R", "M", "A"]
    );
    assert.deepEqual(
      history.map((entry) => entry.path),
      [newPath, newPath, oldPath, oldPath]
    );
    assert.equal(history[1]?.oldPath, oldPath);
    assert.deepEqual(
      history.map((entry) => [entry.additions, entry.deletions]),
      [
        [1, 1],
        [0, 0],
        [1, 0],
        [2, 0],
      ]
    );
    assert.equal(history[3]?.baseRef, EMPTY_TREE_REF);
    assert.equal(history[0]?.message, "latest subject\n\nline one\nline two");
    assert.equal(history[0]?.author, "History Test");
    assert.match(history[0]?.dateIso ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(history[0]?.relativeDate);
  });
});

test("pathspec 문자가 든 실제 파일명은 비슷한 다른 파일의 커밋을 섞지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    const literalPath = "literal*.txt";
    const wildcardMatch = "literalX.txt";
    await writeFile(path.join(repoRoot, literalPath), "literal\n", "utf8");
    await git(repoRoot, ["add", literalPath]);
    await commit(repoRoot, "literal star file");

    await writeFile(path.join(repoRoot, wildcardMatch), "other\n", "utf8");
    await git(repoRoot, ["add", wildcardMatch]);
    await commit(repoRoot, "wildcard match only");

    const history = await new FileHistoryService(repoRoot).listFileHistory(
      literalPath,
      20
    );
    assert.deepEqual(
      history.map((entry) => entry.title),
      ["literal star file"]
    );
    assert.equal(history[0]?.path, literalPath);
  });
});

test("작업트리와 index에서 삭제된 파일도 마지막 경로의 히스토리를 조회한다", async () => {
  await withRepo(async (repoRoot) => {
    const deletedPath = "src/deleted file.txt";
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, deletedPath), "first\n", "utf8");
    await git(repoRoot, ["add", deletedPath]);
    await commit(repoRoot, "add deletable file");

    await writeFile(
      path.join(repoRoot, deletedPath),
      "first\nsecond\n",
      "utf8"
    );
    await git(repoRoot, ["add", deletedPath]);
    await commit(repoRoot, "update deletable file");
    await unlink(path.join(repoRoot, deletedPath));

    const service = new FileHistoryService(repoRoot);
    const unstagedHistory = await service.listFileHistory(deletedPath, 20);
    assert.deepEqual(
      unstagedHistory.map((entry) => entry.title),
      ["update deletable file", "add deletable file"]
    );

    await git(repoRoot, ["add", "-u", "--", deletedPath]);
    const stagedHistory = await service.listFileHistory(deletedPath, 20);
    assert.deepEqual(
      stagedHistory.map((entry) => entry.title),
      ["update deletable file", "add deletable file"]
    );

    await commit(repoRoot, "delete file");
    const committedHistory = await service.listFileHistory(deletedPath, 20);
    assert.deepEqual(
      committedHistory.map((entry) => entry.title),
      ["delete file", "update deletable file", "add deletable file"]
    );
    assert.deepEqual(
      committedHistory.map((entry) => entry.status),
      ["D", "M", "A"]
    );
  });
});
