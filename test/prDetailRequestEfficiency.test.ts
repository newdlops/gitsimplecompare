import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequestService } from "../src/git/pullRequestService";
import { clearGitHubRepositoryNameCache } from "../src/git/githubRepositoryName";

let root: string;
let callsPath: string;
const previous = { cli: process.env.GITHUB_CLI_PATH, calls: process.env.GSC_DETAIL_TEST_CALLS, repo: process.env.GH_REPO };
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** 실제 자식 프로세스 경계만 대체하고 서비스·저장소 해석·정규화·read cache는 그대로 실행한다. */
before(async () => {
  root = await mkdtemp(join(tmpdir(), "gsc-pr-detail-efficient-"));
  callsPath = join(root, "calls.jsonl");
  const executable = join(root, "gh.cjs");
  await writeFile(executable, ["#!/usr/bin/env node",
    'const fs=require("node:fs"),a=process.argv.slice(2),configured=process.env.GH_REPO||"owner/one";',
    'fs.appendFileSync(process.env.GSC_DETAIL_TEST_CALLS,JSON.stringify(a)+"\\n");',
    'const out=value=>process.stdout.write(JSON.stringify(value));',
    'if(a[0]==="repo"&&a[1]==="view"){out({nameWithOwner:configured});process.exit(0)}',
    'const field=name=>a.find(value=>value.startsWith(name+"="))?.slice(name.length+1);',
    'const route=a.find(value=>value.startsWith("repos/"));',
    'const owner=field("owner"),name=field("name");',
    'const target=route ? (route.includes("{owner}/{repo}")?configured:route.split("/").slice(1,3).join("/")) : owner==="{owner}"&&name==="{repo}"?configured:owner+"/"+name;',
    'const prefix=target.replace("/","-");',
    'if(route){out([{filename:prefix+"-a.ts",status:"renamed",previous_filename:"old.ts",additions:2,deletions:1}]);process.exit(0)}',
    'out({data:{repository:{pullRequest:{number:42,comments:{totalCount:2},files:{totalCount:2,nodes:[{path:prefix+"-a.ts",changeType:"MODIFIED",additions:2,deletions:1},{path:prefix+"-b.ts",changeType:"ADDED",additions:3,deletions:0}],pageInfo:{hasNextPage:false}},reviewThreads:{nodes:[{path:prefix+"-a.ts",comments:{totalCount:3}},{path:prefix+"-b.ts",comments:{totalCount:1}}],pageInfo:{hasNextPage:false}}}}}});',
  ].join("\n"));
  await chmod(executable, 0o755);
  process.env.GITHUB_CLI_PATH = executable;
  process.env.GSC_DETAIL_TEST_CALLS = callsPath;
});

/** 각 검사는 유효한 같은 CLI를 쓰되 변경 가능한 저장소 문맥과 요청 기록은 분리한다. */
beforeEach(async () => {
  clearGitHubRepositoryNameCache();
  process.env.GH_REPO = "owner/one";
  await writeFile(callsPath, "");
});

/** 생성한 fixture와 이 검사에서 바꾼 환경 변수만 원래 값으로 복원한다. */
after(async () => {
  for (const [name, value] of [["GITHUB_CLI_PATH", previous.cli], ["GSC_DETAIL_TEST_CALLS", previous.calls], ["GH_REPO", previous.repo]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  await rm(root, { recursive: true, force: true });
});

/** CLI 경계에 전달한 조회 인자를 안전한 fixture 파일에서 읽어 반환한다. */
async function calls(): Promise<string[][]> {
  return (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("PR detail reads files and exact review counts without a preceding repo view", async () => {
  const result = await new PullRequestService(root).getDetail(42);
  assert.equal(result.files.length, 2);
  assert.equal(result.fileCommentCount, 4);
  assert.equal(result.commentCount, 6);
  const requests = await calls();
  assert.equal(requests.length, 1, "no extra repository lookup round trip");
  assert.ok(requests[0].includes("owner={owner}") && requests[0].includes("name={repo}"));
});

test("PR detail follows the current GH_REPO when the same workspace changes GitHub context", async () => {
  const service = new PullRequestService(root);
  assert.equal((await service.getDetail(42)).files[0].path, "owner-one-a.ts");
  process.env.GH_REPO = "owner/two";
  assert.equal((await service.getDetail(42)).files[0].path, "owner-two-a.ts");
});

test("Explorer changed files skip repo view and retain rename metadata", async () => {
  const result = await new PullRequestService(root).getChangedFiles(42);
  assert.deepEqual(result.files, [{ path: "owner-one-a.ts", oldPath: "old.ts", status: "R", additions: 2, deletions: 1 }]);
  const requests = await calls();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1], "repos/{owner}/{repo}/pulls/42/files?per_page=100&page=1");
});
