import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { RebaseService } from "../src/git/rebaseService";
import { graphRebaseTodoProgressMessage } from "../src/webview/graphRebaseTodoProgress";

const execFileAsync = promisify(execFile);
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/** 실패할 수 있는 테스트 Git 명령의 종료 결과다. */
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 테스트용 선형 커밋 두 개와 그 기준 commit이다. */
interface RebaseHistory {
  base: string;
  first: string;
  second: string;
}

/**
 * 임시 저장소에서 Git을 셸 없이 실행한다.
 * @param repoRoot 명령을 실행할 테스트 저장소
 * @param args Git 하위 명령과 인자
 * @returns UTF-8 stdout 문자열
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.stdout;
}

/**
 * merge/rebase처럼 실패 종료가 정상인 Git 명령을 실행한다.
 * @param repoRoot 명령을 실행할 테스트 저장소
 * @param args Git 하위 명령과 인자
 * @returns 성공 여부와 stdout/stderr
 */
async function gitResult(repoRoot: string, args: string[]): Promise<GitResult> {
  try {
    return { ok: true, stdout: await git(repoRoot, args), stderr: "" };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: failure.stdout || "",
      stderr: failure.stderr || failure.message,
    };
  }
}

/**
 * 전역 Git 설정과 분리된 최소 저장소를 만든다.
 * @returns 테스트가 자유롭게 브랜치와 충돌을 만들 저장소 경로
 */
async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "gsc-conflict-context-"));
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["config", "user.name", "Conflict Context Test"]);
  await git(repoRoot, ["config", "user.email", "conflict-context@example.com"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  return repoRoot;
}

/**
 * 임시 저장소에서 테스트를 실행하고 작업 상태와 무관하게 정리한다.
 * @param run 생성된 저장소를 받는 테스트 본문
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
 * 파일을 UTF-8로 쓰고 index에 추가한다.
 * @param repoRoot 테스트 저장소
 * @param rel 저장소 상대 경로
 * @param content 기록할 텍스트
 */
async function stageText(
  repoRoot: string,
  rel: string,
  content: string
): Promise<void> {
  await writeFile(path.join(repoRoot, rel), content, "utf8");
  await git(repoRoot, ["add", "--", rel]);
}

/**
 * 파일을 원본 바이트로 쓰고 index에 추가한다.
 * @param repoRoot 테스트 저장소
 * @param rel 저장소 상대 경로
 * @param content 기록할 바이너리 데이터
 */
async function stageBinary(
  repoRoot: string,
  rel: string,
  content: Buffer
): Promise<void> {
  await writeFile(path.join(repoRoot, rel), content);
  await git(repoRoot, ["add", "--", rel]);
}

/**
 * 현재 index를 고정된 제목의 커밋으로 만든다.
 * @param repoRoot 테스트 저장소
 * @param subject commit subject
 * @returns 새 commit의 전체 hash
 */
async function commit(repoRoot: string, subject: string): Promise<string> {
  await git(repoRoot, ["commit", "-q", "-m", subject]);
  return (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
}

/**
 * rebase 순서 변경 충돌에 사용할 base → first → second 이력을 만든다.
 * - 각 커밋이 같은 한 줄을 바꾸므로 second를 먼저 재적용하면 의도적으로 충돌한다.
 * @param repoRoot 테스트 저장소
 * @returns 세 커밋의 전체 hash
 */
async function createRebaseHistory(repoRoot: string): Promise<RebaseHistory> {
  await stageText(repoRoot, "choice.txt", "value=base\n");
  const base = await commit(repoRoot, "base version");
  await stageText(repoRoot, "choice.txt", "value=first\n");
  const first = await commit(repoRoot, "first version");
  await stageText(repoRoot, "choice.txt", "value=second\n");
  const second = await commit(repoRoot, "second version");
  return { base, first, second };
}

/**
 * 현재 기본 브랜치 이름을 반환한다.
 * @param repoRoot 테스트 저장소
 */
async function currentBranch(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ["branch", "--show-current"])).trim();
}

