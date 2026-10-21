import { mkdir, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** 별도 저장소에만 만드는 게시 이력·feature 크기·광고 branch 수다. */
export interface PublishedPushFixtureOptions {
  largeFeature?: boolean;
  staleBranches?: number;
  largeBaseBytes?: number;
}

/** 수신 hook에 전달할 경로의 공백·따옴표를 shell 리터럴로 보존한다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/**
 * 여러 오래된 tip 뒤에 실제 게시 base가 광고되는 로컬 receiver와 미게시 commit 세 개를 만든다.
 * @param directory 호출자가 생성·정리할 소유 임시 디렉터리
 * @param options 큰 객체는 sparse 파일로 작성해 Node에 대형 Buffer를 보관하지 않는다.
 * @returns source/receiver 경로, 게시 base, 최종 source와 receiver hook의 실제 update 기록 위치
 */
export async function createPublishedPushFixture(directory: string, options: PublishedPushFixtureOptions = {}) {
  const staleBranches = options.staleBranches ?? 0, publishedCommits = Math.max(32, staleBranches + 32);
  const root = path.join(directory, "repo"), remote = path.join(directory, "origin.git"), updates = path.join(directory, "updates");
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Push Fixture", "user.email": "push@example.invalid",
    "core.fsmonitor": "false", "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false" }))
    await runGit(["config", key, value], root);
  let largeBase: string | undefined;
  if (options.largeBaseBytes) {
    const file = path.join(directory, "published-large.bin");
    await writeFile(file, ""); await truncate(file, options.largeBaseBytes);
    largeBase = (await runGit(["hash-object", "-w", "--", file], root)).trim();
  }
  let mark = 1;
  const data = ["blob", "mark :1", "data 8", "fixture\n"];
  /** 동일한 부모·메시지·변경을 fast-import로 조립해 fixture 준비의 commit 프로세스를 줄인다. */
  const commit = (ref: string, parent: number | undefined, message: string, changes: string[] = []) => {
    const current = ++mark;
    data.push(`commit refs/heads/${ref}`, `mark :${current}`, "committer Push Fixture <push@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(message)}`, message, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return current;
  };
  let base = commit("main", undefined, "base", ["M 100644 :1 tracked.txt"]);
  for (let index = 1; index < publishedCommits; index++) base = commit("main", base, `published ${index}`,
    largeBase && index === publishedCommits - 1 ? [`M 100644 ${largeBase} published-large.bin`] : []);
  let tip = base;
  if (options.largeFeature) {
    const payload = "larger feature change\n".repeat(512);
    data.push("blob", `mark :${++mark}`, `data ${Buffer.byteLength(payload)}`, payload);
  }
  const featureBlob = options.largeFeature ? mark : 1;
  for (let index = 0; index < 3; index++) tip = commit("feature", tip, `feature ${index}`, [`M 100644 :${featureBlob} feature-${index}.txt`]);
  await runGitWithInput(["fast-import", "--quiet"], root, data.join("\n") + "\n");
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", "--initial-branch=main", remote], directory);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-qu", "origin", "main"], root);
  if (staleBranches) {
    const published = (await runGit(["rev-list", "--reverse", "main"], root)).trim().split("\n");
    await runGitWithInput(["update-ref", "--stdin"], remote, published.slice(0, staleBranches)
      .map((oid, index) => `update refs/heads/a-published-${String(index).padStart(4, "0")} ${oid}\n`).join(""));
  }
  const baseOid = (await runGit(["rev-parse", "main"], root)).trim();
  await mkdir(path.join(remote, "hooks"), { recursive: true });
  await writeFile(path.join(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> ${quote(updates)}\n`, { mode: 0o755 });
  await runGit(["switch", "-q", "feature"], root);
  return { root, remote, updates, baseOid, publishedCommits, staleBranches,
    head: (await runGit(["rev-parse", "HEAD"], root)).trim() };
}
