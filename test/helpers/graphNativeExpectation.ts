import assert from "node:assert/strict";
import { runGit } from "../../src/git/gitExec";
import { GitLogService } from "../../src/git/gitLogService";
import type { Commit } from "../../src/graph/graphTypes";

/** 제품 tag cache/parser와 독립된 Native 원격 tag의 최종 대상이다. */
export interface NativeRemoteTag { remote: string; name: string; hash: string; }

/**
 * 소유 fixture의 원격을 직접 조회해 lightweight/annotated tag의 최종 대상을 읽는다.
 * @param root origin이 소유 bare 저장소를 가리키는 임시 저장소
 * @returns peeled OID를 우선한 원격별 tag 목록. 잘못되거나 불완전한 응답은 검증 실패로 남긴다.
 */
export async function readNativeRemoteTagExpectation(root: string): Promise<NativeRemoteTag[]> {
  const remotes = (await runGit(["remote"], root)).trim().split("\n").filter(Boolean);
  const groups = await Promise.all(remotes.map(async remote => {
    const tags = new Map<string, { direct?: string; peeled?: string }>();
    const output = await runGit(["ls-remote", "--tags", remote], root);
    for (const line of output.split("\n").filter(Boolean)) {
      const match = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
      assert.ok(match, "Native tag advertisement must contain a complete OID and ref");
      const [, hash, name, peeled] = match, tag = tags.get(name) ?? {};
      const field = peeled ? "peeled" : "direct";
      assert.equal(tag[field], undefined, "Native tag advertisement repeated a ref");
      tag[field] = hash; tags.set(name, tag);
    }
    return [...tags].map(([name, tag]) => {
      assert.ok(tag.direct, "A peeled tag advertisement must also contain its direct ref");
      return { remote, name, hash: tag.peeled ?? tag.direct };
    });
  }));
  return groups.flat().sort((a, b) => Buffer.compare(Buffer.from(`${a.remote}/${a.name}`), Buffer.from(`${b.remote}/${b.name}`)));
}

/** 로컬 ref와 별도로 게시되는 원격 tag 장식까지 합쳐 실제 DOM의 정확한 비교 기준을 만든다. */
export function expectedRenderedRefs(commits: readonly Commit[], remoteTags: readonly NativeRemoteTag[]): Map<string, string[]> {
  const refs = new Map(commits.map(commit => [commit.hash, new Set(commit.refs)]));
  for (const tag of remoteTags) refs.get(tag.hash)?.add(`remote-tag:${tag.remote}/${tag.name}`);
  return new Map([...refs].map(([hash, values]) => [hash, [...values].sort()]));
}

/**
 * 패널 cache와 독립된 서비스에 현재 Native branch/tip을 공급해 최종 표시의 비교 기준을 만든다.
 * @param root 소유 임시 저장소 @param limit 패널이 실제로 로드한 commit 수
 * @returns 새 Git log와 완료한 local-only metadata. 실패한 marker 조회를 빈 정상 결과로 받아들이지 않는다.
 */
export async function readNativeGraphExpectation(root: string, limit: number) {
  const service = new GitLogService(root);
  const [local, output] = await Promise.all([
    service.getLocalBranchSnapshot(),
    runGit(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(symref)", "refs/remotes/"], root),
  ]);
  assert.deepEqual(local.invalidRefs, [], "The owned fixture must have no invalid local refs");
  const remote = output.trim().split("\n").filter(Boolean).flatMap(line => {
    const [name, hash, symbolic] = line.split("\0"); return symbolic ? [] : [{ name, hash }];
  });
  service.seedGraphBranchTips(local.branches, remote);
  const commits = await service.getCommitPage(limit, 0, [], true);
  assert.ok((service as any).localOnlyBranchCache.peek(), "Fresh marker verification must finish successfully");
  return commits;
}
