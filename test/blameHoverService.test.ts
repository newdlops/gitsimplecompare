import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { blameCommitRemoteUrl, parseBlameCommitInfo, readBlameCommitInfo, readBlameCommitRemoteUrl } from "../src/git/blameHoverService";

for (const format of ["sha1", "sha256"]) {
  test(`real ${format} hover reads full messages, co-authors, root/rename/binary and first-parent merge statistics`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gsc-blame-hover-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    /** 사용자 설정과 hook을 배제한 임시 저장소만 생성한다. 조회 서비스는 실제 Git 결과로 검증한다. */
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
    git(["-c", "init.templateDir=", "init", "--initial-branch=main", `--object-format=${format}`]);
    git(["config", "user.name", "Hover Author"]); git(["config", "user.email", "hover@example.invalid"]);
    await writeFile(path.join(root, "source.ts"), "one\ntwo\nthree\n");
    await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    git(["add", "."]);
    const body = "Explain the complete reason for this change.\n\nKeep <script> as literal commit content.\n\nCo-authored-by: 정지은 <coauthor@example.invalid>\nCo-authored-by: Renamed <COAUTHOR@example.invalid>";
    git(["commit", "-m", "Improve native blame hover", "-m", body]);
    const first = git(["rev-parse", "HEAD"]), info = await readBlameCommitInfo(root, first);
    assert.equal(info.hash, first); assert.equal(first.length, format === "sha1" ? 40 : 64);
    assert.deepEqual(info.parents, []); assert.equal(info.authorName, "Hover Author");
    assert.equal(info.authorEmail, "hover@example.invalid");
    assert.equal(info.message, "Improve native blame hover\n\n" + body);
    assert.deepEqual(info.coAuthors, [{ name: "정지은", email: "coauthor@example.invalid" }]);
    assert.deepEqual(info.stats, { files: 2, insertions: 3, deletions: 0, binaryFiles: 1 });

    const renamed = "renamed\t파일\nsource.ts";
    git(["mv", "source.ts", renamed]);
    await writeFile(path.join(root, "image.bin"), Buffer.from([0, 9, 8, 7]));
    git(["add", "."]); git(["commit", "-m", "Rename and update binary"]);
    const rename = await readBlameCommitInfo(root, git(["rev-parse", "HEAD"]));
    assert.deepEqual(rename.parents, [first]);
    assert.deepEqual(rename.stats, { files: 2, insertions: 0, deletions: 0, binaryFiles: 1 });
    assert.equal(rename.files.find(file => file.status === "R")?.oldPath, "source.ts");
    assert.equal(rename.files.find(file => file.status === "R")?.path, renamed);

    git(["checkout", "-b", "feature"]);
    await writeFile(path.join(root, "feature.txt"), "feature\n");
    git(["add", "."]); git(["commit", "-m", "Feature change"]);
    git(["checkout", "main"]);
    await writeFile(path.join(root, "main.txt"), "main\n");
    git(["add", "."]); git(["commit", "-m", "Main change"]);
    git(["merge", "--no-ff", "feature", "-m", "Merge feature"]);
    const merge = await readBlameCommitInfo(root, git(["rev-parse", "HEAD"]));
    assert.equal(merge.parents.length, 2);
    assert.deepEqual(merge.stats, { files: 1, insertions: 1, deletions: 0, binaryFiles: 0 });
    assert.equal(merge.files[0].path, "feature.txt");
    assert.equal(await readBlameCommitRemoteUrl(root, first), undefined);
    git(["remote", "add", "origin", "git@github.com:owner/repository.git"]);
    assert.equal(await readBlameCommitRemoteUrl(root, first), `https://github.com/owner/repository/commit/${first}`);
  });
}

test("remote commit links preserve provider paths and remove URL credentials", () => {
  const hash = "a".repeat(40);
  assert.equal(blameCommitRemoteUrl("https://user:token@github.com/owner/repo.git", hash), `https://github.com/owner/repo/commit/${hash}`);
  assert.equal(blameCommitRemoteUrl("ssh://git@gitlab.com/group/subgroup/repo.git", hash), `https://gitlab.com/group/subgroup/repo/-/commit/${hash}`);
  assert.equal(blameCommitRemoteUrl("git@bitbucket.org:owner/repo.git", hash), `https://bitbucket.org/owner/repo/commits/${hash}`);
  for (const remote of ["javascript:alert(1)", "file:///private/repo", "https://github.com.example.invalid/owner/repo", "/local/path"]) {
    assert.equal(blameCommitRemoteUrl(remote, hash), undefined);
  }
});

test("missing or mismatched commit headers are rejected rather than shown as another commit", () => {
  assert.throws(() => parseBlameCommitInfo("partial\0", "a".repeat(40)), /Incomplete/);
  assert.throws(() => parseBlameCommitInfo(["b".repeat(40), "", "Author", "author@example.invalid", "2026-10-07", "Body", ""].join("\0"), "a".repeat(40)), /identity/);
});
