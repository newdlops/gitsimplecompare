// 네트워크 없이 production 경로의 조회 수·시간을 측정해 최적화 전후를 비교한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runGit } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../../src/git/pushService";
import { GitServiceRegistry } from "../../src/git/serviceRegistry";
import { SEQUENTIAL_PUSH_THRESHOLD_BYTES } from "../../src/git/sequentialPush";

/**
 * 실제 observer가 완료한 Git 실행만 세어 빠진 호출이나 의도하지 않은 중복을 드러낸다.
 * @param operation 같은 fixture에서 실행할 production 서비스 호출
 * @returns 소요 시간·전체/조회 실행 수·명령별 실행 수. 민감한 인자나 출력은 포함하지 않는다.
 */
async function measure(operation: () => Promise<void>) {
  const executions: GitExecutionTiming[] = [];
  const dispose = setGitExecutionObserver(timing => executions.push(timing));
  const started = performance.now();
  try { await operation(); }
  finally { dispose(); }
  const commands: Record<string, number> = {};
  for (const timing of executions) commands[timing.command] = (commands[timing.command] ?? 0) + 1;
  return { elapsedMs: Math.round(performance.now() - started), executions: executions.length,
    reads: executions.filter(timing => timing.command !== "push").length, commands };
}

/**
 * main의 outgoing 30커밋과 압축 전 50MiB 객체를 가진 로컬 source/bare remote를 만든다.
 * @param directory 이번 실행만 소유하는 임시 부모 경로
 * @returns 저장소·원격·기준 OID. 테스트 밖의 Git 설정·hook·서명은 사용하지 않는다.
 */
async function fixture(directory: string) {
  const root = path.join(directory, "repository"), remote = path.join(directory, "remote.git");
  await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  await mkdir(path.join(directory, "hooks"));
  for (const [key, value] of Object.entries({ "user.name": "Performance Fixture", "user.email": "performance@example.invalid",
    "core.hooksPath": path.join(directory, "hooks"), "commit.gpgsign": "false", "core.fsmonitor": "false", "push.default": "simple" })) {
    await runGit(["config", key, value], root);
  }
  await writeFile(path.join(root, "base.txt"), "base\n");
  await runGit(["add", "base.txt"], root); await runGit(["commit", "-qm", "base"], root);
  const base = (await runGit(["rev-parse", "HEAD"], root)).trim();
  await runGit(["-c", "init.templateDir=", "init", "--bare", "-q", remote], directory);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-qu", "origin", "main"], root);
  await writeFile(path.join(root, "large.bin"), Buffer.alloc(SEQUENTIAL_PUSH_THRESHOLD_BYTES, 0x61));
  await runGit(["add", "large.bin"], root); await runGit(["commit", "-qm", "large"], root);
  const tree = (await runGit(["rev-parse", "HEAD^{tree}"], root)).trim();
  let head = (await runGit(["rev-parse", "HEAD"], root)).trim();
  for (let index = 1; index < 30; index++) {
    head = (await runGit(["commit-tree", tree, "-p", head, "-m", "outgoing " + index], root)).trim();
  }
  await runGit(["update-ref", "refs/heads/main", head], root);
  return { root, remote, base, head };
}

/**
 * cold 저장소 탐색과 대용량 순차 푸시의 같은 fixture를 3회 실행해 계측 편차를 함께 보여 준다.
 * @returns JSON 결과 출력 후 모든 소유 fixture를 정리하는 Promise
 */
export async function run(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-repository-flows-benchmark-"));
  try {
    const f = await fixture(directory);
    const discovery = await measure(async () => {
      const registry = new GitServiceRegistry();
      const identities = await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2
        ? registry.resolveWithBranch(f.root) : registry.resolve(f.root)));
      assert.ok(identities.every(Boolean));
    });
    const pushes = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      await runGit(["update-ref", "refs/heads/main", f.base], f.remote);
      await runGit(["update-ref", "refs/remotes/origin/main", f.base], f.root);
      pushes.push(await measure(async () => {
        const result = await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root));
        assert.equal(result.execution?.strategy, "sequential");
        assert.equal(result.execution?.completed, 30);
      }));
      assert.equal((await runGit(["rev-parse", "main"], f.remote)).trim(), f.head);
    }
    console.log(JSON.stringify({ scenario: "30 outgoing commits, 50 MiB raw objects, local bare remote", discovery, pushes }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
