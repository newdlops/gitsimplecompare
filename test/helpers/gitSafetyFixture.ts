import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runGit } from "../../src/git/gitExec";

/** 임시 저장소의 Git 출력만 trim해 반환한다. 실제 사용자 저장소는 호출하지 않는다. */
export async function git(root: string, ...args: string[]): Promise<string> {
  return (await runGit(args, root)).trim();
}

/**
 * 훅·서명·Git 사용자 설정을 격리한 저장소를 만들고 테스트 종료 시 정리한다.
 * @param t 임시 디렉터리 정리를 등록할 테스트 컨텍스트
 * @param label 실패 기록에서 저장소를 구분할 접두어
 * @returns 기본 파일 한 개를 커밋한 main 저장소와 외부 테스트용 부모 경로
 */
export async function safetyFixture(t: TestContext, label: string) {
  const directory = await mkdtemp(join(tmpdir(), `gsc-${label}-`));
  const root = join(directory, "repo");
  await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  for (const [key, value] of Object.entries({
    "user.name": "Git Safety Test",
    "user.email": "git-safety@example.test",
    "commit.gpgsign": "false",
    "tag.gpgsign": "false",
    "core.hooksPath": join(directory, "hooks"),
    "core.fsmonitor": "false",
    "core.autocrlf": "false",
    "push.default": "simple",
    "pull.rebase": "false",
    "pull.ff": "true",
  })) await git(root, "config", key, value);
  await mkdir(join(directory, "hooks"));
  const head = await commitText(root, "base\n", "base");
  return { directory, root, head };
}

/** 임시 저장소의 tracked.txt를 지정 내용으로 커밋하고 그 OID를 반환한다. */
export async function commitText(root: string, content: string, message: string): Promise<string> {
  await writeFile(join(root, "tracked.txt"), content);
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

/** 로컬 bare origin을 연결한다. 빈 원격 또는 main이 게시된 원격을 선택할 수 있다. */
export async function addOrigin(root: string, directory: string, publish = true): Promise<string> {
  const remote = join(directory, "origin.git");
  await git(directory, "init", "--bare", "-q", remote);
  await git(root, "remote", "add", "origin", remote);
  if (publish) await git(root, "push", "-qu", "origin", "main");
  return remote;
}
