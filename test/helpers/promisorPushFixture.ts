import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** 테스트가 소유한 저장소에서만 Native Git 출력의 마지막 개행을 정리한다. */
export const promisorGit = async (root: string, ...args: string[]) => (await runGit(args, root)).trim();

/** pack/idx/promisor 파일의 이름과 실제 바이트 합계를 함께 읽어 다운로드 여부를 검증한다. */
export async function promisorPackState(root: string) {
  const folder = path.join(root,".git/objects/pack"), names = (await readdir(folder)).sort();
  return { names, bytes: (await Promise.all(names.map(name=>stat(path.join(folder,name))))).reduce((sum,item)=>sum+item.size,0) };
}

/** 결측 조회 자체는 promisor fetch를 하지 않게 고정하고 각 blob의 존재 여부를 반환한다. */
export async function missingPromisorBlobs(root: string, blobs: readonly string[]): Promise<number> {
  let count=0;
  for (const blob of blobs) if (await runGit(["cat-file","-e",blob],root,{env:{GIT_NO_LAZY_FETCH:"1"}}).then(()=>false,()=>true)) count++;
  return count;
}

/**
 * blobless/tree-less source와 새 commit을 광고하는 별도 push 서버를 만든다.
 * @param directory 호출자가 mkdtemp로 소유한 임시 디렉터리 @param options tag·필터·실제 객체 크기
 * @returns 아직 전송하지 않은 두 commit, 결측 객체, 실제 단일 push URL. 외부 저장소를 받지 않는다.
 */
export async function createPromisorPushFixture(directory: string, options: { tag?: boolean; filter?: string; blobCount?: number; blobBytes?: number; largeNew?: boolean } = {}) {
  const git=promisorGit, seed=path.join(directory,"seed"), server=path.join(directory,"server.git"), receiver=path.join(directory,"receiver.git"), root=path.join(directory,"source");
  await mkdir(seed);await mkdir(path.join(directory,"hooks"));await git(seed,"init","-q","-b","main");
  for(const [key,value]of Object.entries({"user.name":"Promisor Fixture","user.email":"promisor@example.invalid","commit.gpgSign":"false","core.hooksPath":path.join(directory,"hooks"),"gc.auto":"0"}))await git(seed,"config",key,value);
  const blobs:string[]=[];
  for(let i=0;i<(options.blobCount??4);i++)blobs.push((await runGitWithInput(["hash-object","-w","--stdin"],seed,String(i).repeat(options.blobBytes??1024))).trim());
  const entries=blobs.map((oid,i)=>`100644 blob ${oid}\tbase-${i}.txt\n`);
  const tree=(await runGitWithInput(["mktree"],seed,entries.join(""))).trim(),base=await git(seed,"commit-tree",tree,"-m","base");
  await git(seed,"update-ref","refs/heads/main",base);
  await git(directory,"clone","-q","--bare",seed,server);await git(directory,"clone","-q","--bare",seed,receiver);
  await git(server,"config","uploadpack.allowFilter","true");await git(server,"config","uploadpack.allowAnySHA1InWant","true");
  const advanced=await git(receiver,"-c","user.name=Receiver","-c","user.email=receiver@example.invalid","commit-tree",tree,"-p",base,"-m","advanced receiver");
  await git(receiver,"update-ref","refs/heads/main",advanced);if(options.tag)await git(receiver,"update-ref","refs/tags/shared-base",base);
  await git(directory,"clone","-q",`--filter=${options.filter??"blob:none"}`,"--no-checkout",pathToFileURL(server).href,root);
  for(const [key,value]of Object.entries({"user.name":"Promisor Fixture","user.email":"promisor@example.invalid","core.fsmonitor":"false","core.hooksPath":path.join(directory,"hooks"),"gc.auto":"0",
    "fetch.prune":"true","fetch.pruneTags":"true","fetch.writeCommitGraph":"true","push.negotiate":"false"}))await git(root,"config",key,value);
  await git(root,"remote","add","publish",receiver);
  let head=base;const commits:string[]=[];
  for(let i=0;i<2;i++) {
    const blob=(await runGitWithInput(["hash-object","-w","--stdin"],root,options.largeNew&&i===0?"new data\n".repeat(1024):`new ${i}\n`)).trim();
    const nextTree=(await runGitWithInput(["mktree","--missing"],root,[...entries,`100644 blob ${blob}\tnew.txt\n`].join(""))).trim();
    head=await git(root,"commit-tree",nextTree,"-p",head,"-m",`new ${i}`);commits.push(head);
  }
  await git(root,"update-ref","refs/heads/topic",head);await git(root,"symbolic-ref","HEAD","refs/heads/topic");
  await git(root,"update-ref","refs/remotes/publish/stale",base);await git(root,"update-ref","refs/tags/keep-local",base);
  // read-tree는 worktree checkout 없이 index만 준비해 결측 blob을 의도치 않게 받지 않는다.
  await git(root,"read-tree","HEAD");
  const staged=(await runGitWithInput(["hash-object","-w","--stdin"],root,"keep staged\n")).trim();
  await git(root,"update-index","--cacheinfo","100644",staged,"new.txt");
  await writeFile(path.join(root,"new.txt"),"keep unstaged\n");await writeFile(path.join(root,"keep-untracked.txt"),"keep untracked\n");
  await writeFile(path.join(root,".git/FETCH_HEAD"),"keep prior fetch information\n");
  assert.equal(await missingPromisorBlobs(root,blobs),blobs.length,"Fixture setup must not hydrate the missing blobs");
  await assert.rejects(runGit(["cat-file","-e",advanced],root,{env:{GIT_NO_LAZY_FETCH:"1"}}));
  return {root,server,receiver,base,head,commits,blobs,tree};
}

/** 원래 index·설정·사용자 파일·ref 및 Git metadata를 Native 조회/원본 바이트로 보존한다. */
export async function promisorSourceSnapshot(root: string) {
  const files: Record<string,string|null>={};
  for(const file of [".git/index",".git/config",".git/FETCH_HEAD",".git/objects/info/commit-graph","new.txt","keep-untracked.txt"])
    files[file]=await readFile(path.join(root,file)).then(value=>value.toString("base64"),error=>{if(error.code==="ENOENT")return null;throw error;});
  return { files, head:await promisorGit(root,"rev-parse","HEAD"),refs:await promisorGit(root,"for-each-ref","--format=%(refname) %(objectname)") };
}
