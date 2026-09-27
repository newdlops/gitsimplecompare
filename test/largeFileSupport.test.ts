import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readCommitMessageContext } from "../src/git/aiMessageContext";
import { parseNumstat } from "../src/git/diffParse";
import { runGit } from "../src/git/gitExec";
import { GitService, type StatusGroups } from "../src/git/gitService";
import {
  DIFF_PREVIEW_HARD_MAX_BYTES,
  FileTooLargeError,
  LINE_STATS_MAX_FILE_BYTES,
  MAX_LARGE_FILE_EXCLUDES,
  blobDiffSizeLimitArgs,
  diffPreviewLimitBytes,
  largeFileExcludePathspecs,
} from "../src/git/largeChangeSet";
import { attachStatusStats } from "../src/git/statusStats";
import { BranchContentProvider } from "../src/providers/branchContentProvider";
import { divertLargeWorkingFileDiff, isLargeFilePreviewError } from "../src/ui/largeFilePreview";
import { makeRefUri } from "../src/utils/uri";
import * as vscodeMock from "./helpers/vscodeMock";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

const IS_WINDOWS = process.platform === "win32";
const MB = 1024 * 1024;

/** 라인 통계 상한을 넘는 여러 줄 텍스트를 만든다(binary 판정이 아니라 크기 판정을 검증하기 위해). */
function largeText(tag: string): string {
  const line = `${tag} log line with enough text to be a normal text file\n`;
  return line.repeat(Math.ceil((LINE_STATS_MAX_FILE_BYTES + MB) / line.length));
}

/**
 * 대용량 파일 테스트용 격리 저장소를 만든다.
 * @returns 저장소 루트(테스트 종료 시 삭제)
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-large-file-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "Large File Test"], root);
  await runGit(["config", "user.email", "large-file@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/** 저장소 상대 경로에 파일을 기록한다. */