test("rebase -i 충돌은 commit 출처, 이후 영향, 현재 edit 불확실성을 설명한다", async () => {
  await withRepo(async (repoRoot) => {
    const history = await createRebaseHistory(repoRoot);
    const branch = await currentBranch(repoRoot);
    const rebase = new RebaseService(repoRoot);
    const result = await rebase.start(
      history.base,
      false,
      [
        { hash: history.second, action: "pick" },
        { hash: history.first, action: "pick" },
      ],
      path.resolve(process.cwd(), "media", "rebase", "rebaseEditor.js")
    );
    assert.equal(result.status, "conflicts");

    const conflicts = new ConflictService(repoRoot);
    try {
      const document = await conflicts.getConflictDocument("choice.txt");
      assert.equal(document.operation, "rebase");
      assert.equal(document.base.content, "value=first\n");
      assert.equal(document.current.content, "value=base\n");
      assert.equal(document.incoming.content, "value=second\n");
      assert.equal(document.current.commit, history.base);
      assert.equal(document.current.subject, "base version");
      assert.equal(document.current.fileCommit, history.base);
      assert.equal(document.incoming.commit, history.second);
      assert.equal(document.incoming.subject, "second version");

      const context = document.context.rebase;
      assert.ok(context);
      assert.equal(context.branch, branch);
      assert.equal(context.originalHead?.commit, history.second);
      assert.equal(context.onto?.commit, history.base);
      assert.equal(context.currentStep?.commit, history.second);
      assert.equal(context.currentStep?.subject, "second version");
      assert.equal(context.currentStep?.index, 1);
      assert.equal(context.currentStep?.total, 2);
      assert.equal(context.remainingSteps, 1);
      assert.equal(context.futurePathChangeCount, 1);
      assert.equal(context.futurePathChanges[0]?.commit, history.first);
      assert.equal(context.futurePathChanges[0]?.subject, "first version");
      assert.equal(context.fileOutcome, "changed-later");

      const todoPath = (await git(repoRoot, ["rev-parse", "--git-path", "rebase-merge/git-rebase-todo"])).trim();
      await writeFile(path.resolve(repoRoot, todoPath), `fixup -C ${history.first}\n`, "utf8");
      const fixupDocument = await conflicts.getConflictDocument("choice.txt");
      assert.equal(fixupDocument.context.rebase?.remainingSteps, 1);
      assert.equal(fixupDocument.context.rebase?.futurePathChangeCount, 1);
      assert.equal(fixupDocument.context.rebase?.fileOutcome, "changed-later");
      await writeFile(path.resolve(repoRoot, todoPath), "", "utf8");
      await writeFile(path.resolve(repoRoot, todoPath.replace("git-rebase-todo", "done")), `edit ${history.second}\n`, "utf8");
      const editDocument = await conflicts.getConflictDocument("choice.txt");
      assert.equal(editDocument.context.rebase?.currentStep?.action, "edit");
      assert.equal(editDocument.context.rebase?.fileOutcome, "uncertain");
    } finally {
      if (await conflicts.getOperation() === "rebase") {
        await conflicts.abortOperation("rebase");
      }
    }
  });
});

test("modify/delete 충돌에서 absent side 선택은 파일 삭제를 정확히 stage한다", async () => {
  await withRepo(async (repoRoot) => {
    await stageText(repoRoot, "deleted.txt", "base\n");
    await commit(repoRoot, "base file");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["branch", "delete-side"]);

    await git(repoRoot, ["checkout", "-q", "delete-side"]);
    await rm(path.join(repoRoot, "deleted.txt"));
    await git(repoRoot, ["add", "-A", "--", "deleted.txt"]);
    await commit(repoRoot, "delete file");

    await git(repoRoot, ["checkout", "-q", main]);
    await stageText(repoRoot, "deleted.txt", "modified on current\n");
    await commit(repoRoot, "modify file");
    const merge = await gitResult(repoRoot, ["merge", "delete-side"]);
    assert.equal(merge.ok, false, merge.stderr);

    const conflicts = new ConflictService(repoRoot);
    const document = await conflicts.getConflictDocument("deleted.txt");
    assert.equal(document.operation, "merge");
    assert.equal(document.base.content, "base\n");
    assert.equal(document.current.content, "modified on current\n");
    assert.equal(document.incoming.exists, false);
    assert.equal(document.incoming.kind, "absent");

    await conflicts.acceptIncoming("deleted.txt");
    assert.deepEqual(await conflicts.listConflicts(), []);
    await assert.rejects(readFile(path.join(repoRoot, "deleted.txt")));
    assert.equal((await git(repoRoot, ["ls-files", "--", "deleted.txt"])).trim(), "");
    await assert.rejects(
      conflicts.acceptIncoming("deleted.txt"),
      /no longer conflicted/
    );
    await assert.rejects(readFile(path.join(repoRoot, "deleted.txt")));
  });
});

