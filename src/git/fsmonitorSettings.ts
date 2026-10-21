// 감시자 실행·IPC와 분리해 builtin/hook 설정만 짧게 공유한다. 쓰기 전에는 daemon을 시작하지 않는다.
import { GitError, runGit, type RunGitOptions } from "./gitExec";

interface Setting { value: boolean | undefined; expires: number }

/** 동일 실행 문맥의 설정 조회만 공유하며 실패/세션 종료가 늦은 캐시를 게시하지 못하게 한다. */
export class FsmonitorSettings {
  private generation = 0;
  private readonly values = new Map<string, Setting>();
  private readonly pending = new Map<string, Promise<boolean | undefined>>();
  private readonly controllers = new Set<AbortController>();

  /**
   * daemon 소켓에 연결하지 않고 현재 명령 문맥의 fsmonitor 설정을 읽는다.
   * @param key 저장소·실행 파일·설정 문맥의 해시 key @param root Git 실행 cwd
   * @param options 실행 파일과 명령 환경 @param globals 같은 설정을 적용할 원래 전역 옵션
   * @returns true=builtin, false=비활성/설정 조회 실패, undefined=사용자 hook이므로 원래 설정을 유지한다.
   */
  read(key: string, root: string, options: RunGitOptions, globals: readonly string[]): Promise<boolean | undefined> {
    const cached = this.values.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const current = this.generation, controller = new AbortController(); this.controllers.add(controller);
    let query!: Promise<boolean | undefined>;
    query = this.query(root, options, globals, controller.signal).then(value => {
      if (current === this.generation && !controller.signal.aborted) {
        this.values.delete(key); this.values.set(key, { value, expires: Date.now() + 5000 });
        // 전용 임시 worktree가 반복 생성돼도 완료한 설정만 보관하며 daemon 소유권은 이 캐시에 넣지 않는다.
        while (this.values.size > 512) this.values.delete(this.values.keys().next().value!);
      }
      return value;
    }).finally(() => {
      this.controllers.delete(controller);
      if (this.pending.get(key) === query) this.pending.delete(key);
    });
    this.pending.set(key, query); return query;
  }

  /** 세션 종료 때 소유 조회를 취소하고 이전 세대의 완료 결과가 재사용되지 않게 한다. */
  clear(): void {
    this.generation++; for (const controller of this.controllers) controller.abort();
    this.values.clear(); this.pending.clear();
  }

  /** Native boolean 판정으로 hook 경로를 구분하며 설정을 쓰거나 daemon 상태를 조회하지 않는다. */
  private async query(root: string, options: RunGitOptions, globals: readonly string[], signal: AbortSignal): Promise<boolean | undefined> {
    try {
      const value = await runGit([...globals, "config", "--bool", "--get", "core.fsmonitor"], root,
        { executable: options.executable, env: options.env, signal, readTimeoutMs: 2000, retryOnLock: false });
      return value.trim() === "true";
    } catch (error) {
      if (error instanceof GitError && /bad boolean config value|bad config value/i.test(error.stderr)) return undefined;
      return false;
    }
  }
}
