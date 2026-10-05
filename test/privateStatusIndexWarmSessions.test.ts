import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit } from "../src/git/gitExec";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { StatusIndexWarmCache } from "../src/git/statusIndexWarmCache";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";

/** キャ시를 작업트리 밖에 두는 실제 Git 저장소를 생성한다. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-warm-session-test-"));
  const root = path.join(directory, "repo"), storage = path.join(directory, "storage"); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runGit(["init", "-q"], root);
  await runGit(["config", "user.name", "Fixture"], root); await runGit(["config", "user.email", "fixture@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await mkdir(path.join(root, "included")); await mkdir(path.join(root, "excluded"));
  await writeFile(path.join(root, "included/a.txt"), "initial\n"); await writeFile(path.join(root, "excluded/b.txt"), "initial\n");
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "initial"], root);
  return { directory, root, storage };
}

/** 실제 index의 바이트와 교체·갱신 metadata를 함께 검사한다. */
async function indexIdentity(root: string) {
  const file = path.resolve(root, (await runGit(["rev-parse", "--git-path", "index"], root)).trim());
  const info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

/** 경로 순서를 정규화하되 rename·status 등 Git의 모든 변경 필드를 보존한다. */
function sorted(snapshot: WorkingTreeSnapshot) {
  return { staged: [...snapshot.groups.staged].sort((a, b) => a.path.localeCompare(b.path)), unstaged: [...snapshot.groups.unstaged].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** 캐시를 우회한 Git의 전체 출력과 실제 index 보존을 한 번에 대조한다. */
async function checkFresh(index: PrivateStatusIndex, root: string) {
  const before = await indexIdentity(root);
  const actual = await index.read(AbortSignal.timeout(60000));
  const raw = await runGit(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"], root, { env: { GIT_OPTIONAL_LOCKS: "0" } });
  assert.deepEqual(sorted(actual), sorted(workingTreeSnapshot(root, parseWorkingTreeV2(raw))));
  assert.deepEqual(await indexIdentity(root), before);
  return actual;
}

/** 조회를 마친 세션의 모든 private 사본이 dispose 후 제거되는지 기록한다. */
class RecordingCache extends StatusIndexWarmCache {
  readonly sessionIndexes: string[] = [];
  /** Git이 close한 private 경로를 기록하고 실제 원자적 저장을 그대로 수행한다. */
  override async store(root: string, sourceKey: string, index: string): Promise<boolean> {
    this.sessionIndexes.push(index); return super.store(root, sourceKey, index);
  }
}

test("new hosts reuse the index while edits, ignored paths, untracked files and staged renames stay fresh", async t => {
  const f = await fixture(t), events: string[] = [];
  const cache = new StatusIndexWarmCache(f.storage, event => events.push(event));
  let index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); } finally { await index.dispose(); }
  await writeFile(path.join(f.root, "included/a.txt"), "changed\n");
  await mkdir(path.join(f.root, "new dir/deep"), { recursive: true }); await writeFile(path.join(f.root, "new dir/deep/file.txt"), "new\n");
  await writeFile(path.join(f.root, ".gitignore"), "ignored/\n"); await mkdir(path.join(f.root, "ignored")); await writeFile(path.join(f.root, "ignored/a.txt"), "ignored\n");
  index = new PrivateStatusIndex(f.root, () => undefined, new StatusIndexWarmCache(f.storage, event => events.push(event)));
  try {
    const fresh = await checkFresh(index, f.root);
    assert.ok(events.includes("private status index cache restored"));
    assert.ok(fresh.groups.unstaged.some(change => change.path === "new dir/deep/file.txt"));
    assert.equal(fresh.groups.unstaged.some(change => change.path.startsWith("ignored/")), false);
  } finally { await index.dispose(); }
  await rename(path.join(f.root, "included/a.txt"), path.join(f.root, "included/renamed.txt")); await runGit(["add", "-A"], f.root);
  events.length = 0; index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try {
    const staged = await checkFresh(index, f.root);
    assert.ok(staged.groups.staged.length > 0);
    assert.equal(events.includes("private status index cache restored"), false, "real staging must invalidate the previous source identity");
  } finally { await index.dispose(); }
});

for (const format of ["split", "sparse", "linked"] as const) {
  test(`warm restart preserves complete output and the actual ${format} index`, async t => {
    const f = await fixture(t); let root = f.root;
    if (format === "split") await runGit(["update-index", "--split-index"], root);
    if (format === "sparse") {
      await runGit(["sparse-checkout", "init", "--cone", "--sparse-index"], root);
      await runGit(["sparse-checkout", "set", "included"], root);
    }
    if (format === "linked") {
      const linked = path.join(f.directory, "linked"); await runGit(["worktree", "add", "-b", "linked-test", linked], root); root = linked;
    }
    const events: string[] = [], cache = new StatusIndexWarmCache(f.storage, event => events.push(event));
    for (let round = 0; round < 3; round++) {
      await writeFile(path.join(root, "included/a.txt"), `${round} change\n`);
      await mkdir(path.join(root, "new/deep"), { recursive: true }); await writeFile(path.join(root, `new/deep/${round}.txt`), "new\n");
      const index = new PrivateStatusIndex(root, () => undefined, cache);
      try { await checkFresh(index, root); } finally { await index.dispose(); }
    }
    assert.equal(events.filter(event => event === "private status index cache restored").length, format === "linked" ? 2 : 0);
  });
}

test("a warm index detects a same-size racy edit with trustctime disabled", async t => {
  const f = await fixture(t); await runGit(["config", "core.trustctime", "false"], f.root);
  const file = path.join(f.root, "included/a.txt"), realIndex = path.join(f.root, ".git/index");
  const at = Math.floor(Date.now() / 1000); await utimes(file, at, at); await utimes(realIndex, at, at);
  const cache = new StatusIndexWarmCache(f.storage);
  let index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); } finally { await index.dispose(); }
  // 늦은 세션에서 저장한 mtime을 재현해 검사 속도와 관계없이 racy-clean 회귀를 검출한다.
  const fileCache = path.join(f.storage, (await readdir(f.storage))[0]);
  const data = await readFile(fileCache), length = data.readUInt32BE(0), header = JSON.parse(data.subarray(4, 4 + length).toString());
  header.mtimeMs = (at + 10) * 1000;
  const encoded = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
  await writeFile(fileCache, Buffer.concat([prefix, encoded, data.subarray(4 + length)]));
  await writeFile(file, "changed\n"); await utimes(file, at, at);
  index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try {
    const actual = await checkFresh(index, f.root);
    assert.ok(actual.groups.unstaged.some(change => change.path === "included/a.txt"));
  } finally { await index.dispose(); }
});

