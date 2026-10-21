import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** 기본 합성 fixture 또는 명시한 읽기 전용 이력 snapshot의 격리 fixture를 만든다. */
export async function createGitOperationFixture(directory: string, borrowedMetadataFile?: string) {
  if (borrowedMetadataFile) return createBorrowedFixture(directory, borrowedMetadataFile);
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
    prCommits: prMarks.map(mark => objectIds.get(mark)!), files, depth, branches, sharedUpstreamBranches,
    mainBranch: "main", topicBranch: "topic", prBranch: "pr-source", oldHistoryBranch: "old-history" };
}

interface BorrowedRef { ref: string; hash: string; symref: string; upstream: string; remote: string; remoteRef: string }
interface BorrowedMetadata {
  source: string; objects: string; head: string; objectFormat: "sha1" | "sha256"; refsStable: boolean; refs: BorrowedRef[];
  tree: { entries: number; blobBytes: number; unknown: number; submodules: number };
}
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NAMES = { mainBranch: "gsc-benchmark-main", topicBranch: "gsc-benchmark-topic", prBranch: "gsc-benchmark-pr", oldHistoryBranch: "gsc-benchmark-old" };

/**
 * 원본에는 Git 쓰기를 전혀 하지 않고 private Git dir 두 개가 원본 object만 읽게 한다.
 * @param directory 호출자가 만든 빈 임시 부모 @param metadataFile 읽기 전용으로 미리 수집한 이력/ref snapshot
 * @returns 실제 이력/ref 규모 위에 합성 작업 브랜치와 private bare 원격을 둔 fixture
 */