test("pathspec magic 파일명 해결은 다른 충돌 파일을 함께 선택하지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    const magic = ":(glob)*.txt";
    const other = "other.txt";
    const stageLiteral = async (rel: string, content: string): Promise<void> => {
      await writeFile(path.join(repoRoot, rel), content, "utf8");
      await git(repoRoot, ["--literal-pathspecs", "add", "--", rel]);
    };
    await stageLiteral(magic, "magic base\n");
    await stageLiteral(other, "other base\n");
    await commit(repoRoot, "literal base");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["branch", "literal-side"]);

    await git(repoRoot, ["checkout", "-q", "literal-side"]);
    await stageLiteral(magic, "magic incoming\n");
    await stageLiteral(other, "other incoming\n");
    await commit(repoRoot, "literal incoming");
    await git(repoRoot, ["checkout", "-q", main]);
    await stageLiteral(magic, "magic current\n");
    await stageLiteral(other, "other current\n");
    await commit(repoRoot, "literal current");
    const merge = await gitResult(repoRoot, ["merge", "literal-side"]);
    assert.equal(merge.ok, false, merge.stderr);
    const otherBefore = await readFile(path.join(repoRoot, other), "utf8");

    const conflicts = new ConflictService(repoRoot);
    const document = await conflicts.getConflictDocument(magic);
    assert.equal(document.current.content, "magic current\n");
    assert.equal(document.incoming.content, "magic incoming\n");
    await conflicts.acceptIncoming(magic);
    assert.equal(await readFile(path.join(repoRoot, magic), "utf8"), "magic incoming\n");
    assert.deepEqual(await conflicts.listConflicts(), [other]);
    await assert.rejects(conflicts.acceptIncoming("."), /no longer conflicted/);
    assert.equal(await readFile(path.join(repoRoot, other), "utf8"), otherBefore);
  });
});

test("binary 충돌은 text로 합치지 않고 exact stage 선택만 안전하게 적용한다", async () => {
  await withRepo(async (repoRoot) => {
    const rel = "asset.bin";
    await stageBinary(repoRoot, rel, Buffer.from([0, 1, 2, 3]));
    await commit(repoRoot, "base binary");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["branch", "binary-side"]);

    await git(repoRoot, ["checkout", "-q", "binary-side"]);
    await stageBinary(repoRoot, rel, Buffer.from([0, 7, 8, 9]));
    await commit(repoRoot, "incoming binary");
    await git(repoRoot, ["checkout", "-q", main]);
    const currentBytes = Buffer.from([0, 4, 5, 6]);
    await stageBinary(repoRoot, rel, currentBytes);
    await commit(repoRoot, "current binary");
    const merge = await gitResult(repoRoot, ["merge", "binary-side"]);
    assert.equal(merge.ok, false, merge.stderr);

    const conflicts = new ConflictService(repoRoot);
    const document = await conflicts.getConflictDocument(rel);
    assert.equal(document.current.kind, "binary");
    assert.equal(document.incoming.kind, "binary");
    assert.equal(document.resultState.kind, "binary");
    const worktreeBefore = await readFile(path.join(repoRoot, rel));
    const unmergedBefore = await git(repoRoot, ["ls-files", "--unmerged", "-z", "--", rel]);
    await assert.rejects(
      conflicts.acceptBoth(rel),
      /requires two text conflict sides/
    );
    assert.deepEqual(await readFile(path.join(repoRoot, rel)), worktreeBefore);
    assert.equal(
      await git(repoRoot, ["ls-files", "--unmerged", "-z", "--", rel]),
      unmergedBefore
    );
    assert.deepEqual(await conflicts.listConflicts(), [rel]);

    await conflicts.acceptCurrent(rel);
    assert.deepEqual(await conflicts.listConflicts(), []);
    assert.deepEqual(await readFile(path.join(repoRoot, rel)), currentBytes);
  });
});

