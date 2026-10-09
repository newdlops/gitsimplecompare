// 본 확장의 SCM 명령을 실제 VS Code Host에서 호출해 큰 push의 전송/알림을 검증한다.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import * as vscode from "vscode";
import { runGit } from "../../src/git/gitExec";
import { SEQUENTIAL_PUSH_THRESHOLD_BYTES } from "../../src/git/sequentialPush";

/** 격리된 smoke 저장소에서만 Git을 실행한다. 사용자의 실제 저장소/remote는 호출하지 않는다. */
async function git(root: string, ...args: string[]): Promise<string> { return (await runGit(args, root)).trim(); }
/** shell hook 안에 임시 경로를 안전하게 삽입한다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/**
 * 기본 Git이 꺼진 profile에서 production Push 명령이 자동 분할하는지 검증한다.
 * 캡처 모드에서는 첫 전송 hook을 최대 60초, 수동 취소 검증 모드에서는 최대 180초 기다린다.
 */
export async function run(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE!;
  assert.ok(root && vscode.workspace.workspaceFolders?.[0].uri.fsPath === root);
  const settingsFile = join(root, ".vscode/settings.json");
  const settings = await readFile(settingsFile, "utf8");
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare");
  assert.ok(extension, "production extension must be installed in the isolated Development Host");
  await extension.activate();
  assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), false);
  const directory = dirname(root), remote = join(directory, "push-origin.git"), received = join(directory, "push-received.log");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-q");
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-qu", "origin", "main");
  const originalHead = await git(remote, "rev-parse", "main");
  await writeFile(join(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> ${quote(received)}\n`, { mode: 0o755 });
  await writeFile(join(root, "large.bin"), Buffer.alloc(SEQUENTIAL_PUSH_THRESHOLD_BYTES, 0x61));
  await git(root, "add", "large.bin");
  await git(root, "commit", "-qm", "large push fixture");
  const commits = [await git(root, "rev-parse", "HEAD")];
  for (let index = 0; index < 2; index++) {
    await git(root, "commit", "--allow-empty", "-qm", `next push ${index}`);
    commits.push(await git(root, "rev-parse", "HEAD"));
  }
  const status = await git(root, "status", "--porcelain");
  if (process.env.GSC_PUSH_UI_CAPTURE) {
    const ready = join(directory, "push-ui-ready"), release = join(directory, "push-ui-release");
    const seconds = process.env.GSC_PUSH_UI_CAPTURE === "cancel" ? 180 : 60;
    await writeFile(join(directory, "hooks/pre-push"), `#!/bin/sh\nif [ ! -f ${quote(ready)} ]; then\ntouch ${quote(ready)}\ni=0\nwhile [ ! -f ${quote(release)} ] && [ "$i" -lt ${seconds} ]; do sleep 1; i=$((i+1)); done\nfi\n`, { mode: 0o755 });
    console.log(`Push notification capture gate: ${directory}`);
  }
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
  await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason: "pushSmoke" });
  await vscode.commands.executeCommand("gitSimpleCompare.scmAction", "git.push");
  if (process.env.GSC_PUSH_UI_CAPTURE === "cancel") {
    assert.equal(await git(remote, "rev-parse", "main"), originalHead);
    assert.equal(await readFile(received, "utf8").catch(() => ""), "");
    await writeFile(join(directory, "push-ui-release"), "cancel inspected\n");
    await writeFile(join(directory, "hooks/pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    console.log("PASS: native Cancel stopped the production push before the first remote update; retrying.");
    await vscode.commands.executeCommand("gitSimpleCompare.scmAction", "git.push");
  }
  const updates = (await readFile(received, "utf8")).trim().split(/\r?\n/).map(line => line.split(" ")[1]);
  assert.deepEqual(updates, commits);
  assert.equal(await git(remote, "rev-parse", "main"), commits.at(-1));
  assert.equal(await git(root, "status", "--porcelain"), status);
  assert.equal(await readFile(settingsFile, "utf8"), settings);
  assert.equal(vscode.workspace.getConfiguration("git").get("enabled"), false);
  console.log("PASS: production SCM command pushed 50MiB in three sequential updates; worktree and native Git settings preserved.");
}
