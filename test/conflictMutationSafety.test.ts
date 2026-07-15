import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ConflictService } from "../src/git/conflictService";
import { runGitBuffer, runGitWithInput } from "../src/git/gitExec";
import {
  isConflictMutationActive,
  runConflictMutation,
  tryAcquireConflictMutation,
} from "../src/git/conflictMutationCoordinator";
import {
  claimConflictWorkingLeaf,
  readConflictWorkingLeaf,
} from "../src/git/conflictWorktreeCas";

const execFileAsync = promisify(execFile);

/**
 * 테스트 저장소에서 Git 명령을 실행하고 stdout을 반환한다.
 * @param repoRoot 임시 저장소 루트
 * @param args git 하위 명령 인자
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conflict Safety Test",
      GIT_AUTHOR_EMAIL: "conflict-safety@example.com",
      GIT_COMMITTER_NAME: "Conflict Safety Test",
      GIT_COMMITTER_EMAIL: "conflict-safety@example.com",
    },
  });
  return result.stdout;
}

/** 실패가 예상되는 Git 명령을 실행해 성공 여부만 반환한다. */
async function gitSucceeds(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    await git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * 격리된 임시 Git 저장소를 만들고 테스트 뒤 항상 제거한다.
 * @param run 초기화된 저장소를 사용하는 테스트 본문
 */
async function withRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-mutation-"));
  try {
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["config", "user.name", "Conflict Safety Test"]);
    await git(repoRoot, ["config", "user.email", "conflict-safety@example.com"]);
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

/** 파일을 쓰고 index에 추가해 다음 commit의 내용을 준비한다. */
async function stageText(repoRoot: string, rel: string, content: string): Promise<void> {
  await writeFile(path.join(repoRoot, rel), content, "utf8");
  await git(repoRoot, ["add", "--", rel]);
}

/** 실행 가능한 일반 파일 내용을 쓰고 100755 mode로 다음 commit에 stage한다. */
async function stageExecutableText(
  repoRoot: string,
  rel: string,
  content: string
): Promise<void> {
  const absolute = path.join(repoRoot, rel);
  await writeFile(absolute, content, "utf8");
  await chmod(absolute, 0o755);
  await git(repoRoot, ["add", "--", rel]);
}

/** 해결된 stage 0 일반 파일의 Git mode를 `ls-files --stage`에서 읽는다. */
async function resolvedIndexMode(repoRoot: string, rel: string): Promise<string> {
  const output = await git(repoRoot, ["ls-files", "--stage", "--", rel]);
  const match = /^(\d+) [0-9a-f]+ 0\t/.exec(output);
  assert.ok(match, `Expected one resolved stage-0 entry for ${rel}`);
  return match[1];
}

/** 기존 leaf를 raw-byte target의 symlink로 바꾸고 다음 commit을 위해 stage한다. */
async function stageSymlink(
  repoRoot: string,
  rel: string,
  target: Buffer
): Promise<void> {
  const absolute = path.join(repoRoot, rel);
  await rm(absolute, { force: true });
  await symlink(target, absolute);
  await git(repoRoot, ["add", "--", rel]);
}

/** 현재 index를 지정 메시지로 commit한다. */
async function commit(repoRoot: string, message: string): Promise<void> {
  await git(repoRoot, ["commit", "-q", "-m", message]);
}

/**
 * 한 text 파일에 Current/Incoming 양쪽 변경이 있는 merge conflict를 만든다.
 * @returns 충돌 경로와 기본 브랜치 이름
 */
async function createTextConflict(
  repoRoot: string
): Promise<{ rel: string; main: string }> {
  const rel = "choice.txt";
  await stageText(repoRoot, rel, "base\n");
  await commit(repoRoot, "base");
  const main = (await git(repoRoot, ["branch", "--show-current"])).trim();
  await git(repoRoot, ["checkout", "-q", "-b", "incoming-side"]);
  await stageText(repoRoot, rel, "incoming\n");
  await commit(repoRoot, "incoming");
  await git(repoRoot, ["checkout", "-q", main]);
  await stageText(repoRoot, rel, "current\n");
  await commit(repoRoot, "current");
  assert.equal(await gitSucceeds(repoRoot, ["merge", "incoming-side"]), false);
  return { rel, main };
}

/** Current/Incoming이 서로 다른 비 UTF-8 symlink target을 가진 충돌을 만든다. */
async function createRawSymlinkConflict(repoRoot: string): Promise<string> {
  const rel = "choice-link";
  await stageSymlink(repoRoot, rel, Buffer.from("base"));
  await commit(repoRoot, "base symlink");
  const main = (await git(repoRoot, ["branch", "--show-current"])).trim();
  await git(repoRoot, ["checkout", "-q", "-b", "incoming-symlink"]);
  await stageSymlink(repoRoot, rel, Buffer.from([0x69, 0xff]));
  await commit(repoRoot, "incoming symlink");
  await git(repoRoot, ["checkout", "-q", main]);
  await stageSymlink(repoRoot, rel, Buffer.from([0x63, 0xfe]));
  await commit(repoRoot, "current symlink");
  assert.equal(await gitSucceeds(repoRoot, ["merge", "incoming-symlink"]), false);
  return rel;
}

/** native add와 서비스 mode를 같은 조건에서 비교할 실행 파일 충돌 두 개를 만든다. */
async function createExecutablePairConflict(repoRoot: string): Promise<[string, string]> {
  const rels: [string, string] = ["native-mode.txt", "service-mode.txt"];
  for (const rel of rels) await stageExecutableText(repoRoot, rel, "base\n");
  await commit(repoRoot, "base executable files");
  const main = (await git(repoRoot, ["branch", "--show-current"])).trim();
  await git(repoRoot, ["checkout", "-q", "-b", "incoming-executable"]);
  for (const rel of rels) await stageExecutableText(repoRoot, rel, "incoming\n");
  await commit(repoRoot, "incoming executable files");
  await git(repoRoot, ["checkout", "-q", main]);
  for (const rel of rels) await stageExecutableText(repoRoot, rel, "current\n");
  await commit(repoRoot, "current executable files");
  assert.equal(await gitSucceeds(repoRoot, ["merge", "incoming-executable"]), false);
  return rels;
}

test("외부 Result 변경은 stale panel mutation을 막고 새 version으로만 해결한다", async () => {
  await withRepo(async (repoRoot) => {
    const { rel } = await createTextConflict(repoRoot);
    const service = new ConflictService(repoRoot);
    const document = await service.getConflictDocument(rel);
    await writeFile(path.join(repoRoot, rel), "external edit\n", "utf8");
    const externalVersion = await service.getConflictResultVersion(rel);
    assert.notEqual(externalVersion, document.resultVersion);

    await assert.rejects(
      service.acceptCurrent(rel, undefined, document.resultVersion),
      /changed outside/
    );
    assert.equal(await readFile(path.join(repoRoot, rel), "utf8"), "external edit\n");
    assert.deepEqual(await service.listConflicts(), [rel]);

    await service.acceptCurrent(rel, undefined, externalVersion);
    assert.equal(await readFile(path.join(repoRoot, rel), "utf8"), "current\n");
    assert.deepEqual(await service.listConflicts(), []);
  });
});

test("이전 resolved 문서 저장 경로는 새 unmerged conflict를 덮지 않는다", async () => {
  await withRepo(async (repoRoot) => {
    const { rel } = await createTextConflict(repoRoot);
    const service = new ConflictService(repoRoot);
    const document = await service.getConflictDocument(rel, true);
    await assert.rejects(
      service.writeWorkingContent(rel, "stale resolved editor\n", document.resultVersion),
      /conflicted again/i
    );
    assert.deepEqual(await service.listConflicts(), [rel]);
  });
});
test("표시 뒤 index conflict stage가 바뀌면 stale exact-side 선택을 거부한다", async () => {
  await withRepo(async (repoRoot) => {
    const { rel } = await createTextConflict(repoRoot);
    const service = new ConflictService(repoRoot);
    const document = await service.getConflictDocument(rel);
    const originalResult = await readFile(path.join(repoRoot, rel), "utf8");
    assert.equal(document.current.content, "current\n");

    const unseenOid = (await runGitWithInput(
      ["hash-object", "-w", "--stdin"],
      repoRoot,
      "current-new-unseen\n"
    )).trim();
    await runGitWithInput(
      ["update-index", "--index-info"],
      repoRoot,
      `100644 ${unseenOid} 2\t${rel}\n`
    );

    await assert.rejects(
      service.acceptCurrent(
        rel,
        undefined,
        document.resultVersion,
        document.sourceVersion
      ),
      /changed|stale|reload/i
    );
    assert.equal(await readFile(path.join(repoRoot, rel), "utf8"), originalResult);
    assert.deepEqual(await service.listConflicts(), [rel]);
  });
});

test("같은 stage blob으로 merge를 다시 시작해도 이전 operation action을 거부한다", async () => {
  await withRepo(async (repoRoot) => {
    const { rel } = await createTextConflict(repoRoot);
    const service = new ConflictService(repoRoot);
    const previous = await service.getConflictDocument(rel, true);
    await git(repoRoot, ["merge", "--abort"]);
    assert.equal(await gitSucceeds(repoRoot, ["merge", "incoming-side"]), false);
    const restarted = await service.getConflictDocument(rel, true);

    assert.notEqual(restarted.sourceVersion, previous.sourceVersion);
    await assert.rejects(
      service.acceptCurrent(
        rel,
        undefined,
        restarted.resultVersion,
        previous.sourceVersion
      ),
      /sources changed|reload/i
    );
    assert.deepEqual(await service.listConflicts(), [rel]);
  });
});

test(
  "표시 뒤 Result 실행 비트가 바뀌면 stale manual resolve를 거부한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const { rel } = await createTextConflict(repoRoot);
      const service = new ConflictService(repoRoot);
      const document = await service.getConflictDocument(rel);
      const resultPath = path.join(repoRoot, rel);
      const originalResult = await readFile(resultPath, "utf8");

      await chmod(resultPath, 0o755);
      const executableVersion = await service.getConflictResultVersion(rel);
      assert.notEqual(executableVersion, document.resultVersion);
      await assert.rejects(
        service.writeResolvedContent(
          rel,
          "manual result\n",
          true,
          document.resultVersion,
          document.sourceVersion
        ),
        /changed|stale|reload/i
      );
      assert.equal(await readFile(resultPath, "utf8"), originalResult);
      assert.deepEqual(await service.listConflicts(), [rel]);
    });
  }
);