test("큰 text의 Accept Both는 표시 한도를 실제 해결 내용에 적용하지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    const rel = "large.txt";
    const prefix = `${"shared".repeat(90_000)}\n`;
    await stageText(repoRoot, rel, `${prefix}value=base\n`);
    await commit(repoRoot, "base large text");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["branch", "large-side"]);

    await git(repoRoot, ["checkout", "-q", "large-side"]);
    await stageText(repoRoot, rel, `${prefix}value=incoming\n`);
    await commit(repoRoot, "incoming large text");
    await git(repoRoot, ["checkout", "-q", main]);
    await stageText(repoRoot, rel, `${prefix}value=current\n`);
    await commit(repoRoot, "current large text");
    const merge = await gitResult(repoRoot, ["merge", "large-side"]);
    assert.equal(merge.ok, false, merge.stderr);

    const conflicts = new ConflictService(repoRoot);
    const document = await conflicts.getConflictDocument(rel);
    assert.equal(document.current.kind, "text");
    assert.equal(document.current.truncated, true);
    assert.equal(document.incoming.truncated, true);
    assert.equal(document.bothAvailable, false);

    await conflicts.acceptBoth(rel);
    const resolved = await readFile(path.join(repoRoot, rel), "utf8");
    assert.equal(resolved, `${prefix}value=current\nvalue=incoming\n`);
    assert.deepEqual(await conflicts.listConflicts(), []);
  });
});

test("저장소 내부 중간 symlink를 통한 manual Result 쓰기를 거부한다", async (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink 권한에 의존하지 않도록 건너뜁니다.");
  await withRepo(async (repoRoot) => {
    const rel = "nested/conflict.txt";
    await mkdir(path.join(repoRoot, "nested"));
    await stageText(repoRoot, rel, "base\n");
    await stageText(repoRoot, "conflict.txt", "sentinel\n");
    await commit(repoRoot, "internal symlink base");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["checkout", "-q", "-b", "internal-link-side"]);
    await stageText(repoRoot, rel, "incoming\n");
    await commit(repoRoot, "internal symlink incoming");
    await git(repoRoot, ["checkout", "-q", main]);
    await stageText(repoRoot, rel, "current\n");
    await commit(repoRoot, "internal symlink current");
    assert.equal((await gitResult(repoRoot, ["merge", "internal-link-side"])).ok, false);
    await rm(path.join(repoRoot, "nested"), { recursive: true, force: true });
    await symlink(".", path.join(repoRoot, "nested"), "dir");
    const conflicts = new ConflictService(repoRoot);
    await assert.rejects(conflicts.writeResolvedContent(rel, "overwrite\n"), /symlink|path/i);
    assert.equal(await readFile(path.join(repoRoot, "conflict.txt"), "utf8"), "sentinel\n");
  });
});
test("symlink 충돌은 링크 대상을 읽지 않고 manual Result 쓰기를 거부한다", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink 권한에 의존하지 않도록 건너뜁니다.");
    return;
  }
  await withRepo(async (repoRoot) => {
    const rel = "linked.txt";
    const suffix = path.basename(repoRoot);
    const baseTarget = path.join(tmpdir(), `${suffix}-base-target.txt`);
    const currentTarget = path.join(tmpdir(), `${suffix}-current-target.txt`);
    const incomingTarget = path.join(tmpdir(), `${suffix}-incoming-target.txt`);
    await Promise.all([
      writeFile(baseTarget, "BASE SECRET", "utf8"),
      writeFile(currentTarget, "CURRENT SECRET", "utf8"),
      writeFile(incomingTarget, "INCOMING SECRET", "utf8"),
    ]);
    try {
      await symlink(baseTarget, path.join(repoRoot, rel));
      await git(repoRoot, ["add", "--", rel]);
      await commit(repoRoot, "base symlink");
      const main = await currentBranch(repoRoot);
      await git(repoRoot, ["branch", "symlink-side"]);

      await git(repoRoot, ["checkout", "-q", "symlink-side"]);
      await unlink(path.join(repoRoot, rel));
      await symlink(incomingTarget, path.join(repoRoot, rel));
      await git(repoRoot, ["add", "--", rel]);
      await commit(repoRoot, "incoming symlink");
      await git(repoRoot, ["checkout", "-q", main]);
      await unlink(path.join(repoRoot, rel));
      await symlink(currentTarget, path.join(repoRoot, rel));
      await git(repoRoot, ["add", "--", rel]);
      await commit(repoRoot, "current symlink");
      const merge = await gitResult(repoRoot, ["merge", "symlink-side"]);
      assert.equal(merge.ok, false, merge.stderr);

      const conflicts = new ConflictService(repoRoot);
      const document = await conflicts.getConflictDocument(rel);
      assert.equal(document.current.kind, "symlink");
      assert.equal(document.current.content, currentTarget);
      assert.equal(document.incoming.kind, "symlink");
      assert.equal(document.incoming.content, incomingTarget);
      assert.equal(document.resultState.kind, "symlink");
      assert.equal(document.result.includes("SECRET"), false);
      await assert.rejects(
        conflicts.writeResolvedContent(rel, "must not escape", false),
        /not available for symlink/
      );

      await conflicts.acceptIncoming(rel);
      assert.equal((await lstat(path.join(repoRoot, rel))).isSymbolicLink(), true);
      assert.equal(await readlink(path.join(repoRoot, rel)), incomingTarget);
      assert.deepEqual(await conflicts.listConflicts(), []);
    } finally {
      await Promise.all([
        rm(baseTarget, { force: true }),
        rm(currentTarget, { force: true }),
        rm(incomingTarget, { force: true }),
      ]);
    }
  });
});

