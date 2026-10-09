import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit } from "../src/git/gitExec";
import {
  RepositorySetupError, RepositorySetupService, normalizeCloneSource,
  suggestedRepositoryFolderName, validateRepositoryFolderName, type SetupGitRunner,
} from "../src/git/repositorySetupService";

/** 실제 Git 통합 테스트는 임시 디렉터리만 소유하고 종료 시 해당 fixture만 정리한다. */
async function directoryFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-repository-onboarding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** clone의 원본으로 사용할 커밋 한 개를 실제 Git으로 만들고 사용자 hooks·서명을 분리한다. */
async function committedRepository(root: string): Promise<void> {
  await mkdir(path.join(root, "empty-hooks"));
  await runGit(["-c", "init.templateDir=", "init", "--initial-branch=main", "--", root], path.dirname(root));
  await runGit(["config", "core.hooksPath", path.join(root, "empty-hooks")], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await runGit(["config", "user.name", "Onboarding Test"], root);
  await runGit(["config", "user.email", "onboarding@example.invalid"], root);
  await writeFile(path.join(root, "file with spaces.txt"), "base\n");
  await runGit(["add", "--", "file with spaces.txt"], root);
  await runGit(["commit", "-qm", "fixture"], root);
}

/** 사용자가 클릭할 Clone/Init이 실제 Git으로 동작하고 기존 source를 변경하지 않는지 확인한다. */
test("own repository setup clones a local repository and initializes an unborn branch without VS Code", async t => {
  const directory = await directoryFixture(t);
  const source = path.join(directory, "source");
  await mkdir(source);
  await committedRepository(source);
  const indexBefore = await readFile(path.join(source, ".git", "index"));
  const service = new RepositorySetupService();
  const clone = await service.clone(source, directory, "cloned repository");
  assert.equal(clone.created, true);
  assert.equal(clone.branch, "main");
  assert.equal(await readFile(path.join(clone.root, "file with spaces.txt"), "utf8"), "base\n");
  assert.equal((await runGit(["rev-parse", "HEAD"], clone.root)), (await runGit(["rev-parse", "HEAD"], source)));
  assert.deepEqual(await readFile(path.join(source, ".git", "index")), indexBefore);
  const blank = path.join(directory, "new repository");
  await mkdir(blank);
  await writeFile(path.join(blank, "existing.txt"), "keep\n");
  const initialized = await service.initialize(blank, "feature/first");
  assert.equal(initialized.created, true);
  assert.equal(initialized.branch, "feature/first");
  assert.ok((await stat(path.join(initialized.root, ".git", "HEAD"))).isFile());
  assert.equal(await readFile(path.join(blank, "existing.txt"), "utf8"), "keep\n");
});

/** 빈 기존 폴더·파일·심볼릭 링크 모두 clone 대상에 사용할 수 없고 데이터를 보존하는지 확인한다. */
test("existing clone destinations are preserved even when empty", async t => {
  const directory = await directoryFixture(t);
  const source = path.join(directory, "source");
  await mkdir(source); await committedRepository(source);
  const service = new RepositorySetupService();
  await mkdir(path.join(directory, "existing"));
  await assert.rejects(service.clone(source, directory, "existing"),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "destination-exists");
  assert.deepEqual(await readdir(path.join(directory, "existing")), []);
  await writeFile(path.join(directory, "existing-file"), "keep");
  await assert.rejects(service.clone(source, directory, "existing-file"),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "destination-exists");
  assert.equal(await readFile(path.join(directory, "existing-file"), "utf8"), "keep");
  const link = path.join(directory, "existing-link");
  await symlink(source, link, "junction");
  const originalIndex = await readFile(path.join(source, ".git/index"));
  await assert.rejects(service.clone(source, directory, "existing-link"),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "destination-exists");
  assert.equal(await readlink(link), source);
  assert.deepEqual(await readFile(path.join(source, ".git/index")), originalIndex);
});

/** existing repository를 Init으로 다시 선택해도 index·config·HEAD와 tracked 파일을 그대로 유지한다. */
test("initializing inside an existing repository reuses it without writing Git metadata", async t => {
  const directory = await directoryFixture(t);
  const source = path.join(directory, "source"); await mkdir(source); await committedRepository(source);
  await mkdir(path.join(source, "nested"));
  const before = await Promise.all(["index", "config", "HEAD"].map(file => readFile(path.join(source, ".git", file))));
  const result = await new RepositorySetupService().initialize(path.join(source, "nested"), "must-not-replace");
  assert.equal(result.created, false);
  assert.equal(result.branch, "main");
  assert.equal(result.root, await new RepositorySetupService().findRepository(source));
  const after = await Promise.all(["index", "config", "HEAD"].map(file => readFile(path.join(source, ".git", file))));
  assert.deepEqual(after, before);
});

/** 옵션/remote helper/credentials/제어 문자/상위 경로를 서비스 입력 단계에서 차단하는지 확인한다. */
test("clone input rejects Git option injection and embedded secrets before execution", () => {
  for (const source of ["--upload-pack=anything", "ext::helper argument", "https://user:secret@github.com/o/r.git",
    "https://github.com/o/r.git?token=secret", "https://github.com/o/r.git#secret", "http://", "source\n--option"]) {
    assert.throws(() => normalizeCloneSource(source), RepositorySetupError);
  }
  for (const name of ["../escape", "nested/repo", "..", ".git", ".GIT", "repo\\nested", "-option", "CON", "nul.txt", "trailing.", "repo\nname"]) {
    assert.throws(() => validateRepositoryFolderName(name), RepositorySetupError);
  }
  assert.equal(normalizeCloneSource("owner/repo"), "https://github.com/owner/repo.git");
  assert.equal(normalizeCloneSource("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  assert.equal(suggestedRepositoryFolderName("https://github.com/owner/my-repo.git"), "my-repo");
  assert.equal(suggestedRepositoryFolderName("git@github.com:owner/my-repo.git"), "my-repo");
  assert.equal(validateRepositoryFolderName("my repository"), "my repository");
});

/** OAuth는 URL·argv가 아닌 해당 GitHub HTTPS 전용 환경에만 들어가는지 확인한다. */
test("GitHub credentials are isolated from clone arguments and non-GitHub hosts", async t => {
  const directory = await directoryFixture(t);
  const calls: Array<{ args: string[]; options: any }> = [];
  const fake: SetupGitRunner = async (args, _cwd, options) => {
    calls.push({ args, options });
    return args[0] === "symbolic-ref" ? "main\n" : "";
  };
  const service = new RepositorySetupService(fake);
  const token = "fixture-oauth-token";
  await service.clone("https://github.com/owner/repo.git", directory, "github", { githubToken: token });
  const clone = calls.find(call => call.args[0] === "clone")!;
  assert.ok(clone.args.every(value => !value.includes(token)));
  assert.ok(clone.args.includes("--"));
  const env = clone.options.env as Record<string, string>;
  const count = Number(env.GIT_CONFIG_COUNT);
  const headers = Array.from({ length: count }, (_, index) => [env["GIT_CONFIG_KEY_" + index], env["GIT_CONFIG_VALUE_" + index]]);
  assert.ok(headers.some(([key, value]) => key === "http.https://github.com/.extraheader" && value.startsWith("Authorization: Basic ")));
  assert.ok(clone.options.clearEnv.includes("GIT_DIR"));
  assert.ok(clone.options.clearEnv.includes("GIT_INDEX_FILE"));
  calls.length = 0;
  await service.clone("https://example.invalid/owner/repo.git", directory, "other", { githubToken: token });
  const other = calls.find(call => call.args[0] === "clone")!;
  assert.ok(!Object.values(other.options.env).some(value => typeof value === "string" &&
    value.includes(Buffer.from("x-access-token:" + token).toString("base64"))));
});

/** 인증 원문이 실패 진단과 OUTPUT로 새지 않고 비어 있는 자기 폴더만 정리하는지 확인한다. */
test("failed clones redact authentication and remove only their empty owned directory", async t => {
  const directory = await directoryFixture(t), token = "fixture-secret";
  const service = new RepositorySetupService(async () => {
    throw new Error("Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64") + " " + token);
  });
  await assert.rejects(service.clone("https://github.com/o/r.git", directory, "failed", { githubToken: token }),
    (error: unknown) => error instanceof RepositorySetupError && !error.message.includes(token) && error.message.includes("[REDACTED]"));
  assert.ok(!(await readdir(directory)).includes("failed"));
});

/** Git나 사용자가 남긴 파일은 실패 뒤에도 재귀 삭제하지 않는지 확인한다. */
test("partial clone data is preserved instead of being recursively deleted", async t => {
  const directory = await directoryFixture(t);
  const service = new RepositorySetupService(async args => {
    await writeFile(path.join(args.at(-1)!, "keep.txt"), "keep");
    throw new Error("transport failed");
  });
  await assert.rejects(service.clone("https://github.com/o/r.git", directory, "partial"), RepositorySetupError);
  assert.equal(await readFile(path.join(directory, "partial", "keep.txt"), "utf8"), "keep");
});

/** 시작 전·Git 중·메타데이터 조회 중 취소가 성공 결과로 바뀌지 않는지 확인한다. */
test("cancellation before and during setup stops the workflow without claiming completion", async t => {
  const directory = await directoryFixture(t);
  let executions = 0;
  const before = new AbortController(); before.abort();
  const service = new RepositorySetupService(async () => { executions++; return ""; });
  await assert.rejects(service.clone("https://github.com/o/r.git", directory, "before", { signal: before.signal }),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "cancelled");
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(directory), []);
  const after = new AbortController();
  const late = new RepositorySetupService(async args => {
    if (args[0] === "symbolic-ref") { after.abort(); throw new Error("metadata cancelled"); }
    return "";
  });
  await assert.rejects(late.clone("https://github.com/o/r.git", directory, "late", { signal: after.signal }),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "cancelled");
});

/** 부모·대상의 검증 오류가 Git init/clone 실행으로 이어지지 않는지 확인한다. */
test("missing folders and invalid branch names leave the destination unchanged", async t => {
  const directory = await directoryFixture(t);
  const service = new RepositorySetupService();
  await assert.rejects(service.initialize(path.join(directory, "missing")), RepositorySetupError);
  await mkdir(path.join(directory, "blank"));
  await assert.rejects(service.initialize(path.join(directory, "blank"), "invalid branch"), RepositorySetupError);
  assert.deepEqual(await readdir(path.join(directory, "blank")), []);
});