test(
  "owner execute가 없는 0645 Result는 native Git처럼 100644로 stage한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const { rel } = await createTextConflict(repoRoot);
      const service = new ConflictService(repoRoot);
      await chmod(path.join(repoRoot, rel), 0o645);
      const document = await service.getConflictDocument(rel);

      await service.writeResolvedContent(
        rel,
        "manual result\n",
        true,
        document.resultVersion,
        document.sourceVersion
      );

      assert.equal(await resolvedIndexMode(repoRoot, rel), "100644");
    });
  }
);

test(
  "core.filemode=false에서는 conflict source mode를 native add와 동일하게 보존한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      await git(repoRoot, ["config", "core.filemode", "true"]);
      const [nativeRel, serviceRel] = await createExecutablePairConflict(repoRoot);
      await git(repoRoot, ["config", "core.filemode", "false"]);
      await Promise.all([
        chmod(path.join(repoRoot, nativeRel), 0o644),
        chmod(path.join(repoRoot, serviceRel), 0o644),
      ]);
      const service = new ConflictService(repoRoot);
      const document = await service.getConflictDocument(serviceRel);

      await git(repoRoot, ["add", "--", nativeRel]);
      await service.writeResolvedContent(
        serviceRel,
        "manual result\n",
        true,
        document.resultVersion,
        document.sourceVersion
      );

      const nativeMode = await resolvedIndexMode(repoRoot, nativeRel);
      assert.equal(nativeMode, "100755");
      assert.equal(await resolvedIndexMode(repoRoot, serviceRel), nativeMode);
    });
  }
);

