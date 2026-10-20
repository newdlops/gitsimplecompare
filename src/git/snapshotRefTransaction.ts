// PR 복구 snapshot과 latest 포인터를 한 Git transaction으로 기록한다.
import { createHash } from "node:crypto";
import { GitError, resolveGitExecutable, runGit, runGitWithInput } from "./gitExec";
import { logInfo } from "../ui/outputLog";

const unsupported = new Map<string, number>();
const MAX_UNSUPPORTED_EXECUTABLES = 32;
const UNSUPPORTED_TTL_MS = 10 * 60_000;

/**
 * immutable snapshot과 그 snapshot을 가리키는 포인터들을 한 번에 기록한다.
 * - 지원 Git에서는 prepare가 모든 ref를 잠근 뒤 commit하므로 lock·검증·hook 거부 때 ref 일부만 갱신하지 않는다.
 * - 구버전의 정확한 미지원 응답만 기존 개별 명령으로 전환한다. 권한·lock·hook 오류는 같은 작업으로 재해석하지 않는다.
 * @param repoRoot 복구 기록을 소유한 저장소 @param snapshotRef 새 immutable snapshot의 전체 ref
 * @param head 검증한 시작 commit OID @param latestRefs 같은 snapshot을 가리킬 latest symbolic ref 목록
 * @param created 이 호출의 snapshot 생성 성공을 알리는 함수. 이후 JSON 기록 실패의 정리 범위를 제한한다.
 * @returns 모든 ref가 기록되면 완료한다. 구버전의 부분 실패도 생성 성공을 알린 뒤 원래 오류를 전파한다.
 */
export async function createSnapshotRefSet(repoRoot: string, snapshotRef: string, head: string,
  latestRefs: readonly string[], created: () => void): Promise<void> {
  assertSnapshotInput(snapshotRef, head, latestRefs);
  const key = executableKey(repoRoot);
  const expires = unsupported.get(key);
  if (expires !== undefined && expires <= Date.now()) unsupported.delete(key);
  if (!unsupported.has(key)) {
    try {
      // latest의 이전 target을 따라가지 않고 포인터 자체를 바꾼다. commit 전의 lock 재시도도 안전하다.
      await runGitWithInput(["update-ref", "--stdin", "--no-deref"], repoRoot,
        ["start", `create ${snapshotRef} ${head}`, ...latestRefs.map(ref => `symref-update ${ref} ${snapshotRef}`), "prepare", "commit", ""].join("\n"),
        { env: { LC_ALL: "C" } });
      created();
      return;
    } catch (error) {
      if (!isUnsupportedSymbolicTransaction(error)) throw error;
      rememberUnsupported(key);
      logInfo("PR snapshot transaction fallback", { repoRoot, reason: "symbolic-ref-transaction-unsupported", pointers: latestRefs.length });
    }
  }
  // 구버전에서도 고유 snapshot을 덮어쓰지 않고, 이 호출이 생성한 경우에만 caller의 정리를 허용한다.
  await runGit(["update-ref", "--no-deref", snapshotRef, head, ""], repoRoot);
  created();
  for (const latestRef of latestRefs) await runGit(["symbolic-ref", latestRef, snapshotRef], repoRoot);
}

/** stdin 명령 경계를 주입할 수 없는 확장 전용 ref와 완전한 OID만 허용한다. */
function assertSnapshotInput(snapshot: string, head: string, latest: readonly string[]): void {
  const refs = [snapshot, ...latest];
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head) || !latest.length || new Set(refs).size !== refs.length ||
    refs.some(ref => !/^refs\/gitsimplecompare\/[a-z0-9/_-]+$/.test(ref))) {
    throw new Error("Invalid private snapshot ref transaction.");
  }
}

/** parser 한 줄의 미지원 응답만 확인한다. 같은 문구를 출력한 hook의 거부를 구버전으로 재해석하지 않는다. */
function isUnsupportedSymbolicTransaction(error: unknown): boolean {
  return error instanceof GitError && error.code === 128 && /^fatal: unknown command: (?:start|symref-update)(?:[ \t][^\r\n]*)?$/.test(error.stderr.trim());
}

/** 실행 파일 선택·PATH·Git 하위 실행 경로를 해시로 구분하고 원본 환경은 캐시에 보관하지 않는다. */
function executableKey(repoRoot: string): string {
  return createHash("sha256").update(JSON.stringify([resolveGitExecutable(repoRoot), process.env.PATH, process.env.GIT_EXEC_PATH])).digest("hex");
}

/** 미지원 증거만 짧고 작은 cache에 보관한다. Git 교체 뒤에도 안전한 구버전 경로를 일시 사용하며 다시 탐지한다. */
function rememberUnsupported(key: string): void {
  unsupported.delete(key);
  unsupported.set(key, Date.now() + UNSUPPORTED_TTL_MS);
  while (unsupported.size > MAX_UNSUPPORTED_EXECUTABLES) unsupported.delete(unsupported.keys().next().value!);
}