test("submodule conflict 선택은 worktree HEAD 대신 선택 stage OID를 index에 기록한다", async () => {
  await withRepo(async (repoRoot) => {
    await stageText(repoRoot, "object.txt", "base object\n");
    const baseObject = await commit(repoRoot, "base object commit");
    await git(repoRoot, ["branch", "incoming-object", baseObject]);
    await stageText(repoRoot, "object.txt", "current object\n");
    const currentObject = await commit(repoRoot, "current object commit");
    await git(repoRoot, ["checkout", "-q", "incoming-object"]);
    await stageText(repoRoot, "object.txt", "incoming object\n");
    const incomingObject = await commit(repoRoot, "incoming object commit");

    await git(repoRoot, ["checkout", "--orphan", "super-main"]);
    await git(repoRoot, ["rm", "-q", "-rf", "."]);
    await git(repoRoot, ["update-index", "--add", "--cacheinfo", "160000", baseObject, "module"]);
    await commit(repoRoot, "base gitlink");
    await git(repoRoot, ["branch", "gitlink-side"]);
    await git(repoRoot, ["checkout", "-q", "gitlink-side"]);
    await git(repoRoot, ["update-index", "--add", "--cacheinfo", "160000", incomingObject, "module"]);
    await commit(repoRoot, "incoming gitlink");
    await git(repoRoot, ["checkout", "-q", "super-main"]);
    await git(repoRoot, ["update-index", "--add", "--cacheinfo", "160000", currentObject, "module"]);
    await commit(repoRoot, "current gitlink");
    const merge = await gitResult(repoRoot, ["merge", "gitlink-side"]);
    assert.equal(merge.ok, false, merge.stderr);

    const conflicts = new ConflictService(repoRoot);
    const document = await conflicts.getConflictDocument("module");
    assert.equal(document.current.kind, "submodule");
    assert.equal(document.current.oid, currentObject);
    assert.equal(document.incoming.kind, "submodule");
    assert.equal(document.incoming.oid, incomingObject);

    await conflicts.acceptIncoming("module");
    const staged = await git(repoRoot, ["ls-files", "--stage", "--", "module"]);
    assert.match(staged, new RegExp(`^160000 ${incomingObject} 0\\tmodule`));
    assert.deepEqual(await conflicts.listConflicts(), []);
  });
});