test(
  "비 UTF-8 symlink Result는 해결 뒤에도 원본 target bytes를 stage한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const rel = await createRawSymlinkConflict(repoRoot);
      const service = new ConflictService(repoRoot);
      const document = await service.getConflictDocument(rel);
      const resultPath = path.join(repoRoot, rel);
      const originalTarget = await readlink(resultPath, { encoding: "buffer" });
      assert.deepEqual([...originalTarget], [0x63, 0xfe]);

      await service.markResolved(
        rel,
        document.resultVersion,
        document.sourceVersion
      );

      const stagedTarget = await runGitBuffer(["show", `:0:${rel}`], repoRoot);
      assert.deepEqual([...stagedTarget], [...originalTarget]);
      assert.deepEqual(await service.listConflicts(), []);
    });
  }
);

test(
  "manual Result write와 stage 사이 외부 편집을 사용자 Result로 오인하지 않는다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const { rel } = await createTextConflict(repoRoot);
      const service = new ConflictService(repoRoot);
      const document = await service.getConflictDocument(rel);
      const resultPath = path.join(repoRoot, rel);
      const userResult = "manual-user\n";
      const externalResult = "external-racer\n";
      await git(repoRoot, ["config", "filter.conflict-race.clean", "sleep 1; cat"]);
      await writeFile(
        path.join(repoRoot, ".git", "info", "attributes"),
        `${rel} filter=conflict-race\n`,
        "utf8"
      );
      const raced = (async (): Promise<void> => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const current = await readFile(resultPath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (current === userResult) {
            await writeFile(resultPath, externalResult, "utf8");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("External writer did not observe the manual Result.");
      })();

      const mutation = service.writeResolvedContent(
        rel,
        userResult,
        true,
        document.resultVersion,
        document.sourceVersion
      ).then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error })
      );
      await raced;
      const outcome = await mutation;
      assert.equal(await readFile(resultPath, "utf8"), externalResult);
      if (outcome.resolved) {
        assert.equal(await git(repoRoot, ["show", `:${rel}`]), userResult);
        assert.deepEqual(await service.listConflicts(), []);
      } else {
        assert.ok(outcome.error);
        assert.deepEqual(await service.listConflicts(), [rel]);
      }
    });
  }
);