test("metadata-only index refresh retains the warmed directory cache and fresh status", async t => {
  const f = await fixture(t), events: string[] = [];
  const cache = new StatusIndexWarmCache(f.storage, event => events.push(event));
  let index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); } finally { await index.dispose(); }
  const before = await indexIdentity(f.root);
  const touched = new Date(Date.now() + 10000); await utimes(path.join(f.root, "included/a.txt"), touched, touched);
  await runGit(["update-index", "--refresh"], f.root);
  assert.notDeepEqual(await indexIdentity(f.root), before, "ordinary stat refresh must really replace the source identity");
  events.length = 0; index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try {
    await checkFresh(index, f.root);
    assert.ok(events.includes("private status index cache restored"), "unchanged stage entries must keep the warmed directory cache");
  } finally { await index.dispose(); }
});

test("legacy warmed indexes migrate only within the same Git index path and staging meaning", async t => {
  const f = await fixture(t), events: string[] = [], cache = new StatusIndexWarmCache(f.storage, event => events.push(event));
  let index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); } finally { await index.dispose(); }
  const source = path.join(f.root, ".git/index"), info = await stat(source);
  const suffix = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${createHash("sha256").update(await readFile(source)).digest("hex")}`;
  const file = path.join(f.storage, (await readdir(f.storage))[0]);
  /** 이전 릴리스의 exact header만 재현하며 Git이 만든 payload와 checksum은 보존한다. */
  const legacy = async (sourcePath: string) => {
    const data = await readFile(file), size = data.readUInt32BE(0), header = JSON.parse(data.subarray(4, 4 + size).toString());
    header.sourceKey = `${sourcePath}:${suffix}`;
    const encoded = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
    await writeFile(file, Buffer.concat([prefix, encoded, data.subarray(4 + size)]));
  };
  await legacy(source); events.length = 0; index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); assert.ok(events.includes("private status index cache restored")); }
  finally { await index.dispose(); }
  await legacy(path.join(f.directory, "different/.git/index")); events.length = 0;
  index = new PrivateStatusIndex(f.root, () => undefined, cache);
  try { await checkFresh(index, f.root); assert.equal(events.includes("private status index cache restored"), false); }
  finally { await index.dispose(); }
});

test("forty dispose and reopen cycles retain one cache and no private files or running reads", async t => {
  const f = await fixture(t), events: string[] = [], cache = new RecordingCache(f.storage, event => events.push(event));
  const before = await indexIdentity(f.root);
  for (let round = 0; round < 40; round++) {
    const index = new PrivateStatusIndex(f.root, () => undefined, cache);
    try { await index.read(AbortSignal.timeout(60000)); } finally { await index.dispose(); }
    assert.equal(gitProcesses.isBusy(f.root), false);
    await assert.rejects(lstat(path.dirname(cache.sessionIndexes.at(-1)!)), { code: "ENOENT" });
  }
  assert.equal(events.filter(event => event === "private status index cache restored").length, 39);
  assert.equal((await readdir(f.storage)).length, 1);
  assert.deepEqual(await indexIdentity(f.root), before);
});