test("rebase-apply backend는 남은 patch를 모를 때 최종 Result를 단정하지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    await stageText(repoRoot, "apply.txt", "value=base\n");
    await commit(repoRoot, "apply base");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["checkout", "-q", "-b", "apply-feature"]);
    await stageText(repoRoot, "apply.txt", "value=first\n");
    await commit(repoRoot, "apply first");
    await stageText(repoRoot, "apply.txt", "value=second\n");
    await commit(repoRoot, "apply second");
    await git(repoRoot, ["checkout", "-q", main]);
    await stageText(repoRoot, "apply.txt", "value=onto\n");
    await commit(repoRoot, "apply onto");
    await git(repoRoot, ["checkout", "-q", "apply-feature"]);
    const rebase = await gitResult(repoRoot, ["rebase", "--apply", main]);
    assert.equal(rebase.ok, false, rebase.stderr);

    const conflicts = new ConflictService(repoRoot);
    try {
      const document = await conflicts.getConflictDocument("apply.txt");
      assert.equal(document.operation, "rebase");
      assert.ok(document.context.rebase);
      assert.equal(document.context.rebase.futurePathAnalysisComplete, false);
      assert.equal(document.context.rebase.fileOutcome, "uncertain");
    } finally {
      if (await conflicts.getOperation() === "rebase") {
        await conflicts.abortOperation("rebase");
      }
    }
  });
});

test("onto-side rename으로 경로가 매핑된 rebase는 future 분석을 확정하지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    await stageText(repoRoot, "old.ts", "value=base\n");
    await commit(repoRoot, "rename base");
    const main = await currentBranch(repoRoot);
    await git(repoRoot, ["checkout", "-q", "-b", "rename-feature"]);
    await stageText(repoRoot, "old.ts", "value=first\n");
    await commit(repoRoot, "rename feature first");
    await stageText(repoRoot, "old.ts", "value=second\n");
    await commit(repoRoot, "rename feature second");

    await git(repoRoot, ["checkout", "-q", main]);
    await git(repoRoot, ["mv", "old.ts", "new.ts"]);
    await stageText(repoRoot, "new.ts", "value=onto\n");
    await commit(repoRoot, "rename onto new path");
    await git(repoRoot, ["checkout", "-q", "rename-feature"]);
    const rebase = await gitResult(repoRoot, ["rebase", main]);
    assert.equal(rebase.ok, false, rebase.stderr);

    const conflicts = new ConflictService(repoRoot);
    try {
      const paths = await conflicts.listConflicts();
      assert.equal(paths.length, 1);
      const document = await conflicts.getConflictDocument(paths[0]);
      assert.equal(document.operation, "rebase");
      assert.notEqual(document.context.rebase?.fileOutcome, "expected-final");
      if (paths[0] === "new.ts") {
        assert.equal(document.context.rebase?.futurePathAnalysisComplete, false);
        assert.equal(document.context.rebase?.fileOutcome, "uncertain");
      } else {
        assert.equal(document.context.rebase?.futurePathChangeCount, 1);
        assert.equal(document.context.rebase?.fileOutcome, "changed-later");
      }
    } finally {
      if (await conflicts.getOperation() === "rebase") {
        await conflicts.abortOperation("rebase");
      }
    }
  });
});

test("그래프 충돌 안내도 rebase Current와 Incoming 의미를 뒤바꾸지 않는다", () => {
  const message = graphRebaseTodoProgressMessage({
    action: "run",
    phase: "conflicts",
    title: "Rebase conflict",
    detail: "Resolve the current todo",
    progress: {
      done: 1,
      total: 2,
      currentHash: "2222222",
      items: [],
      omittedItemCount: 0,
    },
    active: true,
  });
  assert.equal(message.type, "graphRebaseProgress");
  if (message.type !== "graphRebaseProgress") {
    return;
  }
  const guidance = message.progress.guidance || [];
  assert.ok(guidance.some((line) => line.includes("Current / Ours is the new base")));
  assert.ok(guidance.some((line) => line.includes("Incoming / Theirs is stage 3")));
  assert.equal(guidance.some((line) => line.includes("Current is the commit Git is applying")), false);
});