test(
  "해결 뒤 native Result 저장은 실행 mode를 보존하고 index를 변경하지 않는다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const rel = "resolved-script.sh";
      await stageExecutableText(repoRoot, rel, "#!/bin/sh\necho staged\n");
      const stagedBefore = await git(repoRoot, ["show", `:${rel}`]);
      const service = new ConflictService(repoRoot);
      const baseline = await service.getWorkingResult(rel, true);

      await service.writeWorkingContent(
        rel,
        "#!/bin/sh\necho edited\n",
        baseline.version
      );

      assert.equal(await readFile(path.join(repoRoot, rel), "utf8"), "#!/bin/sh\necho edited\n");
      assert.notEqual((await lstat(path.join(repoRoot, rel))).mode & 0o100, 0);
      assert.equal(await git(repoRoot, ["show", `:${rel}`]), stagedBefore);
    });
  }
);

test(
  "해결 뒤 native Result 저장은 symlink target을 따라 쓰지 않는다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (repoRoot) => {
      const rel = "resolved-link";
      const victim = path.join(repoRoot, "victim.txt");
      await writeFile(victim, "must remain\n", "utf8");
      await symlink("victim.txt", path.join(repoRoot, rel));
      const service = new ConflictService(repoRoot);
      const baseline = await service.getWorkingResult(rel, true);

      await assert.rejects(
        service.writeWorkingContent(rel, "unsafe overwrite\n", baseline.version),
        /not available|regular file/i
      );

      assert.equal(await readFile(victim, "utf8"), "must remain\n");
      assert.equal(await readlink(path.join(repoRoot, rel)), "victim.txt");
    });
  }
);