async function createBorrowedFixture(directory: string, metadataFile: string) {
  const snapshot = JSON.parse(await readFile(metadataFile, "utf8")) as BorrowedMetadata;
  const source = await realpath(snapshot.source), destination = await realpath(directory), objects = await realpath(snapshot.objects);
  const relative = path.relative(source, destination);
  assert.ok(relative.startsWith(".." + path.sep) || path.isAbsolute(relative), "A borrowed fixture must be outside its source repository");
  assert.ok(snapshot.refsStable && OID.test(snapshot.head) && ["sha1", "sha256"].includes(snapshot.objectFormat));
  assert.ok(snapshot.tree.unknown === 0 && snapshot.tree.submodules === 0 && snapshot.tree.blobBytes <= 512 * 1024 * 1024,
    "Borrowed checkout must have known blobs and fit the 512MiB fixture budget");
  assert.ok(!/[\r\n]/.test(objects), "An alternate object path must fit one line");
  for (const item of snapshot.refs) {
    assert.ok(/^refs\/(?:heads|remotes|tags|replace)\//.test(item.ref) && !/[\x00-\x20\\]/.test(item.ref) && !item.ref.includes("..") && OID.test(item.hash));
    assert.ok(!item.remote || item.remote === "origin", "This captured fixture models one origin without copying any source remote URL");
    assert.ok(!Object.values(NAMES).some(name => item.ref === `refs/heads/${name}`), "Reserved fixture branch exists on source");
  }
  const root = path.join(directory, "repository"), remote = path.join(directory, "remote.git"), hooks = path.join(directory, "hooks");
  await mkdir(root); await mkdir(hooks);
  await runGit(["-c", "init.templateDir=", "init", "-q", `--object-format=${snapshot.objectFormat}`, `--initial-branch=${NAMES.mainBranch}`], root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", `--object-format=${snapshot.objectFormat}`, `--initial-branch=${NAMES.mainBranch}`, remote], directory);
  for (const gitDir of [path.join(root, ".git"), remote]) {
    await writeFile(path.join(gitDir, "objects/info/alternates"), objects + "\n", { flag: "wx" });
    await appendFile(path.join(gitDir, "config"), fixtureConfig(hooks));
  }
  await appendFile(path.join(root, ".git/config"), originConfig(remote, snapshot.refs));
  const local = snapshot.refs.filter(item => !item.symref).map(({ ref, hash }) => ({ ref, hash }));
  const published = snapshot.refs.flatMap(item => item.symref ? [] : item.ref.startsWith("refs/remotes/origin/")
    ? [{ ref: `refs/heads/${item.ref.slice("refs/remotes/origin/".length)}`, hash: item.hash }]
    : item.ref.startsWith("refs/tags/") || item.ref.startsWith("refs/replace/") ? [{ ref: item.ref, hash: item.hash }] : []);
  await writePackedRefs(path.join(root, ".git"), [...local, { ref: `refs/heads/${NAMES.mainBranch}`, hash: snapshot.head }]);
  await writePackedRefs(remote, [...published, { ref: `refs/heads/${NAMES.mainBranch}`, hash: snapshot.head }]);
  for (const item of snapshot.refs.filter(item => item.symref)) {
    assert.ok(snapshot.refs.some(target => target.ref === item.symref), "A source symref target is outside the captured namespace");
    await runGit(["symbolic-ref", item.ref, item.symref], root);
  }
  assert.equal((await runGit(["remote", "get-url", "origin"], root)).trim(), remote, "Only the private receiver may accept pushes");
  assert.equal((await runGit(["remote"], remote)).trim(), "", "The receiver must not have a route back to the source");
  await runGit(["reset", "--hard", NAMES.mainBranch], root);
  const prefix = "gsc-operation-fixture";
  assert.equal((await runGit(["ls-tree", "--name-only", snapshot.head, "--", prefix], root)).trim(), "", "Fixture paths must not replace source content");
  await mkdir(path.join(root, prefix));
  const prCommits: string[] = [];
  await runGit(["switch", "-qc", NAMES.prBranch], root);
  for (let index = 0; index < 3; index++) prCommits.push(await fixtureCommit(root, `${prefix}/pr-${index}.txt`, `PR ${index}`, index));
  const pr = prCommits.at(-1)!;
  const topicParent = await runGit(["rev-parse", "--verify", `${snapshot.head}~8`], root).then(value => value.trim(), () => snapshot.head);
  await runGit(["switch", "-qc", NAMES.topicBranch, topicParent], root);
  await mkdir(path.join(root, prefix), { recursive: true });
  const topic = await fixtureCommit(root, `${prefix}/topic.txt`, "topic", 3);
  const oldHistory = await runGit(["rev-parse", "--verify", `${snapshot.head}~601`], root).then(value => value.trim(), () => snapshot.head);
  await runGit(["branch", NAMES.oldHistoryBranch, oldHistory], root);
  await runGit(["switch", NAMES.mainBranch], root);
  const tree = (await runGit(["rev-parse", `${snapshot.head}^{tree}`], remote)).trim();
  const incoming = await fixtureIncoming(remote, tree, snapshot.head, "incoming remote change");
  const incomingPull = await fixtureIncoming(remote, tree, snapshot.head, "incoming pull change");
  const depth = Number((await runGit(["rev-list", "--count", snapshot.head], root)).trim());
  return { root, remote, main: snapshot.head, incoming, incomingPull, oldHistory, topic, pr, prCommits,
    files: snapshot.tree.entries, depth, branches: snapshot.refs.filter(item => item.ref.startsWith("refs/heads/")).length,
    sharedUpstreamBranches: snapshot.refs.filter(item => item.remote).length, ...NAMES };
}

/** private Git 설정만 추가하며 hook·서명·자동 maintenance·fsmonitor를 비활성화한다. */
function fixtureConfig(hooks: string): string {
  return `\n[user]\n name = Operation Fixture\n email = operations@example.invalid\n[core]\n fsmonitor = false\n autocrlf = false\n hooksPath = ${quoteConfig(hooks)}\n[commit]\n gpgSign = false\n[gc]\n auto = 0\n[maintenance]\n auto = false\n[push]\n default = simple\n`;
}

/** 원본의 URL/자격 증명을 읽거나 복사하지 않고 upstream 이름만 private 원격에 연결한다. */
function originConfig(remote: string, refs: BorrowedRef[]): string {
  const lines = [`\n[remote "origin"]`, ` url = ${quoteConfig(remote)}`, " fetch = +refs/heads/*:refs/remotes/origin/*"];
  for (const item of refs.filter(item => item.ref.startsWith("refs/heads/") && item.remote)) {
    assert.ok(item.remoteRef.startsWith("refs/heads/") && item.upstream === `refs/remotes/origin/${item.remoteRef.slice("refs/heads/".length)}`);
    lines.push(`[branch ${quoteConfig(item.ref.slice("refs/heads/".length))}]`, " remote = origin", ` merge = ${quoteConfig(item.remoteRef)}`);
  }
  return lines.join("\n") + "\n";
}

/** Git config의 문자열 escape만 사용해 경로/브랜치가 설정 줄을 추가하지 못하게 한다. */
function quoteConfig(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`; }

/** 원본의 ref만 private files backend에 복제한다. 원본 object 존재/손상 상태도 임의로 수정하지 않는다. */
async function writePackedRefs(gitDir: string, refs: { ref: string; hash: string }[]): Promise<void> {
  const names = new Set<string>();
  for (const item of refs) { assert.equal(names.has(item.ref), false, "Captured refs must be unique"); names.add(item.ref); }
  refs.sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)));
  await writeFile(path.join(gitDir, "packed-refs"), refs.map(item => `${item.hash} ${item.ref}\n`).join(""), { flag: "wx" });
}

/** 합성 변경 파일 하나만 private index/commit에 기록하며 기존 파일은 stage하지 않는다. */
async function fixtureCommit(root: string, file: string, message: string, index: number): Promise<string> {
  await writeFile(path.join(root, file), message + "\n");
  await runGit(["add", "-f", "--", file], root);
  await runGit(["commit", "--no-verify", "-qm", message], root,
    { env: { GIT_AUTHOR_DATE: `${2000000000 + index} +0000`, GIT_COMMITTER_DATE: `${2000000000 + index} +0000` } });
  return (await runGit(["rev-parse", "HEAD"], root)).trim();
}

/** 원격에만 존재하는 새 이력을 private object dir에 만든다. 원본 object store에 쓰지 않는다. */
async function fixtureIncoming(remote: string, tree: string, parent: string, message: string): Promise<string> {
  return (await runGit(["commit-tree", tree, "-p", parent, "-m", message], remote,
    { env: { GIT_AUTHOR_DATE: "2000000010 +0000", GIT_COMMITTER_DATE: "2000000010 +0000" } })).trim();
}
