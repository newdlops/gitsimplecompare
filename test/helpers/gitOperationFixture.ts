import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** benchmark 밖의 저장소를 입력받지 않고 고정된 트리/히스토리/branch 수의 fixture만 생성한다. */
export async function createGitOperationFixture(directory: string) {
  const root = path.join(directory, "repository"), remote = path.join(directory, "remote.git");
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Operation Fixture", "user.email": "operations@example.invalid",
    "core.fsmonitor": "false", "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false", "push.default": "simple" })) {
    await runGit(["config", key, value], root);
  }
  const files = Number(process.env.GSC_BENCH_FILES || 1000), depth = Number(process.env.GSC_BENCH_COMMITS || 1000);
  const branches = Number(process.env.GSC_BENCH_BRANCHES || 100);
  assert.ok([files, depth, branches].every(value => Number.isSafeInteger(value) && value > 0));
  let nextMark = 1;
  const data: string[] = ["blob", `mark :${nextMark++}`, "data 13", "fixture data\n"];
  const marks: number[] = [];
  /** fast-import의 각 commit을 인자로 고정해 fixture 생성에 수천 Git 프로세스를 만들지 않는다. */
  const addCommit = (ref: string, parent: number | undefined, name: string, changes: string[] = []) => {
    const mark = nextMark++; marks.push(mark);
    data.push(`commit refs/heads/${ref}`, `mark :${mark}`, "committer Operation Fixture <operations@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(name)}`, name, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return mark;
  };
  let main = addCommit("main", undefined, "base", Array.from({ length: files }, (_, index) => `M 100644 :1 tracked-${index}.txt`));
  const history = [main];
  for (let index = 1; index < depth; index++) { main = addCommit("main", main, `main ${index}`); history.push(main); }
  for (let index = 0; index < branches; index++) addCommit(`side-${index}`, history[Math.max(0, depth - index * 3 - 1)], `side ${index}`,
    [`M 100644 :1 side-${index}.txt`]);
  const topic = addCommit("topic", history[Math.max(0, depth - 8)], "topic", ["M 100644 :1 topic.txt"]);
  let pr = main;
  const prMarks: number[] = [];
  for (let index = 0; index < 3; index++) { pr = addCommit("pr-source", pr, `PR ${index}`, [`M 100644 :1 pr-${index}.txt`]); prMarks.push(pr); }
  const oldHistory = history[Math.max(0, depth - 601)];
  data.push("reset refs/heads/old-history", `from :${oldHistory}`, "");
  const marksFile = path.join(directory, "marks");
  await runGitWithInput(["fast-import", "--quiet", `--export-marks=${marksFile}`], root, data.join("\n") + "\n");
  const objectIds = new Map((await readFile(marksFile, "utf8")).trim().split("\n").map(line => {
    const [mark, oid] = line.split(" "); return [Number(mark.slice(1)), oid];
  }));
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", "--initial-branch=main", remote], directory);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-qu", "origin", "main", "refs/heads/side-*:refs/heads/side-*"], root);
  const sharedUpstreamBranches = Number(process.env.GSC_BENCH_SHARED_UPSTREAM_BRANCHES || 0);
  assert.ok(Number.isSafeInteger(sharedUpstreamBranches) && sharedUpstreamBranches >= 0 && sharedUpstreamBranches <= branches);
  if (sharedUpstreamBranches) {
    // 각 feature는 자기 원격에도 게시돼 있지만 upstream은 main인 실제 PR 개발 형태를 재현한다.
    // branch.merge는 다중 값이므로 추가 대신 교체해 Native Git이 이전 첫 값을 선택하지 않게 한다.
    for (let index = 0; index < sharedUpstreamBranches; index++)
      await runGit(["config", "--local", "--replace-all", `branch.side-${index}.merge`, "refs/heads/main"], root);
  }
  const mainOid = objectIds.get(main)!;
  const tree = (await runGit(["rev-parse", "main^{tree}"], root)).trim();
  const incoming = (await runGit(["-c", "user.name=Operation Fixture", "-c", "user.email=operations@example.invalid",
    "commit-tree", tree, "-p", mainOid, "-m", "incoming remote change"], remote)).trim();
  // fresh pull과 fresh fetch가 같은 객체를 먼저 받아 버리지 않도록 서로 다른 미공개 commit을 만든다.
  const incomingPull = (await runGit(["-c", "user.name=Operation Fixture", "-c", "user.email=operations@example.invalid",
    "commit-tree", tree, "-p", mainOid, "-m", "incoming pull change"], remote)).trim();
  return { root, remote, main: mainOid, incoming, incomingPull, oldHistory: objectIds.get(oldHistory)!, topic: objectIds.get(topic)!, pr: objectIds.get(pr)!,
    prCommits: prMarks.map(mark => objectIds.get(mark)!), files, depth, branches, sharedUpstreamBranches };
}

import assert from "node:assert/strict";