test("삭제 side claim 뒤 생긴 외부 파일은 commit 정리에서 삭제하지 않는다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-absent-cas-"));
  const target = path.join(directory, "appeared-later.txt");
  try {
    const claim = await claimConflictWorkingLeaf(target, "worktree:absent");
    await claim.install({ kind: "absent" });
    await writeFile(target, "external replacement\n", "utf8");
    await claim.commit();
    assert.equal(await readFile(target, "utf8"), "external replacement\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "symlink Result transaction rollback은 새 링크만 제거하고 원본 raw target을 복구한다",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-symlink-cas-"));
    const target = path.join(directory, "choice-link");
    const original = Buffer.from([0x6f, 0xff]);
    try {
      await symlink(original, target);
      const snapshot = await readConflictWorkingLeaf(target);
      const claim = await claimConflictWorkingLeaf(target, snapshot.version);
      await claim.install({ kind: "symlink", target: Buffer.from("replacement") });
      await claim.rollback();
      assert.deepEqual([...(await readlink(target, { encoding: "buffer" }))], [...original]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("regular Result의 제자리 외부 편집은 rollback에서 삭제하지 않고 원본과 함께 보존한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-regular-cas-"));
  const target = path.join(directory, "choice.txt");
  try {
    await writeFile(target, "original\n", "utf8");
    await chmod(target, 0o600);
    const snapshot = await readConflictWorkingLeaf(target);
    const claim = await claimConflictWorkingLeaf(target, snapshot.version);
    await claim.install({ kind: "regular", buffer: Buffer.from("desired\n"), mode: "100644" });
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    await writeFile(target, "external in-place\n", "utf8");
    await assert.rejects(claim.rollback(), /Recovery files were preserved/);
    assert.equal(await readFile(target, "utf8"), "external in-place\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("claim 전 열린 원본 FD의 늦은 쓰기는 성공 뒤 recovery 경로로 반환한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-open-fd-"));
  const target = path.join(directory, "choice.txt");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(target, "original\n", "utf8");
    handle = await open(target, "r+");
    const snapshot = await readConflictWorkingLeaf(target);
    const claim = await claimConflictWorkingLeaf(target, snapshot.version);
    await claim.install({ kind: "regular", buffer: Buffer.from("desired\n"), mode: "100644" });
    await handle.truncate(0);
    await handle.writeFile("late external edit\n", "utf8");
    await handle.close();
    handle = undefined;
    const recoveryPath = await claim.commit();
    assert.ok(recoveryPath);
    assert.equal(await readFile(target, "utf8"), "desired\n");
    assert.equal(await readFile(path.join(recoveryPath, "original"), "utf8"), "late external edit\n");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebase 내부 merge 충돌은 Incoming을 stale REBASE_HEAD가 아닌 MERGE_HEAD로 표시한다", async () => {
  await withRepo(async (repoRoot) => {
    const { rel, main } = await createTextConflict(repoRoot);
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
    const mergeHead = (await git(repoRoot, ["rev-parse", "MERGE_HEAD"])).trim();
    const base = (await git(repoRoot, ["rev-parse", "HEAD^"])).trim();
    const rebaseDir = path.join(repoRoot, ".git", "rebase-merge");
    await mkdir(rebaseDir);
    await Promise.all([
      writeFile(path.join(repoRoot, ".git", "REBASE_HEAD"), `${head}\n`, "utf8"),
      writeFile(path.join(rebaseDir, "head-name"), `refs/heads/${main}\n`, "utf8"),
      writeFile(path.join(rebaseDir, "orig-head"), `${head}\n`, "utf8"),
      writeFile(path.join(rebaseDir, "onto"), `${base}\n`, "utf8"),
      writeFile(path.join(rebaseDir, "stopped-sha"), `${head}\n`, "utf8"),
      writeFile(
        path.join(rebaseDir, "done"),
        `pick ${base} base\npick ${head} current\nmerge -C ${mergeHead} incoming-side\n`,
        "utf8"
      ),
      writeFile(path.join(rebaseDir, "git-rebase-todo"), "", "utf8"),
    ]);

    const document = await new ConflictService(repoRoot).getConflictDocument(rel);
    assert.equal(document.operation, "rebase");
    assert.equal(document.incoming.ref, "MERGE_HEAD");
    assert.equal(document.incoming.commit, mergeHead);
    assert.equal(document.context.rebase?.currentStep?.action, "merge");
    assert.equal(document.context.rebase?.currentStep?.index, 3);
    assert.equal(document.context.rebase?.currentStep?.total, 3);
    assert.equal(document.context.rebase?.fileOutcome, "uncertain");
  });
});

test("저장소 mutation lease는 중복 작업을 거부하고 release 뒤 재사용된다", async () => {
  const repoRoot = path.join(os.tmpdir(), "gsc-conflict-coordinator");
  const release = tryAcquireConflictMutation(repoRoot);
  assert.ok(release);
  assert.equal(isConflictMutationActive(repoRoot), true);
  await assert.rejects(
    runConflictMutation(repoRoot, async () => "unreachable"),
    /already running/
  );
  release();
  assert.equal(isConflictMutationActive(repoRoot), false);
  assert.equal(await runConflictMutation(repoRoot, async () => "completed"), "completed");
  assert.equal(isConflictMutationActive(repoRoot), false);
});