async function put(root: string, file: string, content: string): Promise<void> {
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/**
 * vscode mock 의 `diffEditor.maxFileSize` 설정을 테스트 동안만 바꾼다.
 * @param t 종료 시 원복을 등록할 테스트 컨텍스트
 * @param maxFileSizeMb diff 미리보기 한도(MB)
 */
function useDiffMaxFileSize(t: { after(fn: () => void): void }, maxFileSizeMb: number): void {
  const workspace = vscodeMock.workspace as any;
  const original = workspace.getConfiguration;
  workspace.getConfiguration = (section?: string) => ({
    get: (key: string) => (section === "diffEditor" && key === "maxFileSize" ? maxFileSizeMb : original().get(key)),
  });
  t.after(() => {
    workspace.getConfiguration = original;
  });
}

/** 실제 git 을 실행하면서 인자를 기록하는 통계용 실행 함수를 만든다. */
function recordingRun(root: string, commands: string[][]) {
  return (args: string[]) => {
    commands.push(args);
    return runGit(args, root);
  };
}

test("대용량 파일 정책은 blob 크기 임계값·제외 pathspec·diff 미리보기 한도를 만든다", () => {
  assert.deepEqual(blobDiffSizeLimitArgs(), ["-c", `core.bigFileThreshold=${LINE_STATS_MAX_FILE_BYTES}`]);
  assert.deepEqual(largeFileExcludePathspecs([]), []);
  assert.deepEqual(largeFileExcludePathspecs(["a/big [1].bin"]), ["--", ".", ":(exclude,literal)a/big [1].bin"]);

  assert.equal(diffPreviewLimitBytes(undefined), 50 * MB);
  assert.equal(diffPreviewLimitBytes(20), 20 * MB);
  assert.equal(diffPreviewLimitBytes(0), DIFF_PREVIEW_HARD_MAX_BYTES);
  assert.equal(diffPreviewLimitBytes(4096), DIFF_PREVIEW_HARD_MAX_BYTES);
  assert.equal(diffPreviewLimitBytes(Number.NaN), 50 * MB);
});

test("numstat 파서는 '-' 항목을 binary 로 표시하고 라인 수는 호환을 위해 0 으로 둔다", () => {
  const counts = parseNumstat("-\t-\tbig.log\0" + "3\t1\tsmall.ts\0");
  assert.deepEqual(counts.get("big.log"), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(counts.get("small.ts"), { additions: 3, deletions: 1 });
});

test("라인 통계는 대용량 파일 내용을 diff 하지 않고 +/- 를 비우되 작은 파일 통계는 유지한다", async () => {
  const root = await createRepo();
  try {
    const bigName = IS_WINDOWS ? "logs/big-1.log" : "logs/big*[1].log";
    await put(root, "small.txt", "one\n");
    await put(root, "staged-small.txt", "one\n");
    await put(root, bigName, largeText("base"));
    await put(root, "staged-big.log", largeText("base"));
    await runGit(["add", "-A"], root);
    await runGit(["commit", "--quiet", "-m", "base"], root);

    await put(root, "small.txt", "one\ntwo\n");
    await put(root, bigName, largeText("working"));
    await put(root, "staged-small.txt", "one\ntwo\nthree\n");
    await put(root, "staged-big.log", largeText("staged"));
    await runGit(["add", "--", "staged-small.txt", "staged-big.log"], root);

    const groups: StatusGroups = {
      staged: [
        { status: "M", path: "staged-big.log" },
        { status: "M", path: "staged-small.txt" },
      ],
      unstaged: [
        { status: "M", path: bigName },
        { status: "M", path: "small.txt" },
      ],
    };
    const commands: string[][] = [];
    const result = await attachStatusStats(root, groups, recordingRun(root, commands));

    const staged = commands.find((args) => args.includes("--cached"));
    const unstaged = commands.find((args) => args.includes("diff") && !args.includes("--cached"));
    assert.deepEqual(staged?.slice(0, 2), blobDiffSizeLimitArgs());
    assert.ok(unstaged?.includes(`:(exclude,literal)${bigName}`), "작업트리 대용량 파일은 pathspec 으로 제외한다");

    const byPath = new Map([...result.staged, ...result.unstaged].map((item) => [item.path, item]));
    assert.equal(byPath.get("staged-big.log")?.additions, undefined);
    assert.equal(byPath.get(bigName)?.additions, undefined);
    assert.deepEqual(
      [byPath.get("staged-small.txt")?.additions, byPath.get("staged-small.txt")?.deletions],
      [2, 0]
    );
    assert.deepEqual([byPath.get("small.txt")?.additions, byPath.get("small.txt")?.deletions], [1, 0]);

    // 기본 status 조회(includeStats)도 같은 규칙으로 대용량 파일 통계를 비운다.
    const status = await new GitService(root).getStatusGroups({ force: true });
    assert.equal(status.unstaged.find((item) => item.path === bigName)?.additions, undefined);
    assert.equal(status.unstaged.find((item) => item.path === "small.txt")?.additions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("대용량 작업트리 파일이 제외 한도보다 많으면 추적 파일 numstat 자체를 생략한다", async () => {
  const root = await createRepo();
  try {
    const files = Array.from({ length: MAX_LARGE_FILE_EXCLUDES + 1 }, (_, index) => `big/${index}.bin`);
    for (const file of files) {
      await put(root, file, "small\n");
    }
    await runGit(["add", "-A"], root);
    await runGit(["commit", "--quiet", "-m", "base"], root);
    // sparse 파일로 크기만 키워 디스크를 쓰지 않고 대용량 파일 수를 재현한다.
    for (const file of files) {
      await truncate(path.join(root, file), LINE_STATS_MAX_FILE_BYTES + 1);
    }
    const commands: string[][] = [];
    const result = await attachStatusStats(
      root,
      { staged: [], unstaged: files.map((file) => ({ status: "M" as const, path: file })) },
      recordingRun(root, commands)
    );
    assert.deepEqual(commands, []);
    assert.ok(result.unstaged.every((item) => item.additions === undefined && item.deletions === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff 미리보기 크기 상한은 대용량 버전을 끝까지 읽지 않고 FileTooLargeError 로 멈춘다", async () => {
  const root = await createRepo();
  try {
    await put(root, "big.log", largeText("base"));
    await put(root, "small.txt", "one\n");
    await runGit(["add", "-A"], root);
    await runGit(["commit", "--quiet", "-m", "base"], root);
    await put(root, "small.txt", "one\ntwo\n");
    const service = new GitService(root);

    await assert.rejects(service.getFileContentAtRef("HEAD", "big.log", { maxBytes: MB }), FileTooLargeError);
    await assert.rejects(service.getWorkingContentWithoutStaged("big.log", { maxBytes: MB }), (error: unknown) => {
      assert.ok(error instanceof FileTooLargeError);
      assert.ok((error.sizeBytes ?? 0) > MB);
      return true;
    });
    assert.equal(await service.getFileContentAtRef("HEAD", "small.txt", { maxBytes: MB }), "one\n");
    assert.equal(await service.getWorkingContentWithoutStaged("small.txt", { maxBytes: MB }), "one\ntwo\n");
    // 상한이 없으면 기존처럼 전체 내용을 읽는다.
    assert.equal((await service.getFileContentAtRef("HEAD", "big.log")).length, largeText("base").length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI 커밋 메시지 문맥은 대용량 staged 파일을 binary 한 줄로 요약해 patch 가 커지지 않는다", async () => {
  const root = await createRepo();
  try {
    await put(root, "big.log", largeText("base"));
    await runGit(["add", "-A"], root);
    await runGit(["commit", "--quiet", "-m", "base"], root);
    await put(root, "big.log", largeText("changed"));
    await put(root, "small.txt", "hello\n");
    await runGit(["add", "-A"], root);

    const context = await readCommitMessageContext(root);
    assert.match(context.diff, /Binary files a\/big\.log and b\/big\.log differ/);
    assert.match(context.diff, /\+hello/);
    assert.ok(context.diff.length < 10_000);
    assert.deepEqual(context.files.map((file) => file.path).sort(), ["big.log", "small.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("가상 문서 제공자는 한도를 넘는 버전을 가짜 내용 대신 오류로 거부한다(작업트리가 작아져도)", async (t) => {
  useDiffMaxFileSize(t, 1);
  const root = await createRepo();
  try {
    await put(root, "big.log", largeText("base"));
    await put(root, "small.txt", "one\n");
    await runGit(["add", "-A"], root);
    await runGit(["commit", "--quiet", "-m", "base"], root);
    // 작업트리 파일은 작아졌지만 HEAD/index 버전은 한도를 넘는다. 안내문을 내용으로 돌려주면
    // 실제 파일과 짝지은 diff 에서 되돌리기가 안내문을 파일에 써 넣을 수 있다.
    await put(root, "big.log", "tiny\n");
    const service = new GitService(root);
    const provider = new BranchContentProvider({ get: () => service } as any);

    for (const ref of ["HEAD", ":0", ":unstaged"]) {
      await assert.rejects(
        provider.provideTextDocumentContent(makeRefUri(ref, "big.log", root) as any),
        (error: unknown) => {
          assert.ok(isLargeFilePreviewError(error), `${ref} 는 크기 초과 오류로 거부해야 한다`);
          assert.match((error as Error).message, /big\.log: This file is larger than 1\.0 MB/);
          return true;
        }
      );
    }
    assert.equal(await provider.provideTextDocumentContent(makeRefUri("HEAD", "small.txt", root) as any), "one\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("작업트리 파일이 diff 한도를 넘으면 diff 대신 파일 열기를 안내한다", async (t) => {
  useDiffMaxFileSize(t, 1);
  const workspace = vscodeMock.workspace as any;
  const sizes = new Map([["/repo/big.bin", 2 * MB], ["/repo/small.txt", 10]]);
  workspace.fs = { stat: async (uri: { fsPath: string }) => {
    const size = sizes.get(uri.fsPath.replace(/\\/g, "/"));
    if (size === undefined) throw new Error("missing");
    return { size };
  } };
  t.after(() => {
    delete workspace.fs;
    vscodeMock.__resetWindowMessages();
  });
  vscodeMock.__resetWindowMessages();
  vscodeMock.__setInformationMessageResult("Open File");

  assert.equal(await divertLargeWorkingFileDiff("/repo", "small.txt"), false);
  assert.equal(await divertLargeWorkingFileDiff("/repo", "missing.txt"), false);
  assert.equal(await divertLargeWorkingFileDiff("/repo", "big.bin"), true);
  assert.deepEqual(vscodeMock.__informationMessages, ["'big.bin' is too large to compare (2.0 MB, limit 1.0 MB)."]);
  const opened = vscodeMock.__executedCommands.find((command) => command.id === "vscode.open");
  assert.equal((opened?.args[0] as { fsPath: string }).fsPath.replace(/\\/g, "/"), "/repo/big.bin");
});
