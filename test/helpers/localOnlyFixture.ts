import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalBranchStatus } from "../../src/graph/graphTypes";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** 실제 Git object를 공유하되 기준점이 다른 브랜치도 만들 수 있는 비용·정확성 fixture다. */
export interface LocalOnlyFixture {
  root: string; branches: LocalBranchStatus[]; remoteTips: Array<{ name: string; hash: string }>;
  oldDepth: number; localDepth: number; groups: number;
}

/**
 * fast-import 한 번으로 깊은 과거 이력, 두 기준점의 merge, 여러 published tip을 만든다.
 * @param directory 테스트 전용 부모 @param count 브랜치 수 @param groups 기준점 1개 또는 2개
 * @param oldDepth 제외해야 할 과거 이력 깊이 @param localDepth 공유 local 범위의 깊이
 * @returns Git을 실제로 읽어야 하는 branch/remote snapshot. 사용자 저장소·설정은 건드리지 않는다.
 */
export async function localOnlyFixture(directory: string, count = 16, groups = 1, oldDepth = 1000, localDepth = 64): Promise<LocalOnlyFixture> {
  assert.ok(Number.isInteger(count) && count > 0 && [1, 2].includes(groups));
  const root = path.join(directory, "repository"); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  const records: string[] = []; let mark = 0;
  /** 정해진 부모/committer만 사용해 외부 hook·사용자 identity 없이 topology를 구성한다. */
  const commit = (ref: string, parents: number[], message: string) => {
    const id = ++mark;
    records.push(`commit refs/heads/${ref}`, `mark :${id}`, `committer Local Only Fixture <fixture@example.invalid> ${1700000000 + id} +0000`,
      `data ${Buffer.byteLength(message)}`, message, ...(parents.length ? [`from :${parents[0]}`, ...parents.slice(1).map(value => `merge :${value}`)] : []), "");
    return id;
  };
  let old = commit("main", [], "root");
  for (let index = 1; index < oldDepth; index++) old = commit("main", [old], `old ${index}`);
  const a = commit("base-a", [old], "base a"), b = commit("base-b", [old], "base b");
  let shared = commit("shared", [a, b], "shared merge");
  for (let index = 1; index < localDepth; index++) shared = commit("shared", [shared], `local ${index}`);
  const tips = Array.from({ length: count }, (_, index) => commit(`feature-${index}`, [shared], `feature ${index}`));
  const published = commit("published", tips, "published aggregation"), marksFile = path.join(directory, "marks");
  await runGitWithInput(["fast-import", "--quiet", `--export-marks=${marksFile}`], root, records.join("\n") + "\n");
  const ids = new Map((await readFile(marksFile, "utf8")).trim().split("\n").map(line => {
    const [id, hash] = line.split(" "); return [Number(id.slice(1)), hash];
  }));
  const branches = tips.map((id, index): LocalBranchStatus => ({ name: `feature-${index}`, hash: ids.get(id)!,
    upstream: groups === 2 && index % 2 ? "origin/b" : "origin/a", ahead: localDepth + 2, behind: 0,
    gone: false, current: false, dateIso: "", subject: "fixture" }));
  return { root, branches, oldDepth, localDepth, groups, remoteTips: [
    { name: "origin/a", hash: ids.get(a)! }, { name: "origin/b", hash: ids.get(b)! }, { name: "origin/published", hash: ids.get(published)! },
  ] };
}

/**
 * Native 전체 부모 목록을 한 번 읽고 브랜치마다 독립 DFS 차집합으로 membership oracle을 만든다.
 * @param fixture 실제 object topology와 snapshot @returns 최적화의 union/bit 전파를 사용하지 않는 독립 정답
 */
export async function nativeLocalOnlyOracle(fixture: LocalOnlyFixture): Promise<Map<string, string[]>> {
  const output = await runGit(["rev-list", "--all", "--parents"], fixture.root);
  const parents = new Map(output.trim().split("\n").map(line => { const [hash, ...rest] = line.split(" "); return [hash, rest]; }));
  /** Native에서 확인한 부모만 순회하며, 그룹이나 BigInt membership은 사용하지 않는다. */
  const reachable = (head: string) => {
    const seen = new Set<string>(), pending = [head];
    while (pending.length) {
      const hash = pending.pop()!; if (seen.has(hash)) continue;
      seen.add(hash); pending.push(...parents.get(hash) ?? []);
    }
    return seen;
  };
  const result = new Map<string, string[]>(), remotes = new Map(fixture.remoteTips.map(tip => [tip.name, tip.hash]));
  for (const branch of fixture.branches) {
    const excluded = reachable(remotes.get(branch.upstream!)!);
    for (const hash of reachable(branch.hash)) if (!excluded.has(hash)) result.set(hash, [...result.get(hash) ?? [], branch.name]);
  }
  return result;
}
